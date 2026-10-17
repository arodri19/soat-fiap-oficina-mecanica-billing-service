const { BillingService } = require('../../src/application/BillingService');
const { Budget } = require('../../src/domain/Budget');
const FakePaymentGateway = require('../../src/infrastructure/payments/FakePaymentGateway');
const { PaymentGatewayError } = require('../../src/infrastructure/payments/MercadoPagoGateway');
const {
  InMemoryBillingRepository, RecordingBus, silentLogger, fakeTracing, fakeMonitoring, command, ITEMS
} = require('../support/inMemory');

function setup({ gateway } = {}) {
  const repository = new InMemoryBillingRepository();
  const bus = new RecordingBus();
  const monitoring = fakeMonitoring();
  let seq = 0;
  const service = new BillingService({
    repository,
    gateway: gateway || new FakePaymentGateway(),
    messageBus: bus,
    defaultReplyQueue: 'default-replies',
    monitoring,
    tracing: fakeTracing,
    logger: silentLogger,
    clock: () => new Date('2026-10-17T12:00:00Z'),
    idGenerator: () => `id-${++seq}`
  });
  return { repository, bus, service, monitoring };
}

const createBudget = (ctx, payload = {}) => ctx.service.handleCommand(command('CreateBudget', {
  externalId: 'ext-1', customer: { name: 'João', email: 'joao@example.com' }, items: ITEMS, ...payload
}));
const requestPayment = (ctx) => ctx.service.handleCommand(command('RequestPayment', { payer: { email: 'joao@example.com' } }));
const notify = (ctx, status, paymentId) => ctx.service.processPaymentNotification(
  FakePaymentGateway.providerPaymentId({ status, orderId: 42, paymentId })
);

describe('CreateBudget', () => {
  it('cria orçamento com total calculado e responde BudgetCreated na fila replyTo', async () => {
    const ctx = setup();
    await expect(createBudget(ctx)).resolves.toEqual({ outcome: 'BudgetCreated' });

    const reply = ctx.bus.last();
    expect(reply).toMatchObject({
      queue: 'os-replies', type: 'BudgetCreated', sagaId: 'saga-1', orderId: 42, source: 'billing-service',
      payload: { budgetId: 'id-1', total: 170, status: 'PENDING_APPROVAL' },
      traceHeaders: { traceparent: '00-billing' }
    });
    expect((await ctx.repository.getBudget(42)).items[1].total).toBe(90);
    expect(ctx.monitoring.events[0]).toMatchObject({ type: 'BudgetStatusChanged', status: 'PENDING_APPROVAL' });
  });

  it('comando reentregue responde o mesmo orçamento sem duplicar', async () => {
    const ctx = setup();
    await createBudget(ctx);
    await createBudget(ctx);
    expect(ctx.bus.published.map((m) => m.payload.budgetId)).toEqual(['id-1', 'id-1']);
    expect(ctx.repository.budgets.size).toBe(1);
  });

  it('corrida: outra réplica criou o orçamento entre a leitura e a escrita', async () => {
    const ctx = setup();
    const original = ctx.repository.getBudget.bind(ctx.repository);
    let first = true;
    ctx.repository.getBudget = async (id) => {
      if (first) { first = false; return null; }
      return original(id);
    };
    await ctx.repository.createBudget(Budget.create({ budgetId: 'other', orderId: 42, items: ITEMS }));
    await createBudget(ctx);
    expect(ctx.bus.last().payload.budgetId).toBe('other');
  });

  it('itens inválidos → BudgetCreationFailed', async () => {
    const ctx = setup();
    await createBudget(ctx, { items: [] });
    expect(ctx.bus.last()).toMatchObject({ type: 'BudgetCreationFailed', payload: { reason: 'O orçamento precisa de ao menos um item.' } });
  });

  it('erro inesperado é propagado (mensagem volta para a fila)', async () => {
    const ctx = setup();
    ctx.repository.createBudget = async () => { throw new Error('dynamo down'); };
    await expect(createBudget(ctx)).rejects.toThrow('dynamo down');
  });

  it('sem replyTo usa a fila padrão', async () => {
    const ctx = setup();
    await ctx.service.handleCommand(command('CreateBudget', { items: ITEMS }, { replyTo: undefined }));
    expect(ctx.bus.last().queue).toBe('default-replies');
  });
});

