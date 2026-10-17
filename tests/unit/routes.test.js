const crypto = require('node:crypto');

const mockService = {
  listBudgets: jest.fn(),
  getOrderBilling: jest.fn(),
  processPaymentNotification: jest.fn()
};
jest.mock('../../src/container', () => ({ getBillingService: () => mockService }));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const config = require('../../src/config');
const app = require('../../src/app');

const token = (role) => `Bearer ${jwt.sign({ sub: 1, role }, config.JWT_SECRET)}`;
const staff = token('ATTENDANT');

describe('Rotas do billing', () => {
  afterEach(() => {
    config.PAYMENT_GATEWAY = 'fake';
    config.MERCADOPAGO_WEBHOOK_SECRET = '';
  });

  it('GET /health e /api-docs', async () => {
    expect((await request(app).get('/health')).body.service).toBe('billing-service');
    expect((await request(app).get('/api-docs/')).status).toBe(200);
  });

  it('consultas exigem funcionário', async () => {
    await request(app).get('/api/budgets').expect(401);
    await request(app).get('/api/budgets').set('Authorization', token('CLIENT')).expect(403);

    mockService.listBudgets.mockResolvedValue([{ budgetId: 'b' }]);
    const res = await request(app).get('/api/budgets?status=APPROVED').set('Authorization', staff).expect(200);
    expect(res.body).toEqual([{ budgetId: 'b' }]);
    expect(mockService.listBudgets).toHaveBeenCalledWith({ status: 'APPROVED' });
  });

  it.each([
    ['/api/budgets/order/42', { budget: { total: 1 } }, { total: 1 }],
    ['/api/payments/order/42', { payments: [{ paymentId: 'p' }] }, [{ paymentId: 'p' }]]
  ])('GET %s → 200 ou 404', async (path, billing, body) => {
    mockService.getOrderBilling.mockResolvedValueOnce(billing);
    expect((await request(app).get(path).set('Authorization', staff).expect(200)).body).toEqual(body);
    mockService.getOrderBilling.mockResolvedValueOnce(null);
    await request(app).get(path).set('Authorization', staff).expect(404);
  });

  it('rota interna só aceita JWT de serviço', async () => {
    mockService.getOrderBilling.mockResolvedValue({ budget: {}, payments: [] });
    await request(app).get('/api/internal/orders/42/billing').set('Authorization', staff).expect(403);
    await request(app).get('/api/internal/orders/42/billing').set('Authorization', token('SERVICE')).expect(200);
    mockService.getOrderBilling.mockResolvedValue(null);
    await request(app).get('/api/internal/orders/42/billing').set('Authorization', token('SERVICE')).expect(404);
  });

  describe('webhook Mercado Pago', () => {
    it('processa notificação de pagamento (query data.id)', async () => {
      mockService.processPaymentNotification.mockResolvedValue({ outcome: 'CONFIRMED' });
      const res = await request(app).post('/api/webhooks/mercadopago?data.id=123&type=payment').send({ action: 'payment.updated' });
      expect(res.status).toBe(200);
      expect(mockService.processPaymentNotification).toHaveBeenCalledWith('123');
    });

    it('aceita formato do corpo (data.id no body) e ignora outros tópicos', async () => {
      mockService.processPaymentNotification.mockResolvedValue({ outcome: 'FAILED' });
      await request(app).post('/api/webhooks/mercadopago').send({ type: 'payment', data: { id: 77 } }).expect(200);
      expect(mockService.processPaymentNotification).toHaveBeenCalledWith('77');

      const ignored = await request(app).post('/api/webhooks/mercadopago?topic=merchant_order&id=1').send({});
      expect(ignored.body).toEqual({ ignored: true });
    });

    it('com segredo configurado exige x-signature válida', async () => {
      config.MERCADOPAGO_WEBHOOK_SECRET = 'segredo';
      mockService.processPaymentNotification.mockResolvedValue({ outcome: 'CONFIRMED' });

      await request(app).post('/api/webhooks/mercadopago?data.id=123&type=payment').send({}).expect(401);

      const v1 = crypto.createHmac('sha256', 'segredo').update('id:123;request-id:req-9;ts:1700000000;').digest('hex');
      await request(app)
        .post('/api/webhooks/mercadopago?data.id=123&type=payment')
        .set('x-signature', `ts=1700000000,v1=${v1}`)
        .set('x-request-id', 'req-9')
        .send({})
        .expect(200);
    });
  });

  describe('simulação de pagamento (gateway fake)', () => {
    it('gera o id fake e processa como webhook', async () => {
      mockService.getOrderBilling.mockResolvedValue({ payments: [{ status: 'PENDING', orderId: 42, paymentId: 'p' }] });
      mockService.processPaymentNotification.mockResolvedValue({ outcome: 'FAILED' });
      await request(app).post('/api/payments/order/42/simulate').set('Authorization', staff).send({ status: 'rejected' }).expect(200);
      expect(mockService.processPaymentNotification).toHaveBeenCalledWith('fake_rejected_42_p');
      await request(app).post('/api/payments/order/42/simulate').set('Authorization', staff).send({}).expect(200);
      expect(mockService.processPaymentNotification).toHaveBeenLastCalledWith('fake_approved_42_p');
    });

    it('404 sem cobrança pendente ou com gateway real', async () => {
      mockService.getOrderBilling.mockResolvedValue(null);
      await request(app).post('/api/payments/order/42/simulate').set('Authorization', staff).expect(404);
      config.PAYMENT_GATEWAY = 'mercadopago';
      await request(app).post('/api/payments/order/42/simulate').set('Authorization', staff).expect(404);
    });
  });

  describe('tratamento de erros', () => {
    it.each([
      [Object.assign(new Error('inválido'), { name: 'ValidationError' }), 400],
      [Object.assign(new Error('transição'), { name: 'InvalidTransitionError' }), 409],
      [new Error('boom'), 500]
    ])('%s → %i', async (error, status) => {
      mockService.listBudgets.mockRejectedValue(error);
      await request(app).get('/api/budgets').set('Authorization', staff).expect(status);
    });

    it('JSON inválido → 400', async () => {
      await request(app).post('/api/webhooks/mercadopago').set('Content-Type', 'application/json').send('{"a":').expect(400);
    });
  });
});
