const config = require('./config');
const { logger } = require('./middlewares/requestLogger');
const SqsMessageBus = require('./infrastructure/messaging/SqsMessageBus');
const CommandConsumer = require('./infrastructure/messaging/CommandConsumer');
const { DynamoBillingRepository } = require('./infrastructure/persistence/DynamoBillingRepository');
const { MercadoPagoGateway } = require('./infrastructure/payments/MercadoPagoGateway');
const FakePaymentGateway = require('./infrastructure/payments/FakePaymentGateway');
const monitoring = require('./infrastructure/monitoring/newrelicEvents');
const tracing = require('./infrastructure/monitoring/tracing');
const { BillingService } = require('./application/BillingService');

// Composição das dependências (singletons sob demanda).
const instances = new Map();
const single = (key, factory) => {
  if (!instances.has(key)) instances.set(key, factory());
  return instances.get(key);
};

function createGateway() {
  if (config.PAYMENT_GATEWAY === 'mercadopago') {
    return new MercadoPagoGateway({
      accessToken: config.MERCADOPAGO_ACCESS_TOKEN,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      useSandbox: config.MERCADOPAGO_SANDBOX
    });
  }
  return new FakePaymentGateway({ publicBaseUrl: config.PUBLIC_BASE_URL });
}

const container = {
  getGateway: () => single('gateway', createGateway),
  getMessageBus: () => single('messageBus', () => new SqsMessageBus({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT || undefined,
    logger
  })),
  getRepository: () => single('repository', () => new DynamoBillingRepository({
    tableName: config.TABLE_NAME,
    region: config.AWS_REGION,
    endpoint: config.DYNAMODB_ENDPOINT || undefined
  })),
  getBillingService: () => single('billingService', () => new BillingService({
    repository: container.getRepository(),
    gateway: container.getGateway(),
    messageBus: container.getMessageBus(),
    defaultReplyQueue: config.QUEUES.osReplies,
    monitoring,
    tracing,
    logger
  })),
  getCommandConsumer: () => single('commandConsumer', () => new CommandConsumer({
    messageBus: container.getMessageBus(),
    billingService: container.getBillingService(),
    queueName: config.QUEUES.commands,
    logger
  }))
};

module.exports = container;
