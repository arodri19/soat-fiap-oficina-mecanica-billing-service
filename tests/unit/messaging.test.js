jest.mock('newrelic', () => {
  const transaction = {
    insertDistributedTraceHeaders: jest.fn((headers) => { headers.traceparent = '00-abc'; }),
    acceptDistributedTraceHeaders: jest.fn(),
    end: jest.fn()
  };
  return {
    transaction,
    getTransaction: jest.fn(() => transaction),
    startBackgroundTransaction: jest.fn((name, group, fn) => fn()),
    noticeError: jest.fn(),
    recordCustomEvent: jest.fn(),
    getLinkingMetadata: jest.fn(() => ({}))
  };
});

const newrelic = require('newrelic');
const SqsMessageBus = require('../../src/infrastructure/messaging/SqsMessageBus');
const CommandConsumer = require('../../src/infrastructure/messaging/CommandConsumer');
const tracing = require('../../src/infrastructure/monitoring/tracing');
const { recordBillingEvent } = require('../../src/infrastructure/monitoring/newrelicEvents');
const { createReply, isValidEnvelope } = require('../../src/application/contracts');
const container = require('../../src/container');
const config = require('../../src/config');

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('contracts', () => {
  it('createReply e validação de envelope', () => {
    const reply = createReply({ type: 'BudgetCreated', sagaId: 's', orderId: 1 });
    expect(reply).toMatchObject({ source: 'billing-service', correlationId: 's', payload: {}, traceHeaders: {} });
    expect(isValidEnvelope(reply)).toBe(true);
    expect(isValidEnvelope({ messageId: 'x', type: 'y', payload: null })).toBe(false);
  });
});

describe('CommandConsumer', () => {
  it('processa comando dentro de transação New Relic com trace distribuído', async () => {
    const billingService = { handleCommand: jest.fn().mockResolvedValue({ outcome: 'BudgetCreated' }) };
    const consumer = new CommandConsumer({ messageBus: {}, billingService, queueName: 'q', logger });
    const envelope = { messageId: 'm', type: 'CreateBudget', payload: {}, traceHeaders: { traceparent: '00-os' } };
    await expect(consumer.handle(envelope)).resolves.toEqual({ outcome: 'BudgetCreated' });
    expect(newrelic.startBackgroundTransaction).toHaveBeenCalledWith('billing-command/CreateBudget', 'SQS', expect.any(Function));
    expect(newrelic.transaction.acceptDistributedTraceHeaders).toHaveBeenCalledWith('Queue', { traceparent: '00-os' });
  });

  it('descarta envelope inválido e propaga erro do handler', async () => {
    const billingService = { handleCommand: jest.fn().mockRejectedValue(new Error('x')) };
    const consumer = new CommandConsumer({ messageBus: {}, billingService, queueName: 'q', logger });
    await expect(consumer.handle({})).resolves.toEqual({ outcome: 'INVALID' });
    await expect(consumer.handle({ messageId: 'm', type: 'T', payload: {} })).rejects.toThrow('x');
    expect(newrelic.noticeError).toHaveBeenCalled();
  });

  it('start inscreve na fila', () => {
    const messageBus = { subscribe: jest.fn() };
    new CommandConsumer({ messageBus, billingService: {}, queueName: 'cmds', logger }).start();
    expect(messageBus.subscribe).toHaveBeenCalledWith('cmds', expect.any(Function));
  });
});

describe('tracing / monitoring', () => {
  it('headers da transação atual e tolerância a falhas do agente', async () => {
    expect(tracing.currentTraceHeaders()).toEqual({ traceparent: '00-abc' });
    newrelic.getTransaction.mockImplementationOnce(() => { throw new Error('off'); });
    expect(tracing.currentTraceHeaders()).toEqual({});
    newrelic.transaction.acceptDistributedTraceHeaders.mockImplementationOnce(() => { throw new Error('bad'); });
    await expect(tracing.runConsumerTransaction('x', { a: 1 }, async () => 1)).resolves.toBe(1);
  });

  it('recordBillingEvent marca o serviço', () => {
    recordBillingEvent('PaymentStatusChanged', { status: 'APPROVED' });
    expect(newrelic.recordCustomEvent).toHaveBeenCalledWith('PaymentStatusChanged', { service: 'billing-service', status: 'APPROVED' });
  });
});

describe('SqsMessageBus', () => {
  it('publica e consome (apaga só o que foi processado)', async () => {
    let round = 0;
    const bus = new SqsMessageBus({ logger, region: 'us-east-1' });
    bus.client = {
      send: jest.fn(async (cmd) => {
        const name = cmd.constructor.name;
        if (name === 'GetQueueUrlCommand') return { QueueUrl: 'https://sqs/q' };
        if (name === 'ReceiveMessageCommand') {
          round += 1;
          if (round > 1) { bus.running = false; return {}; }
          return { Messages: [
            { Body: '{"type":"ok"}', ReceiptHandle: 'r1' },
            { Body: '{"type":"fail"}', ReceiptHandle: 'r2' },
            { Body: '{', ReceiptHandle: 'r3' }
          ] };
        }
        return {};
      })
    };
    await bus.publish('q', { type: 'BudgetCreated' });
    await bus.subscribe('q', async (env) => { if (env.type === 'fail') throw new Error('x'); });
    await bus.stop();
    const deletes = bus.client.send.mock.calls.map(([c]) => c).filter((c) => c.constructor.name === 'DeleteMessageCommand');
    expect(deletes.map((d) => d.input.ReceiptHandle)).toEqual(['r1']);
  });

  it('erro de rede aguarda e tenta novamente', async () => {
    jest.useFakeTimers();
    const bus = new SqsMessageBus({ logger, client: { send: jest.fn().mockRejectedValue(new Error('net')) } });
    const loop = bus.subscribe('q', jest.fn());
    await Promise.resolve();
    bus.running = false;
    await jest.advanceTimersByTimeAsync(5000);
    await loop;
    expect(logger.error).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('container', () => {
  it('monta o grafo com gateway fake por padrão e Mercado Pago com token', () => {
    expect(container.getBillingService()).toBe(container.getBillingService());
    expect(container.getGateway().name).toBe('FAKE');
    expect(container.getCommandConsumer().queueName).toMatch(/billing-commands$/);
  });

  it('usa Mercado Pago quando configurado', () => {
    jest.isolateModules(() => {
      const cfg = require('../../src/config');
      cfg.PAYMENT_GATEWAY = 'mercadopago';
      cfg.MERCADOPAGO_ACCESS_TOKEN = 'TEST-1';
      const isolated = require('../../src/container');
      expect(isolated.getGateway().name).toBe('MERCADO_PAGO');
    });
    expect(config.PAYMENT_GATEWAY).toBe('fake');
  });
});
