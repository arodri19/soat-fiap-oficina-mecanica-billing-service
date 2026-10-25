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

// Polling do Mercado Pago: descobre pagamentos aprovados/recusados sem depender do
// webhook (que exige URL pública https). Sem sobreposição: o próximo ciclo só é
// agendado quando o anterior termina.
let pollTimer = null;
if (config.PAYMENT_POLL_INTERVAL_MS > 0 && config.PAYMENT_GATEWAY === 'mercadopago') {
  const poll = async () => {
    try {
      const summary = await container.getBillingService().reconcilePendingPayments();
      if (summary.confirmed || summary.failed || summary.errors) logger.info(summary, 'Polling do Mercado Pago');
    } catch (error) {
      logger.error({ err: error }, 'Erro no polling do Mercado Pago');
    }
    pollTimer = setTimeout(poll, config.PAYMENT_POLL_INTERVAL_MS);
  };
  pollTimer = setTimeout(poll, config.PAYMENT_POLL_INTERVAL_MS);
  logger.info({ intervalMs: config.PAYMENT_POLL_INTERVAL_MS }, 'Polling de pagamentos do Mercado Pago ativo');
}

async function shutdown(signal) {
  logger.info({ signal }, 'Encerrando billing-service');
  if (pollTimer) clearTimeout(pollTimer);
  if (config.MESSAGING_ENABLED) await container.getMessageBus().stop();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
