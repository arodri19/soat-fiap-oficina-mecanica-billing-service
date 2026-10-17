const crypto = require('node:crypto');

class PaymentGatewayError extends Error {
  // retryable = falha transitória (rede, 429, 5xx): o comando é devolvido à fila
  // SQS e reprocessado. Não-retryable (4xx): resposta de falha à saga.
  constructor(message, { status = null, retryable = false, details } = {}) {
    super(message);
    this.name = 'PaymentGatewayError';
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Integração com o Mercado Pago via API REST
 * (documentação: https://www.mercadopago.com.br/developers/pt).
 *
 * - Checkout Pro: POST /checkout/preferences → link de pagamento (init_point)
 * - Consulta do pagamento notificado: GET /v1/payments/{id}
 * - Estorno (compensação da saga): POST /v1/payments/{id}/refunds
 * - Webhooks: assinatura HMAC-SHA256 no header x-signature ("ts=...,v1=...")
 *
 * Todas as escritas enviam X-Idempotency-Key — uma reentrega do mesmo comando
 * pelo SQS não gera cobrança/estorno duplicado.
 */
class MercadoPagoGateway {
  constructor({ accessToken, publicBaseUrl, useSandbox = true, baseUrl = 'https://api.mercadopago.com', fetchImpl, timeoutMs = 10_000 }) {
    if (!accessToken) throw new Error('MERCADOPAGO_ACCESS_TOKEN é obrigatório para o gateway Mercado Pago.');
    this.accessToken = accessToken;
    this.publicBaseUrl = publicBaseUrl?.replace(/\/$/, '') || '';
    this.useSandbox = useSandbox;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.name = 'MERCADO_PAGO';
  }

  async #request(method, path, { body, idempotencyKey } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new PaymentGatewayError(`Mercado Pago indisponível: ${error.message}`, { retryable: true });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PaymentGatewayError(
        `Mercado Pago ${method} ${path} → HTTP ${response.status}: ${data.message || data.error || 'erro'}`,
        { status: response.status, retryable: response.status === 429 || response.status >= 500, details: data }
      );
    }
    return data;
  }

  async createCheckout({ paymentId, budget, payer }) {
    const externalReference = `${budget.orderId}:${paymentId}`;
    const notificationUrl = this.publicBaseUrl.startsWith('https://')
      ? `${this.publicBaseUrl}/api/webhooks/mercadopago`
      : undefined; // o Mercado Pago só notifica URLs públicas https

    const preference = await this.#request('POST', '/checkout/preferences', {
      idempotencyKey: `preference-${paymentId}`,
      body: {
        items: budget.items.map((item) => ({
          id: `${item.type}-${item.referenceId}`,
          title: item.description,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          currency_id: 'BRL'
        })),
        ...(payer?.email ? { payer: { email: payer.email, name: payer.name } } : {}),
        external_reference: externalReference,
        statement_descriptor: 'OFICINA MECANICA',
        metadata: { order_id: budget.orderId, budget_id: budget.budgetId, payment_id: paymentId },
        ...(notificationUrl ? { notification_url: notificationUrl } : {})
      }
    });

    return {
      preferenceId: preference.id,
      checkoutUrl: this.useSandbox ? preference.sandbox_init_point || preference.init_point : preference.init_point
    };
  }

  async getPayment(providerPaymentId) {
    const payment = await this.#request('GET', `/v1/payments/${encodeURIComponent(providerPaymentId)}`);
    return {
      id: String(payment.id),
      status: payment.status,
      statusDetail: payment.status_detail,
      externalReference: payment.external_reference,
      amount: payment.transaction_amount
    };
  }

  async refund(providerPaymentId, { idempotencyKey }) {
    const refund = await this.#request('POST', `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds`, {
      idempotencyKey,
      body: {}
    });
    return { refundId: String(refund.id), status: refund.status };
  }
}

/**
 * Valida a assinatura do webhook do Mercado Pago.
 * Template assinado: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (HMAC-SHA256,
 * hex, com a "assinatura secreta" configurada em Suas integrações > Webhooks).
 * data.id alfanumérico é usado em minúsculas; partes ausentes são omitidas.
 */
function verifyWebhookSignature({ signatureHeader, requestId, dataId, secret, toleranceSeconds = 0, now = Date.now() }) {
  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => part.split('=').map((s) => s.trim())).filter(([k, v]) => k && v)
  );
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  if (toleranceSeconds > 0) {
    const tsMs = ts.length > 10 ? Number(ts) : Number(ts) * 1000;
    if (Math.abs(now - tsMs) > toleranceSeconds * 1000) return false;
  }

  const id = dataId && /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId;
  let manifest = '';
  if (id) manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;

  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { MercadoPagoGateway, PaymentGatewayError, verifyWebhookSignature };
