const crypto = require('node:crypto');
const { MercadoPagoGateway, PaymentGatewayError, verifyWebhookSignature } = require('../../src/infrastructure/payments/MercadoPagoGateway');
const FakePaymentGateway = require('../../src/infrastructure/payments/FakePaymentGateway');
const { ITEMS } = require('../support/inMemory');

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const budget = { budgetId: 'b-1', orderId: 42, items: ITEMS.map((i) => ({ ...i })) };

describe('MercadoPagoGateway', () => {
  it('exige access token', () => {
    expect(() => new MercadoPagoGateway({})).toThrow('MERCADOPAGO_ACCESS_TOKEN');
  });

  it('cria preferência do Checkout Pro com idempotência, external_reference e notification_url https', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(201, { id: 'pref-1', init_point: 'https://mp/init', sandbox_init_point: 'https://mp/sandbox' }));
    const gateway = new MercadoPagoGateway({ accessToken: 'TEST-123', publicBaseUrl: 'https://billing.example.com/', fetchImpl });

    await expect(gateway.createCheckout({ paymentId: 'p-1', budget, payer: { email: 'a@a.com', name: 'A' } }))
      .resolves.toEqual({ preferenceId: 'pref-1', checkoutUrl: 'https://mp/sandbox' });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer TEST-123', 'X-Idempotency-Key': 'preference-p-1' });
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      external_reference: '42:p-1',
      notification_url: 'https://billing.example.com/api/webhooks/mercadopago',
      payer: { email: 'a@a.com' }
    });
    expect(body.items[1]).toEqual({ id: 'PART-1', title: 'Óleo 5W40', quantity: 2, unit_price: 45, currency_id: 'BRL' });
  });

  it('produção usa init_point; URL http não vira notification_url; sem pagador não envia payer', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(201, { id: 'pref', init_point: 'https://mp/init' }));
    const gateway = new MercadoPagoGateway({ accessToken: 't', publicBaseUrl: 'http://localhost:4100', useSandbox: false, fetchImpl });
    const result = await gateway.createCheckout({ paymentId: 'p', budget });
    expect(result.checkoutUrl).toBe('https://mp/init');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('notification_url');
    expect(body).not.toHaveProperty('payer');
  });

  it('sandbox sem sandbox_init_point cai no init_point', async () => {
    const gateway = new MercadoPagoGateway({ accessToken: 't', fetchImpl: async () => json(201, { id: 'x', init_point: 'https://mp/init' }) });
    expect((await gateway.createCheckout({ paymentId: 'p', budget })).checkoutUrl).toBe('https://mp/init');
  });

  it('consulta pagamento e normaliza o retorno', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(200, {
      id: 123, status: 'approved', status_detail: 'accredited', external_reference: '42:p-1', transaction_amount: 170
    }));
    const gateway = new MercadoPagoGateway({ accessToken: 't', fetchImpl });
    await expect(gateway.getPayment('123')).resolves.toEqual({
      id: '123', status: 'approved', statusDetail: 'accredited', externalReference: '42:p-1', amount: 170
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.mercadopago.com/v1/payments/123');
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  it('busca pagamentos pela external_reference (polling)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(200, { results: [
      { id: 9, status: 'approved', status_detail: 'accredited', external_reference: '42:p', transaction_amount: 10 }
    ] }));
    const gateway = new MercadoPagoGateway({ accessToken: 't', fetchImpl });
    await expect(gateway.searchPaymentsByReference('42:p')).resolves.toEqual([
      { id: '9', status: 'approved', statusDetail: 'accredited', externalReference: '42:p', amount: 10 }
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.mercadopago.com/v1/payments/search?external_reference=42%3Ap&sort=date_created&criteria=desc');
    const empty = new MercadoPagoGateway({ accessToken: 't', fetchImpl: async () => json(200, {}) });
    await expect(empty.searchPaymentsByReference('1:x')).resolves.toEqual([]);
    await expect(new FakePaymentGateway().searchPaymentsByReference('1:x')).resolves.toEqual([]);
  });

  it('estorna com X-Idempotency-Key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(201, { id: 9, status: 'approved' }));
    const gateway = new MercadoPagoGateway({ accessToken: 't', fetchImpl });
    await expect(gateway.refund('123', { idempotencyKey: 'refund-p' })).resolves.toEqual({ refundId: '9', status: 'approved' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.mercadopago.com/v1/payments/123/refunds');
    expect(fetchImpl.mock.calls[0][1].headers['X-Idempotency-Key']).toBe('refund-p');
  });

  it.each([
    [400, false], [404, false], [429, true], [500, true]
  ])('HTTP %i → PaymentGatewayError retryable=%s', async (status, retryable) => {
    const gateway = new MercadoPagoGateway({ accessToken: 't', fetchImpl: async () => json(status, { message: 'bad' }) });
    const error = await gateway.getPayment('1').catch((e) => e);
    expect(error).toBeInstanceOf(PaymentGatewayError);
    expect(error).toMatchObject({ status, retryable });
  });

  it('erro sem corpo JSON e falha de rede', async () => {
    const noJson = new MercadoPagoGateway({ accessToken: 't', fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) });
    await expect(noJson.getPayment('1')).rejects.toThrow('HTTP 502: erro');
    const offline = new MercadoPagoGateway({ accessToken: 't', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    await expect(offline.getPayment('1')).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('ECONNRESET') });
  });
});