describe('RequestPayment', () => {
  it('aprova o orçamento, cria checkout e responde PaymentRequested', async () => {
    const ctx = setup();
    await createBudget(ctx);
    await requestPayment(ctx);

    const reply = ctx.bus.last();
    expect(reply).toMatchObject({ type: 'PaymentRequested', payload: { paymentId: 'id-2', amount: 170, status: 'PENDING' } });
    expect(reply.payload.checkoutUrl).toContain('/api/payments/order/42/simulate');
    expect((await ctx.repository.getBudget(42)).status).toBe('APPROVED');
  });

  it('reentrega devolve a mesma cobrança aberta', async () => {
    const ctx = setup();
    await createBudget(ctx);
    await requestPayment(ctx);
    await requestPayment(ctx);
    expect(ctx.repository.payments.size).toBe(1);
    expect(ctx.bus.last().payload.paymentId).toBe('id-2');
  });

  it.each([
    ['sem orçamento', async () => {}, 'Orçamento não encontrado'],
    ['orçamento cancelado', async (ctx) => {
      await createBudget(ctx);
      await ctx.service.handleCommand(command('CancelBudget', {}));
    }, 'Orçamento cancelado']
  ])('%s → PaymentRequestFailed', async (_, prepare, reason) => {
    const ctx = setup();
    await prepare(ctx);
    await requestPayment(ctx);
    expect(ctx.bus.last()).toMatchObject({ type: 'PaymentRequestFailed', payload: { reason } });
  });

  it('erro definitivo do gateway (4xx) → PaymentRequestFailed; transitório → relança', async () => {
    const gateway = new FakePaymentGateway();
    const ctx = setup({ gateway });
    await createBudget(ctx);

    gateway.createCheckout = async () => { throw new PaymentGatewayError('HTTP 400', { status: 400 }); };
    await requestPayment(ctx);
    expect(ctx.bus.last()).toMatchObject({ type: 'PaymentRequestFailed', payload: { reason: 'HTTP 400' } });

    gateway.createCheckout = async () => { throw new PaymentGatewayError('HTTP 503', { status: 503, retryable: true }); };
    await expect(requestPayment(ctx)).rejects.toThrow('HTTP 503');
  });

  it('usa o cliente do orçamento quando o comando não traz pagador', async () => {
    const gateway = new FakePaymentGateway();
    const spy = jest.spyOn(gateway, 'createCheckout');
    const ctx = setup({ gateway });
    await createBudget(ctx);
    await ctx.service.handleCommand(command('RequestPayment', {}));
    expect(spy.mock.calls[0][0].payer).toEqual({ name: 'João', email: 'joao@example.com' });
  });
});

