const path = require('node:path');
const { loadFeature, defineFeature } = require('jest-cucumber');
const { BillingService } = require('../../src/application/BillingService');
const FakePaymentGateway = require('../../src/infrastructure/payments/FakePaymentGateway');
const { InMemoryBillingRepository, RecordingBus, silentLogger, fakeTracing, fakeMonitoring, command } = require('../support/inMemory');

const feature = loadFeature(path.join(__dirname, 'features/orcamento-pagamento.feature'));

defineFeature(feature, (test) => {
  let ctx;

  const background = (given) => {
    given(/^que o os-service abriu a OS (\d+) com "(.*)" de R\$ ([\d.]+) e (\d+) "(.*)" de R\$ ([\d.]+)$/,
      (orderId, service, servicePrice, qty, part, partPrice) => {
        const repository = new InMemoryBillingRepository();
        const bus = new RecordingBus();
        ctx = {
          orderId: Number(orderId),
          repository,
          bus,
          service: new BillingService({
            repository, gateway: new FakePaymentGateway(), messageBus: bus, defaultReplyQueue: 'replies',
            monitoring: fakeMonitoring(), tracing: fakeTracing, logger: silentLogger
          }),
          items: [
            { type: 'SERVICE', referenceId: 1, description: service, quantity: 1, unitPrice: Number(servicePrice) },
            { type: 'PART', referenceId: 1, description: part, quantity: Number(qty), unitPrice: Number(partPrice) }
          ]
        };
      });
  };

  const steps = {
    comando: (fn) => fn(/^o comando "(.*)" chega na fila do billing$/, async (type) => {
      const payload = type === 'CreateBudget' ? { items: ctx.items, customer: { name: 'João', email: 'joao@example.com' } } : {};
      await ctx.service.handleCommand(command(type, payload, { orderId: ctx.orderId }));
    }),
    respostaTotal: (fn) => fn(/^a resposta "(.*)" é publicada com total de R\$ ([\d.]+)$/, (type, total) => {
      expect(ctx.bus.last()).toMatchObject({ type, payload: { total: Number(total) } });
    }),
    respostaLink: (fn) => fn(/^a resposta "(.*)" é publicada com o link de pagamento$/, (type) => {
      expect(ctx.bus.last().type).toBe(type);
      expect(ctx.bus.last().payload.checkoutUrl).toMatch(/^http/);
    }),
    resposta: (fn) => fn(/^a resposta "(.*)" é publicada$/, (type) => {
      expect(ctx.bus.last().type).toBe(type);
      expect(ctx.bus.last()).toMatchObject({ sagaId: 'saga-1', orderId: ctx.orderId });
    }),
    orcamento: (fn) => fn(/^o orçamento fica "(.*)"$/, async (status) => {
      expect((await ctx.repository.getBudget(ctx.orderId)).status).toBe(status);
    }),
    cobranca: (fn) => fn(/^a cobrança fica "(.*)"$/, async (status) => {
      expect((await ctx.repository.listPayments(ctx.orderId))[0].status).toBe(status);
    }),
    notificacao: (fn) => fn(/^o Mercado Pago notifica o pagamento como "(.*)"$/, async (status) => {
      const [payment] = await ctx.repository.listPayments(ctx.orderId);
      await ctx.service.processPaymentNotification(
        FakePaymentGateway.providerPaymentId({ status, orderId: ctx.orderId, paymentId: payment.paymentId })
      );
    }),
    unico: (fn) => fn(/^existe apenas (\d+) orçamento para a OS (\d+)$/, (count) => {
      expect(ctx.repository.budgets.size).toBe(Number(count));
      expect(ctx.bus.published.map((m) => m.payload.budgetId)).toEqual([expect.any(String), ctx.bus.published[0].payload.budgetId]);
    })
  };

  test('Orçamento aprovado e pago no Mercado Pago', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.respostaTotal(then);
    steps.comando(when);
    steps.respostaLink(then);
    steps.orcamento(and);
    steps.notificacao(when);
    steps.resposta(then);
    steps.cobranca(and);
  });

  test('Cartão recusado gera falha para a saga compensar', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.comando(and);
    steps.notificacao(and);
    steps.resposta(then);
    steps.comando(when);
    steps.resposta(then);
    steps.orcamento(and);
  });

  test('Estorno como compensação depois da execução ser recusada', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.comando(and);
    steps.notificacao(and);
    steps.comando(and);
    steps.resposta(then);
    steps.cobranca(and);
    steps.orcamento(and);
  });

  test('Comando reentregue pelo SQS não duplica o orçamento', ({ given, when, then, and }) => {
    background(given);
    steps.comando(when);
    steps.comando(and);
    steps.unico(then);
  });
});
