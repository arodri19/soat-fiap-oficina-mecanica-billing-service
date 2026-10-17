// Precisa ser o primeiro require — o agente instrumenta express, http e aws-sdk.
require('newrelic');

const app = require('./app');
const config = require('./config');
const container = require('./container');
const { logger } = require('./middlewares/requestLogger');

const server = app.listen(config.PORT, () => {
  logger.info({ gateway: config.PAYMENT_GATEWAY }, `billing-service iniciado na porta ${config.PORT}`);
});

if (config.MESSAGING_ENABLED) {
  container.getCommandConsumer().start();
  logger.info({ queues: config.QUEUES }, 'Consumidor de comandos da saga iniciado');
}

async function shutdown(signal) {
  logger.info({ signal }, 'Encerrando billing-service');
  if (config.MESSAGING_ENABLED) await container.getMessageBus().stop();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
