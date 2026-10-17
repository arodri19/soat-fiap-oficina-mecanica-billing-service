const { PaymentGatewayError } = require('./MercadoPagoGateway');

/**
 * Gateway de pagamento simulado (PAYMENT_GATEWAY=fake) — para desenvolvimento
 * local, testes e demo sem credenciais do Mercado Pago. Mesma interface do
 * MercadoPagoGateway.
 *
 * Sem estado: o "id do pagamento no provedor" carrega status e referência
 * (fake_<status>_<orderId>_<paymentId>), então uma reinicialização do pod não
 * perde nada. A rota POST /api/payments/order/:orderId/simulate gera esse id e
 * dispara o mesmo fluxo de um webhook real.
 */
class FakePaymentGateway {
  constructor({ publicBaseUrl = 'http://localhost:4100', refundShouldFail = false } = {}) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
    this.refundShouldFail = refundShouldFail;
    this.name = 'FAKE';
  }

  async createCheckout({ paymentId, budget }) {
    return {
      preferenceId: `fake-pref-${paymentId}`,
      checkoutUrl: `${this.publicBaseUrl}/api/payments/order/${budget.orderId}/simulate?paymentId=${paymentId}`
    };
  }

  static providerPaymentId({ status, orderId, paymentId }) {
    return `fake_${status}_${orderId}_${paymentId}`;
  }

  async getPayment(providerPaymentId) {
    const match = /^fake_([a-z_]+?)_(\d+)_(.+)$/.exec(providerPaymentId);
    if (!match) {
      throw new PaymentGatewayError(`Pagamento fake inválido: ${providerPaymentId}`, { status: 404 });
    }
    const [, status, orderId, paymentId] = match;
    return {
      id: providerPaymentId,
      status,
      statusDetail: status === 'approved' ? 'accredited' : 'cc_rejected_other_reason',
      externalReference: `${orderId}:${paymentId}`,
      amount: null
    };
  }

  async refund(providerPaymentId) {
    if (this.refundShouldFail) {
      throw new PaymentGatewayError('Estorno recusado (simulado)', { status: 400 });
    }
    return { refundId: `fake-refund-${providerPaymentId}`, status: 'approved' };
  }
}

module.exports = FakePaymentGateway;