describe('Notificação de pagamento (webhook)', () => {
  async function paid(ctx) {
    await createBudget(ctx);
    await requestPayment(ctx);
    return ctx.bus.last().payload.paymentId;
  }

  it('approved → PaymentConfirmed para a saga (sagaId/replyTo do orçamento)', async () => {
    const ctx = setup();
    const paymentId = await paid(ctx);
    await expect(notify(ctx, 'approved', paymentId)).resolves.toEqual({ outcome: 'CONFIRMED' });
    expect(ctx.bus.last()).toMatchObject({ queue: 'os-replies', type: 'PaymentConfirmed', sagaId: 'saga-1', orderId: 42, payload: { paymentId, amount: 170 } });
    expect((await ctx.repository.getPayment(42, paymentId)).status).toBe('APPROVED');
  });

  it('notificação repetida não publica de novo', async () => {
    const ctx = setup();
    const paymentId = await paid(ctx);
    await notify(ctx, 'approved', paymentId);
    const count = ctx.bus.published.length;
    await expect(notify(ctx, 'approved', paymentId)).resolves.toMatchObject({ outcome: 'ALREADY_PROCESSED' });
    await expect(notify(ctx, 'rejected', paymentId)).resolves.toMatchObject({ outcome: 'ALREADY_PROCESSED' });
    expect(ctx.bus.published).toHaveLength(count);
  });

  it('rejected → PaymentFailed com o status_detail', async () => {
    const ctx = setup();
    const paymentId = await paid(ctx);
    await expect(notify(ctx, 'rejected', paymentId)).resolves.toEqual({ outcome: 'FAILED' });
    expect(ctx.bus.last()).toMatchObject({ type: 'PaymentFailed', payload: { reason: 'cc_rejected_other_reason', providerStatus: 'rejected' } });
  });

  it('pending/in_process é ignorado', async () => {
    const ctx = setup();
    const paymentId = await paid(ctx);
    await expect(notify(ctx, 'in_process', paymentId)).resolves.toEqual({ outcome: 'IGNORED_STATUS', status: 'in_process' });
  });

  it('pagamento aprovado de orçamento já cancelado é estornado automaticamente', async () => {
    const ctx = setup();
    const paymentId = await paid(ctx);
    // simula compensação concorrente que cancelou o orçamento mas deixou a cobrança pendente
    const budget = await ctx.repository.getBudget(42);
    budget.cancel('timeout');
    await ctx.repository.saveBudget(budget);

    await expect(notify(ctx, 'approved', paymentId)).resolves.toEqual({ outcome: 'AUTO_REFUNDED' });
    expect((await ctx.repository.getPayment(42, paymentId)).status).toBe('REFUNDED');
    expect(ctx.bus.published.some((m) => m.type === 'PaymentConfirmed')).toBe(false);
  });

  it('referência desconhecida ou cobrança inexistente são ignoradas', async () => {
    const ctx = setup();
    ctx.service.gateway = { getPayment: async () => ({ status: 'approved', externalReference: 'lixo' }) };
    await expect(ctx.service.processPaymentNotification('1')).resolves.toEqual({ outcome: 'UNKNOWN_REFERENCE' });
    ctx.service.gateway = { getPayment: async () => ({ status: 'approved', externalReference: '42:nope' }) };
    await expect(ctx.service.processPaymentNotification('1')).resolves.toEqual({ outcome: 'UNKNOWN_PAYMENT' });
  });
});

