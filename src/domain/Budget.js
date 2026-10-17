const { ValidationError, InvalidTransitionError } = require('./errors');

const BudgetStatus = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  CANCELLED: 'CANCELLED'
});

const ITEM_TYPES = ['SERVICE', 'PART'];

const round2 = (value) => Math.round(value * 100) / 100;

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('O orçamento precisa de ao menos um item.');
  }
  return items.map((item, i) => {
    if (!ITEM_TYPES.includes(item.type)) throw new ValidationError(`items[${i}].type inválido: ${item.type}`);
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    if (!Number.isInteger(quantity) || quantity < 1) throw new ValidationError(`items[${i}].quantity deve ser inteiro >= 1`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new ValidationError(`items[${i}].unitPrice deve ser >= 0`);
    return {
      type: item.type,
      referenceId: item.referenceId,
      description: item.description || `${item.type} ${item.referenceId}`,
      quantity,
      unitPrice: round2(unitPrice),
      total: round2(quantity * unitPrice)
    };
  });
}

/**
 * Orçamento de uma OS. Um por ordem de serviço (chave = orderId), criado a partir
 * dos itens e preços enviados pelo os-service no comando CreateBudget.
 *   PENDING_APPROVAL ─(cliente aprova/RequestPayment)─► APPROVED
 *   qualquer estado ─(compensação CancelBudget/RefundPayment)─► CANCELLED
 */
class Budget {
  constructor(props) {
    Object.assign(this, {
      history: [],
      version: 0,
      ...props
    });
  }

  static create({ budgetId, orderId, sagaId, externalId, replyTo, customer, items, now = new Date() }) {
    if (!Number.isInteger(Number(orderId))) throw new ValidationError('orderId inválido.');
    const normalized = validateItems(items);
    const total = round2(normalized.reduce((sum, item) => sum + item.total, 0));
    if (total <= 0) throw new ValidationError('O total do orçamento deve ser maior que zero.');

    const at = now.toISOString();
    return new Budget({
      budgetId,
      orderId: Number(orderId),
      sagaId,
      externalId: externalId || null,
      replyTo: replyTo || null,
      customer: customer || null,
      items: normalized,
      total,
      status: BudgetStatus.PENDING_APPROVAL,
      cancelReason: null,
      createdAt: at,
      updatedAt: at,
      history: [{ status: BudgetStatus.PENDING_APPROVAL, at }]
    });
  }

  #transition(status, now, note) {
    const at = (now || new Date()).toISOString();
    this.status = status;
    this.updatedAt = at;
    this.history = [...this.history, { status, at, ...(note ? { note } : {}) }];
  }

  approve(now) {
    if (this.status !== BudgetStatus.PENDING_APPROVAL) {
      throw new InvalidTransitionError(`Orçamento ${this.budgetId} não pode ser aprovado (status ${this.status}).`);
    }
    this.#transition(BudgetStatus.APPROVED, now);
  }

  // Idempotente: cancelar um orçamento já cancelado não é erro (compensações
  // podem ser reentregues pelo SQS).
  cancel(reason, now) {
    if (this.isCancelled()) return false;
    this.cancelReason = reason || null;
    this.#transition(BudgetStatus.CANCELLED, now, reason);
    return true;
  }

  isCancelled() {
    return this.status === BudgetStatus.CANCELLED;
  }

  isPendingApproval() {
    return this.status === BudgetStatus.PENDING_APPROVAL;
  }
}

module.exports = { Budget, BudgetStatus };
