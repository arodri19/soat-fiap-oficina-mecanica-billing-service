const crypto = require('node:crypto');
const { Budget } = require('../domain/Budget');
const { Payment, PaymentStatus } = require('../domain/Payment');
const { ValidationError } = require('../domain/errors');
const { Commands, Replies, createReply } = require('./contracts');

// Status do Mercado Pago (GET /v1/payments/{id}) que encerram a cobrança
const PROVIDER_APPROVED = ['approved'];
const PROVIDER_FAILED = ['rejected', 'cancelled'];

/**
 * Participante da saga: executa os comandos do orquestrador (os-service) e
 * responde na fila de respostas. Também converte as notificações do Mercado Pago
 * (webhook) em eventos PaymentConfirmed/PaymentFailed para a saga.
 *
 * Idempotência: todo handler pode ser executado mais de uma vez para o mesmo
 * comando (SQS at-least-once) e produz o mesmo efeito/resposta.
 */
class BillingService {
  constructor({ repository, gateway, messageBus, defaultReplyQueue, monitoring, tracing, logger, clock, idGenerator }) {
    this.repository = repository;
    this.gateway = gateway;
    this.messageBus = messageBus;
    this.defaultReplyQueue = defaultReplyQueue;
    this.monitoring = monitoring;
    this.tracing = tracing;
    this.logger = logger;
    this.clock = clock || (() => new Date());
    this.idGenerator = idGenerator || (() => crypto.randomUUID());

    this.handlers = {
      [Commands.CREATE_BUDGET]: this.createBudget.bind(this),
      [Commands.REQUEST_PAYMENT]: this.requestPayment.bind(this),
      [Commands.CANCEL_BUDGET]: this.cancelBudget.bind(this),
      [Commands.REFUND_PAYMENT]: this.refundPayment.bind(this)
    };
  }

  async handleCommand(command) {
    const handler = this.handlers[command.type];
    if (!handler) {
      this.logger.warn({ type: command.type }, 'Comando desconhecido — ignorado');
      return { outcome: 'UNHANDLED_TYPE' };
    }
    return handler(command);
  }

  // ── CreateBudget ────────────────────────────────────────────────────────────
  async createBudget(command) {
    const { orderId, sagaId } = command;
    const existing = await this.repository.getBudget(orderId);
    if (existing) {
      // Reentrega: responde de novo com o mesmo orçamento
      return this.#reply(command, Replies.BUDGET_CREATED, budgetPayload(existing));
    }

    let budget;
    try {
      budget = Budget.create({
        budgetId: this.idGenerator(),
        orderId,
        sagaId,
        externalId: command.payload.externalId,
        replyTo: command.replyTo,
        customer: command.payload.customer,
        items: command.payload.items,
        now: this.clock()
      });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return this.#reply(command, Replies.BUDGET_CREATION_FAILED, { reason: error.message });
    }

    const created = await this.repository.createBudget(budget);
    const stored = created ? budget : await this.repository.getBudget(orderId);
    this.monitoring.recordBillingEvent('BudgetStatusChanged', { orderId, budgetId: stored.budgetId, status: stored.status, total: stored.total });
    return this.#reply(command, Replies.BUDGET_CREATED, budgetPayload(stored));
  }

  // ── RequestPayment (cliente aprovou o orçamento) ────────────────────────────
  async requestPayment(command) {
    const { orderId } = command;
    const budget = await this.repository.getBudget(orderId);
    if (!budget) return this.#reply(command, Replies.PAYMENT_REQUEST_FAILED, { reason: 'Orçamento não encontrado' });
    if (budget.isCancelled()) return this.#reply(command, Replies.PAYMENT_REQUEST_FAILED, { reason: 'Orçamento cancelado' });

    const payments = await this.repository.listPayments(orderId);
    const open = payments.find((p) => [PaymentStatus.PENDING, PaymentStatus.APPROVED].includes(p.status));
    if (open) {
      return this.#reply(command, Replies.PAYMENT_REQUESTED, paymentPayload(open));
    }

    const paymentId = this.idGenerator();
    let checkout;
    try {
      checkout = await this.gateway.createCheckout({ paymentId, budget, payer: command.payload.payer || budget.customer });
    } catch (error) {
      if (error.retryable) throw error; // volta para a fila (SQS reentrega)
      return this.#reply(command, Replies.PAYMENT_REQUEST_FAILED, { reason: error.message });
    }

    const payment = Payment.create({
      paymentId,
      orderId,
      budgetId: budget.budgetId,
      amount: budget.total,
      provider: this.gateway.name,
      preferenceId: checkout.preferenceId,
      checkoutUrl: checkout.checkoutUrl,
      now: this.clock()
    });
    if (budget.isPendingApproval()) budget.approve(this.clock());

    await this.repository.createPayment(payment);
    await this.repository.saveBudget(budget);
    this.monitoring.recordBillingEvent('PaymentStatusChanged', { orderId, paymentId, status: payment.status, amount: payment.amount });
    return this.#reply(command, Replies.PAYMENT_REQUESTED, paymentPayload(payment));
  }

