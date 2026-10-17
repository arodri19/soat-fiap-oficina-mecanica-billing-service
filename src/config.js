const dotenv = require('dotenv');

dotenv.config();

const PREFIX = process.env.QUEUE_PREFIX || 'oficina-mecanica-dev';

module.exports = {
  PORT: process.env.PORT || 4100,
  JWT_SECRET: process.env.JWT_SECRET || 'change-me',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  SQS_ENDPOINT: process.env.SQS_ENDPOINT || '',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT || '',
  MESSAGING_ENABLED: process.env.MESSAGING_ENABLED !== 'false',
  TABLE_NAME: process.env.BILLING_TABLE || `${PREFIX}-billing`,
  QUEUES: {
    commands: process.env.BILLING_COMMANDS_QUEUE || `${PREFIX}-billing-commands`,
    osReplies: process.env.OS_REPLIES_QUEUE || `${PREFIX}-os-saga-replies`
  },

  // ── Pagamentos ──────────────────────────────────────────────────────────────
  // mercadopago = API real (https://www.mercadopago.com.br/developers/pt)
  // fake        = simulação local (sem credenciais) — padrão quando não há token
  PAYMENT_GATEWAY: process.env.PAYMENT_GATEWAY || (process.env.MERCADOPAGO_ACCESS_TOKEN ? 'mercadopago' : 'fake'),
  MERCADOPAGO_ACCESS_TOKEN: process.env.MERCADOPAGO_ACCESS_TOKEN || '',
  // "Assinatura secreta" do webhook (Suas integrações > Webhooks). Vazio = não valida
  // (apenas desenvolvimento local — em produção sempre configurar).
  MERCADOPAGO_WEBHOOK_SECRET: process.env.MERCADOPAGO_WEBHOOK_SECRET || '',
  // Credenciais de teste usam o sandbox_init_point do Checkout Pro
  MERCADOPAGO_SANDBOX: process.env.MERCADOPAGO_SANDBOX !== 'false',
  // URL pública do billing (https) — vira notification_url das preferências
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:4100'
};