describe('Compensações', () => {
  it('CancelBudget cancela orçamento e cobranças pendentes (idempotente)', async () => {
    const ctx = setup();
    await createBudget(ctx);
    await requestPayment(ctx);
    await ctx.service.handleCommand(command('CancelBudget', { reason: 'cliente recusou' }));
    await ctx.service.handleCommand(command('CancelBudget', {}));

    expect(ctx.bus.last()).toMatchObject({ type: 'BudgetCancelled', payload: { budgetId: 'id-1' } });
    const budget = await ctx.repository.getBudget(42);
    expect(budget).toMatchObject({ status: 'CANCELLED', cancelReason: 'cliente recusou' });
    expect((await ctx.repository.listPayments(42))[0].status).toBe('CANCELLED');
  });

  it('CancelBudget sem orçamento confirma mesmo assim', async () => {
    const ctx = setup();
    await ctx.service.handleCommand(command('CancelBudget', {}));
    expect(ctx.bus.last()).toMatchObject({ type: 'BudgetCancelled', payload: { budgetId: null } });
  });

  async function approvedPayment(ctx) {
    await createBudget(ctx);
    await requestPayment(ctx);
    const paymentId = ctx.bus.last().payload.paymentId;
    await notify(ctx, 'approved', paymentId);
    return paymentId;
  }

  it('RefundPayment estorna no gateway, cancela o orçamento e responde PaymentRefunded', async () => {
    const gateway = new FakePaymentGateway();
    const refund = jest.spyOn(gateway, 'refund');
    const ctx = setup({ gateway });
    const paymentId = await approvedPayment(ctx);

    await ctx.service.handleCommand(command('RefundPayment', { reason: 'exec recusada' }));
    expect(refund).toHaveBeenCalledWith(expect.stringContaining('fake_approved_42'), { idempotencyKey: `refund-${paymentId}` });
    expect(ctx.bus.last()).toMatchObject({ type: 'PaymentRefunded', payload: { paymentId, amount: 170 } });
    expect((await ctx.repository.getBudget(42)).status).toBe('CANCELLED');

    // reentrega: já estornado → confirma de novo sem chamar o gateway
    await ctx.service.handleCommand(command('RefundPayment', {}));
    expect(refund).toHaveBeenCalledTimes(1);
    expect(ctx.bus.last().type).toBe('PaymentRefunded');
  });

  it('estorno recusado → PaymentRefundFailed e REFUND_FAILED; nova tentativa pode estornar', async () => {
    const gateway = new FakePaymentGateway({ refundShouldFail: true });
    const ctx = setup({ gateway });
    const paymentId = await approvedPayment(ctx);

    await ctx.service.handleCommand(command('RefundPayment', {}));
    expect(ctx.bus.last()).toMatchObject({ type: 'PaymentRefundFailed', payload: { paymentId, reason: 'Estorno recusado (simulado)' } });
    expect((await ctx.repository.getPayment(42, paymentId)).status).toBe('REFUND_FAILED');

    await ctx.service.handleCommand(command('RefundPayment', {}));
    expect(ctx.bus.last().type).toBe('PaymentRefundFailed');

    gateway.refundShouldFail = false;
    await ctx.service.handleCommand(command('RefundPayment', {}));
    expect((await ctx.repository.getPayment(42, paymentId)).status).toBe('REFUNDED');
  });

  it('estorno com falha transitória relança para o SQS reentregar', async () => {
    const gateway = new FakePaymentGateway();
    const ctx = setup({ gateway });
    await approvedPayment(ctx);
    gateway.refund = async () => { throw new PaymentGatewayError('timeout', { retryable: true }); };
    await expect(ctx.service.handleCommand(command('RefundPayment', {}))).rejects.toThrow('timeout');
  });

  it('RefundPayment sem pagamento aprovado → PaymentRefundFailed', async () => {
    const ctx = setup();
    await createBudget(ctx);
    await ctx.service.handleCommand(command('RefundPayment', {}));
    expect(ctx.bus.last()).toMatchObject({ type: 'PaymentRefundFailed', payload: { reason: 'Nenhum pagamento aprovado para estornar' } });
  });
});

describe('Consultas e comandos desconhecidos', () => {
  it('getOrderBilling traz orçamento e cobrança atual; null sem orçamento', async () => {
    const ctx = setup();
    await expect(ctx.service.getOrderBilling(42)).resolves.toBeNull();
    await createBudget(ctx);
    expect(await ctx.service.getOrderBilling(42)).toMatchObject({ budget: { total: 170 }, payment: null, payments: [] });
    await requestPayment(ctx);
    expect((await ctx.service.getOrderBilling(42)).payment.status).toBe('PENDING');
  });

  it('listBudgets filtra por status', async () => {
    const ctx = setup();
    await createBudget(ctx);
    expect(await ctx.service.listBudgets({ status: 'APPROVED' })).toHaveLength(0);
    expect(await ctx.service.listBudgets()).toHaveLength(1);
  });

  it('comando desconhecido é ignorado', async () => {
    const ctx = setup();
    await expect(ctx.service.handleCommand(command('Xpto'))).resolves.toEqual({ outcome: 'UNHANDLED_TYPE' });
  });

  it('usa relógio e ids padrão', () => {
    const service = new BillingService({});
    expect(service.clock()).toBeInstanceOf(Date);
    expect(service.idGenerator()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