  // ── CancelBudget (compensação) ──────────────────────────────────────────────
  async cancelBudget(command) {
    const { orderId } = command;
    const reason = command.payload.reason || 'Compensação da saga';
    const budget = await this.repository.getBudget(orderId);

    if (budget) {
      for (const payment of await this.repository.listPayments(orderId)) {
        if (payment.isPending()) {
          payment.markCancelled(reason, this.clock());
          await this.repository.savePayment(payment);
        }
      }
      if (budget.cancel(reason, this.clock())) {
        await this.repository.saveBudget(budget);
        this.monitoring.recordBillingEvent('BudgetStatusChanged', { orderId, budgetId: budget.budgetId, status: budget.status });
      }
    }
    // Sem orçamento não há o que desfazer — confirma mesmo assim para a saga concluir.
    return this.#reply(command, Replies.BUDGET_CANCELLED, { budgetId: budget?.budgetId || null });
  }

  // ── RefundPayment (compensação após pagamento confirmado) ───────────────────
  async refundPayment(command) {
    const { orderId } = command;
    const reason = command.payload.reason || 'Compensação da saga';
    const payments = await this.repository.listPayments(orderId);
    const budget = await this.repository.getBudget(orderId);

    const alreadyRefunded = payments.find((p) => p.status === PaymentStatus.REFUNDED);
    const toRefund = payments.find((p) => p.isApproved() || p.status === PaymentStatus.REFUND_FAILED);

    if (!toRefund) {
      await this.#cancelBudgetIfNeeded(budget, reason);
      return alreadyRefunded
        ? this.#reply(command, Replies.PAYMENT_REFUNDED, { paymentId: alreadyRefunded.paymentId })
        : this.#reply(command, Replies.PAYMENT_REFUND_FAILED, { reason: 'Nenhum pagamento aprovado para estornar' });
    }

    try {
      await this.gateway.refund(toRefund.providerPaymentId, { idempotencyKey: `refund-${toRefund.paymentId}` });
    } catch (error) {
      if (error.retryable) throw error;
      if (toRefund.status !== PaymentStatus.REFUND_FAILED) {
        toRefund.markRefundFailed(error.message, this.clock());
        await this.repository.savePayment(toRefund);
      }
      this.monitoring.recordBillingEvent('PaymentStatusChanged', { orderId, paymentId: toRefund.paymentId, status: toRefund.status });
      return this.#reply(command, Replies.PAYMENT_REFUND_FAILED, { paymentId: toRefund.paymentId, reason: error.message });
    }

    toRefund.markRefunded(this.clock());
    await this.repository.savePayment(toRefund);
    await this.#cancelBudgetIfNeeded(budget, reason);
    this.monitoring.recordBillingEvent('PaymentStatusChanged', { orderId, paymentId: toRefund.paymentId, status: toRefund.status, amount: toRefund.amount });
    return this.#reply(command, Replies.PAYMENT_REFUNDED, { paymentId: toRefund.paymentId, amount: toRefund.amount });
  }

  // ── Notificação de pagamento (webhook Mercado Pago ou simulação) ────────────
  async processPaymentNotification(providerPaymentId) {
    const remote = await this.gateway.getPayment(providerPaymentId);
    const reference = Payment.parseExternalReference(remote.externalReference);
    if (!reference) {
      this.logger.warn({ providerPaymentId, externalReference: remote.externalReference }, 'Pagamento sem external_reference reconhecida');
      return { outcome: 'UNKNOWN_REFERENCE' };
    }

    const payment = await this.repository.getPayment(reference.orderId, reference.paymentId);
    const budget = await this.repository.getBudget(reference.orderId);
    if (!payment || !budget) return { outcome: 'UNKNOWN_PAYMENT' };

    if (PROVIDER_APPROVED.includes(remote.status)) {
      return this.#onApproved(payment, budget, remote);
    }
    if (PROVIDER_FAILED.includes(remote.status)) {
      return this.#onFailed(payment, budget, remote);
    }
    // pending / in_process / authorized: aguarda a próxima notificação
    return { outcome: 'IGNORED_STATUS', status: remote.status };
  }

  async #onApproved(payment, budget, remote) {
    if (!payment.isPending()) {
      return { outcome: 'ALREADY_PROCESSED', status: payment.status };
    }

