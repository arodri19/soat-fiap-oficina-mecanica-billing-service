const crypto = require('node:crypto');
const { Budget } = require('../../src/domain/Budget');
const { Payment } = require('../../src/domain/Payment');
const { ConcurrencyError } = require('../../src/infrastructure/persistence/DynamoBillingRepository');

// Mesma interface do DynamoBillingRepository, com as mesmas regras de
// condition expression (criação única e lock otimista por versão).
class InMemoryBillingRepository {
  constructor() {
    this.budgets = new Map();
    this.payments = new Map();
  }

  async createBudget(budget) {
    if (this.budgets.has(budget.orderId)) return false;
    this.budgets.set(budget.orderId, structuredClone({ ...budget }));
    return true;
  }

  async getBudget(orderId) {
    const row = this.budgets.get(Number(orderId));
    return row ? new Budget(structuredClone(row)) : null;
  }

  async saveBudget(budget) {
    const current = this.budgets.get(budget.orderId);
    if (!current || current.version !== budget.version) throw new ConcurrencyError('budget');
    budget.version += 1;
    this.budgets.set(budget.orderId, structuredClone({ ...budget }));
  }

  async createPayment(payment) {
    this.payments.set(`${payment.orderId}:${payment.paymentId}`, structuredClone({ ...payment }));
  }

  async getPayment(orderId, paymentId) {
    const row = this.payments.get(`${orderId}:${paymentId}`);
    return row ? new Payment(structuredClone(row)) : null;
  }

  async savePayment(payment) {
    const key = `${payment.orderId}:${payment.paymentId}`;
    const current = this.payments.get(key);
    if (!current || current.version !== payment.version) throw new ConcurrencyError('payment');
    payment.version += 1;
    this.payments.set(key, structuredClone({ ...payment }));
  }

  async listPayments(orderId) {
    return [...this.payments.values()]
      .filter((p) => p.orderId === Number(orderId))
      .map((p) => new Payment(structuredClone(p)));
  }

  async getOrderBilling(orderId) {
    return { budget: await this.getBudget(orderId), payments: await this.listPayments(orderId) };
  }

  async listPendingPayments() {
    return [...this.payments.values()].filter((p) => p.status === 'PENDING').map((p) => new Payment(structuredClone(p)));
  }

  async listBudgets({ status } = {}) {
    return [...this.budgets.values()].filter((b) => !status || b.status === status).map((b) => new Budget(structuredClone(b)));
  }
}

class RecordingBus {
  constructor() {
    this.published = [];
  }

  async publish(queue, envelope) {
    this.published.push({ queue, ...envelope });
  }

  last(type) {
    return [...this.published].reverse().find((m) => !type || m.type === type);
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };
const fakeTracing = { currentTraceHeaders: () => ({ traceparent: '00-billing' }) };

function fakeMonitoring() {
  return { events: [], recordBillingEvent(type, attrs) { this.events.push({ type, ...attrs }); } };
}

function command(type, payload = {}, overrides = {}) {
  return {
    messageId: crypto.randomUUID(),
    type,
    sagaId: 'saga-1',
    orderId: 42,
    correlationId: 'saga-1',
    replyTo: 'os-replies',
    source: 'os-service',
    payload,
    ...overrides
  };
}

const ITEMS = [
  { type: 'SERVICE', referenceId: 1, description: 'Troca de Óleo', quantity: 1, unitPrice: 80 },
  { type: 'PART', referenceId: 1, description: 'Óleo 5W40', quantity: 2, unitPrice: 45 }
];

module.exports = { InMemoryBillingRepository, RecordingBus, silentLogger, fakeTracing, fakeMonitoring, command, ITEMS };
