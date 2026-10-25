const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize } = require('../middlewares/auth');
const container = require('../container');
const config = require('../config');
const FakePaymentGateway = require('../infrastructure/payments/FakePaymentGateway');
const { verifyWebhookSignature } = require('../infrastructure/payments/MercadoPagoGateway');

const router = express.Router();
const staff = [authenticate, authorize(['ATTENDANT', 'MECHANIC'])];
const service = () => container.getBillingService();
const orderIdOf = (req) => Number(req.params.orderId);

// ── Consultas (atendentes/mecânicos) ─────────────────────────────────────────
router.get('/budgets', ...staff, asyncHandler(async (req, res) => {
  res.json(await service().listBudgets({ status: req.query.status }));
}));

router.get('/budgets/order/:orderId', ...staff, asyncHandler(async (req, res) => {
  const billing = await service().getOrderBilling(orderIdOf(req));
  if (!billing) return res.status(404).json({ message: 'Orçamento não encontrado para esta OS.' });
  return res.json(billing.budget);
}));

router.get('/payments/order/:orderId', ...staff, asyncHandler(async (req, res) => {
  const billing = await service().getOrderBilling(orderIdOf(req));
  if (!billing) return res.status(404).json({ message: 'Nenhuma cobrança para esta OS.' });
  return res.json(billing.payments);
}));

// ── REST síncrono para outros microsserviços (JWT role SERVICE) ──────────────
router.get('/internal/orders/:orderId/billing', authenticate, authorize(['SERVICE']), asyncHandler(async (req, res) => {
  const billing = await service().getOrderBilling(orderIdOf(req));
  if (!billing) return res.status(404).json({ message: 'Sem orçamento para esta OS.' });
  return res.json(billing);
}));

// ── Webhook do Mercado Pago (público; autenticado pela assinatura x-signature) ─
// Responde 200 rapidamente (o Mercado Pago aguarda até 22s e reenvia em caso de erro).
router.post('/webhooks/mercadopago', asyncHandler(async (req, res) => {
  const type = req.query.type || req.body?.type || req.query.topic;
  const dataId = req.query['data.id'] || req.body?.data?.id || req.query.id;

  if (config.MERCADOPAGO_WEBHOOK_SECRET) {
    const valid = verifyWebhookSignature({
      signatureHeader: req.get('x-signature'),
      requestId: req.get('x-request-id'),
      dataId: req.query['data.id'] || dataId,
      secret: config.MERCADOPAGO_WEBHOOK_SECRET
    });
    if (!valid) return res.status(401).json({ message: 'Assinatura inválida.' });
  }

  if (type !== 'payment' || !dataId) return res.status(200).json({ ignored: true });
  const result = await service().processPaymentNotification(String(dataId));
  return res.status(200).json(result);
}));

// ── Simulação de pagamento (somente com PAYMENT_GATEWAY=fake) ─────────────────
// Equivalente ao cliente pagar (ou ter o cartão recusado) no Checkout Pro +
// webhook do Mercado Pago. Usado em desenvolvimento local, testes e demo.
router.post('/payments/order/:orderId/simulate', ...staff, asyncHandler(async (req, res) => {
  if (config.PAYMENT_GATEWAY !== 'fake') {
    return res.status(404).json({ message: 'Simulação disponível apenas com PAYMENT_GATEWAY=fake.' });
  }
  const status = req.body?.status === 'rejected' ? 'rejected' : 'approved';
  const billing = await service().getOrderBilling(orderIdOf(req));
  const pending = billing?.payments.find((p) => p.status === 'PENDING');
  if (!pending) return res.status(404).json({ message: 'Nenhuma cobrança pendente para esta OS.' });

  const providerPaymentId = FakePaymentGateway.providerPaymentId({ status, orderId: pending.orderId, paymentId: pending.paymentId });
  return res.json(await service().processPaymentNotification(providerPaymentId));
}));

module.exports = router;