describe('verifyWebhookSignature (x-signature do Mercado Pago)', () => {
  const secret = 'webhook-secret';
  const sign = (manifest) => crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  it('aceita assinatura válida (data.id alfanumérico em minúsculas)', () => {
    const v1 = sign('id:abc123;request-id:req-1;ts:1704908010;');
    expect(verifyWebhookSignature({ signatureHeader: `ts=1704908010,v1=${v1}`, requestId: 'req-1', dataId: 'ABC123', secret })).toBe(true);
  });

  it('omite partes ausentes do manifest', () => {
    const v1 = sign('ts:1704908010;');
    expect(verifyWebhookSignature({ signatureHeader: `ts=1704908010, v1=${v1}`, secret })).toBe(true);
  });

  it('rejeita assinatura adulterada, header incompleto ou sem segredo', () => {
    const v1 = sign('id:1;request-id:r;ts:1;');
    expect(verifyWebhookSignature({ signatureHeader: `ts=1,v1=${v1}`, requestId: 'r', dataId: '2', secret })).toBe(false);
    expect(verifyWebhookSignature({ signatureHeader: 'ts=1', secret })).toBe(false);
    expect(verifyWebhookSignature({ signatureHeader: `ts=1,v1=${v1}`, secret: '' })).toBe(false);
    expect(verifyWebhookSignature({ signatureHeader: 'ts=1,v1=abcd', secret })).toBe(false);
  });

  it('tolerância de tempo opcional contra replay', () => {
    const v1 = sign('ts:1000;');
    expect(verifyWebhookSignature({ signatureHeader: `ts=1000,v1=${v1}`, secret, toleranceSeconds: 60, now: 1_000_000 + 30_000 })).toBe(true);
    expect(verifyWebhookSignature({ signatureHeader: `ts=1000,v1=${v1}`, secret, toleranceSeconds: 60, now: 1_000_000 + 120_000 })).toBe(false);
    const v1ms = sign('ts:1000000000000;');
    expect(verifyWebhookSignature({ signatureHeader: `ts=1000000000000,v1=${v1ms}`, secret, toleranceSeconds: 60, now: 1_000_000_000_000 })).toBe(true);
  });
});

describe('FakePaymentGateway', () => {
  it('checkout, consulta e estorno simulados (sem estado)', async () => {
    const gateway = new FakePaymentGateway({ publicBaseUrl: 'http://x/' });
    expect(await gateway.createCheckout({ paymentId: 'p', budget })).toEqual({
      preferenceId: 'fake-pref-p', checkoutUrl: 'http://x/api/payments/order/42/simulate?paymentId=p'
    });
    const id = FakePaymentGateway.providerPaymentId({ status: 'in_process', orderId: 42, paymentId: 'p_1' });
    await expect(gateway.getPayment(id)).resolves.toMatchObject({ status: 'in_process', externalReference: '42:p_1' });
    await expect(gateway.getPayment('fake_approved_42_p')).resolves.toMatchObject({ statusDetail: 'accredited' });
    await expect(gateway.getPayment('qualquer')).rejects.toBeInstanceOf(PaymentGatewayError);
    await expect(gateway.refund('id')).resolves.toMatchObject({ status: 'approved' });
    await expect(new FakePaymentGateway({ refundShouldFail: true }).refund('id')).rejects.toThrow('Estorno recusado');
    expect(new FakePaymentGateway().publicBaseUrl).toBe('http://localhost:4100');
  });
});