    // Pago DEPOIS que a saga já compensou (cliente pagou um link antigo após
    // recusa/timeout): o dinheiro não pode ficar retido — estorno automático.
    if (budget.isCancelled()) {
      payment.markApproved(remote.id, this.clock());
      await this.gateway.refund(remote.id, { idempotencyKey: `refund-${payment.paymentId}` });
      payment.markRefunded(this.clock());
      await this.repository.savePayment(payment);
      this.monitoring.recordBillingEvent('PaymentStatusChanged', { orderId: payment.orderId, paymentId: payment.paymentId, status: 'AUTO_REFUNDED' });
      return { outcome: 'AUTO_REFUNDED' };
    }

    payment.markApproved(remote.id, this.clock());
    await this.repository.savePayment(payment);
    this.monitoring.recordBillingEvent('PaymentStatusChanged', { orderId: payment.orderId, paymentId: payment.paymentId, status: payment.status, amount: payment.amount });
    await this.#publishEvent(budget, Replies.PAYMENT_CONFIRMED, {
      paymentId: payment.paymentId,
      providerPaymentId: remote.id,
      amount: payment.amount
    });
    return { outcome: 'CONFIRMED' };
  }

  async #onFailed(payment, budget, remote) {
    if (!payment.isPending()) return { outcome: 'ALREADY_PROCESSED', status: payment.status };
    payment.markRejected(remote.id, remote.statusDetail || remote.status, this.clock());
    await this.repository.savePayment(payment);
    this.monitoring.recordBillingEvent('PaymentStatusChanged', { orderId: payment.orderId, paymentId: payment.paymentId, status: payment.status });
    await this.#publishEvent(budget, Replies.PAYMENT_FAILED, {
      paymentId: payment.paymentId,
      providerStatus: remote.status,
      reason: remote.statusDetail || remote.status
    });
    return { outcome: 'FAILED' };
  }

  // ── Polling: reconcilia cobranças pendentes consultando o Mercado Pago ──────
  // Alternativa ao webhook quando não há URL pública https (ambiente de estudo,
  // infraestrutura que liga/desliga). O que encontrar segue o MESMO fluxo do
  // webhook — se os dois existirem, o segundo a chegar vira ALREADY_PROCESSED.
  async reconcilePendingPayments() {
    const summary = { checked: 0, confirmed: 0, failed: 0, errors: 0 };
    for (const payment of await this.repository.listPendingPayments()) {
      summary.checked += 1;
      try {
        const reference = Payment.externalReference(payment.orderId, payment.paymentId);
        const found = await this.gateway.searchPaymentsByReference(reference);
        const decisive = found.find((p) => PROVIDER_APPROVED.includes(p.status))
          || found.find((p) => PROVIDER_FAILED.includes(p.status));
        if (!decisive) continue;

        const { outcome } = await this.processPaymentNotification(decisive.id);
        if (outcome === 'CONFIRMED' || outcome === 'AUTO_REFUNDED') summary.confirmed += 1;
        if (outcome === 'FAILED') summary.failed += 1;
      } catch (error) {
        summary.errors += 1;
        this.logger.warn({ err: error, orderId: payment.orderId, paymentId: payment.paymentId }, 'Falha ao reconciliar cobrança — nova tentativa no próximo ciclo');
      }
    }
    return summary;
  }

  // ── Consultas ───────────────────────────────────────────────────────────────
  async getOrderBilling(orderId) {
    const { budget, payments } = await this.repository.getOrderBilling(orderId);
    if (!budget) return null;
    const current = [...payments].reverse()[0] || null;
    return { budget: { ...budget }, payment: current ? { ...current } : null, payments: payments.map((p) => ({ ...p })) };
  }

  async listBudgets({ status } = {}) {
    return (await this.repository.listBudgets({ status })).map((b) => ({ ...b }));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  async #cancelBudgetIfNeeded(budget, reason) {
    if (budget?.cancel(reason, this.clock())) {
      await this.repository.saveBudget(budget);
    }
  }

  async #reply(command, type, payload) {
    const reply = createReply({
      type,
      sagaId: command.sagaId,
      orderId: command.orderId,
      correlationId: command.correlationId,
      payload,
      traceHeaders: this.tracing.currentTraceHeaders()
    });
    await this.messageBus.publish(command.replyTo || this.defaultReplyQueue, reply);
    return { outcome: type };
  }

  async #publishEvent(budget, type, payload) {
    const event = createReply({
      type,
      sagaId: budget.sagaId,
      orderId: budget.orderId,
      payload,
      traceHeaders: this.tracing.currentTraceHeaders()
    });
    await this.messageBus.publish(budget.replyTo || this.defaultReplyQueue, event);
  }
}

function budgetPayload(budget) {
  return { budgetId: budget.budgetId, total: budget.total, status: budget.status };
}

function paymentPayload(payment) {
  return { paymentId: payment.paymentId, checkoutUrl: payment.checkoutUrl, amount: payment.amount, status: payment.status };
}

module.exports = { BillingService };
