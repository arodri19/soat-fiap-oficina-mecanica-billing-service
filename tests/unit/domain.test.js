const { Budget, BudgetStatus } = require('../../src/domain/Budget');
const { Payment, PaymentStatus } = require('../../src/domain/Payment');
const { ValidationError, InvalidTransitionError } = require('../../src/domain/errors');
const { ITEMS } = require('../support/inMemory');

describe('Budget', () => {
  const create = (overrides = {}) => Budget.create({ budgetId: 'b', orderId: 1, sagaId: 's', items: ITEMS, ...overrides });

  it('calcula totais por item e geral, arredondando centavos', () => {
    const budget = create({ items: [{ type: 'PART', referenceId: 1, quantity: 3, unitPrice: 0.1 }] });
    expect(budget.items[0]).toMatchObject({ total: 0.3, description: 'PART 1' });
    expect(budget.total).toBe(0.3);
    expect(budget.status).toBe(BudgetStatus.PENDING_APPROVAL);
    expect(budget.history).toHaveLength(1);
    expect(budget).toMatchObject({ externalId: null, replyTo: null, customer: null });
  });

  it.each([
    [{ items: [] }, 'ao menos um item'],
    [{ items: null }, 'ao menos um item'],
    [{ items: [{ type: 'X', quantity: 1, unitPrice: 1 }] }, 'type inválido'],
    [{ items: [{ type: 'PART', quantity: 0, unitPrice: 1 }] }, 'quantity'],
    [{ items: [{ type: 'PART', quantity: 1, unitPrice: -1 }] }, 'unitPrice'],
    [{ items: [{ type: 'SERVICE', quantity: 1, unitPrice: 0 }] }, 'maior que zero'],
    [{ orderId: 'abc' }, 'orderId']
  ])('valida %j', (overrides, message) => {
    expect(() => create(overrides)).toThrow(ValidationError);
    expect(() => create(overrides)).toThrow(message);
  });

  it('aprova só pendente; cancelamento é idempotente', () => {
    const budget = create();
    budget.approve();
    expect(budget.status).toBe('APPROVED');
    expect(() => budget.approve()).toThrow(InvalidTransitionError);
    expect(budget.cancel('x')).toBe(true);
    expect(budget.cancel('y')).toBe(false);
    expect(budget.cancelReason).toBe('x');
    expect(budget.history.map((h) => h.status)).toEqual(['PENDING_APPROVAL', 'APPROVED', 'CANCELLED']);
  });

  it('cancelamento sem motivo', () => {
    const budget = create();
    budget.cancel();
    expect(budget.cancelReason).toBeNull();
    expect(budget.history[1]).not.toHaveProperty('note');
  });
});

describe('Payment', () => {
  const create = () => Payment.create({ paymentId: 'p', orderId: '7', budgetId: 'b', amount: 10, provider: 'FAKE', preferenceId: 'pref', checkoutUrl: 'url' });

  it('external reference ida e volta', () => {
    expect(Payment.externalReference(7, 'p')).toBe('7:p');
    expect(Payment.parseExternalReference('7:p')).toEqual({ orderId: 7, paymentId: 'p' });
    expect(Payment.parseExternalReference('x:p')).toBeNull();
    expect(Payment.parseExternalReference(undefined)).toBeNull();
    expect(Payment.parseExternalReference('7')).toBeNull();
  });

  it('PENDING → APPROVED → REFUND_FAILED → REFUNDED', () => {
    const payment = create();
    expect(payment.orderId).toBe(7);
    payment.markApproved('mp-1');
    expect(payment.isApproved()).toBe(true);
    payment.markRefundFailed('prazo');
    expect(payment.statusDetail).toBe('prazo');
    payment.markRefunded();
    expect(payment.status).toBe(PaymentStatus.REFUNDED);
    expect(() => payment.markApproved('x')).toThrow(InvalidTransitionError);
  });

  it('rejeição e cancelamento só a partir de PENDING', () => {
    const rejected = create();
    rejected.markRejected(null, 'cc_rejected');
    expect(rejected).toMatchObject({ status: 'REJECTED', statusDetail: 'cc_rejected', providerPaymentId: null });
    const cancelled = create();
    cancelled.markCancelled();
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.isPending()).toBe(false);
    expect(() => cancelled.markRefunded()).toThrow(/CANCELLED → REFUNDED/);
  });
});
