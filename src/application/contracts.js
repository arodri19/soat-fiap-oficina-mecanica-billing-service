// Contratos de mensagens da saga (cópia local — ver docs/mensageria.md no os-service).
const crypto = require('node:crypto');

const SERVICE_NAME = 'billing-service';

// Comandos recebidos do orquestrador (os-service) na fila <prefixo>-billing-commands
const Commands = Object.freeze({
  CREATE_BUDGET: 'CreateBudget',
  REQUEST_PAYMENT: 'RequestPayment',
  CANCEL_BUDGET: 'CancelBudget',
  REFUND_PAYMENT: 'RefundPayment'
});

// Respostas/eventos publicados na fila de respostas da saga (<prefixo>-os-saga-replies)
const Replies = Object.freeze({
  BUDGET_CREATED: 'BudgetCreated',
  BUDGET_CREATION_FAILED: 'BudgetCreationFailed',
  BUDGET_CANCELLED: 'BudgetCancelled',
  PAYMENT_REQUESTED: 'PaymentRequested',
  PAYMENT_REQUEST_FAILED: 'PaymentRequestFailed',
  PAYMENT_CONFIRMED: 'PaymentConfirmed',
  PAYMENT_FAILED: 'PaymentFailed',
  PAYMENT_REFUNDED: 'PaymentRefunded',
  PAYMENT_REFUND_FAILED: 'PaymentRefundFailed'
});

function createReply({ type, sagaId, orderId, correlationId, payload = {}, traceHeaders }) {
  return {
    messageId: crypto.randomUUID(),
    type,
    sagaId,
    orderId,
    correlationId: correlationId || sagaId,
    source: SERVICE_NAME,
    occurredAt: new Date().toISOString(),
    traceHeaders: traceHeaders || {},
    payload
  };
}

function isValidEnvelope(message) {
  return Boolean(
    message
    && typeof message.messageId === 'string'
    && typeof message.type === 'string'
    && message.payload !== null
    && typeof message.payload === 'object'
  );
}

module.exports = { SERVICE_NAME, Commands, Replies, createReply, isValidEnvelope };
