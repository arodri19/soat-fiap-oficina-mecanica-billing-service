const { InvalidTransitionError } = require('./errors');

const PaymentStatus = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
  REFUND_FAILED: 'REFUND_FAILED'
});

const TRANSITIONS = Object.freeze({
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['REFUNDED', 'REFUND_FAILED'],
  REFUND_FAILED: ['REFUNDED'],
  REJECTED: [],
  CANCELLED: [],
  REFUNDED: []
});

/**
 * Cobrança de um orçamento aprovado via Mercado Pago (Checkout Pro).
 * external_reference da preferência = "<orderId>:<paymentId>" — é o que liga a
 * notificação (webhook) do Mercado Pago de volta a este registro.
 */
class Payment {
  constructor(props) {
    Object.assign(this, { history: [], version: 0, providerPaymentId: null, statusDetail: null, ...props });
  }

  static create({ paymentId, orderId, budgetId, amount, provider, preferenceId, checkoutUrl, now = new Date() }) {
    const at = now.toISOString();
    return new Payment({
      paymentId,
      orderId: Number(orderId),
      budgetId,
      amount,
      provider,
      preferenceId,
      checkoutUrl,
      status: PaymentStatus.PENDING,
      createdAt: at,
      updatedAt: at,
      history: [{ status: PaymentStatus.PENDING, at }]
    });
  }

  static externalReference(orderId, paymentId) {
    return `${orderId}:${paymentId}`;
  }

  static parseExternalReference(reference) {
    const [orderId, paymentId] = String(reference || '').split(':');
    if (!orderId || !paymentId || !Number.isInteger(Number(orderId))) return null;
    return { orderId: Number(orderId), paymentId };
  }

  canTransitionTo(status) {
    return TRANSITIONS[this.status].includes(status);
  }

  #transition(status, now, detail) {
    if (!this.canTransitionTo(status)) {
      throw new InvalidTransitionError(`Pagamento ${this.paymentId}: ${this.status} → ${status} inválido.`);
    }
    const at = (now || new Date()).toISOString();
    this.status = status;
    this.updatedAt = at;
    if (detail) this.statusDetail = detail;
    this.history = [...this.history, { status, at, ...(detail ? { detail } : {}) }];
  }

  markApproved(providerPaymentId, now) {
    this.providerPaymentId = providerPaymentId;
    this.#transition(PaymentStatus.APPROVED, now);
  }

  markRejected(providerPaymentId, detail, now) {
    this.providerPaymentId = providerPaymentId || this.providerPaymentId;
    this.#transition(PaymentStatus.REJECTED, now, detail);
  }

  markCancelled(reason, now) {
    this.#transition(PaymentStatus.CANCELLED, now, reason);
  }

  markRefunded(now) {
    this.#transition(PaymentStatus.REFUNDED, now);
  }

  markRefundFailed(reason, now) {
    this.#transition(PaymentStatus.REFUND_FAILED, now, reason);
  }

  isPending() {
    return this.status === PaymentStatus.PENDING;
  }

  isApproved() {
    return this.status === PaymentStatus.APPROVED;
  }
}

module.exports = { Payment, PaymentStatus };
