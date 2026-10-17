const { DynamoBillingRepository, ConcurrencyError } = require('../../src/infrastructure/persistence/DynamoBillingRepository');
const { Budget } = require('../../src/domain/Budget');
const { Payment } = require('../../src/domain/Payment');
const { ITEMS } = require('../support/inMemory');

const conditionalFailure = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

function repoWith(send) {
  return new DynamoBillingRepository({ tableName: 'billing', documentClient: { send: jest.fn(send) } });
}

const budget = () => Budget.create({ budgetId: 'b', orderId: 42, sagaId: 's', items: ITEMS, now: new Date('2026-01-01T00:00:00Z') });
const payment = () => Payment.create({ paymentId: 'p', orderId: 42, budgetId: 'b', amount: 170, provider: 'FAKE', now: new Date('2026-01-02T00:00:00Z') });

describe('DynamoBillingRepository', () => {
  it('createBudget grava item com chaves da partição da OS e condição de criação única', async () => {
    const repo = repoWith(async () => ({}));
    await expect(repo.createBudget(budget())).resolves.toBe(true);
    const { input } = repo.client.send.mock.calls[0][0];
    expect(input).toMatchObject({
      TableName: 'billing',
      ConditionExpression: 'attribute_not_exists(pk)',
      Item: { pk: 'ORDER#42', sk: 'BUDGET', gsi1pk: 'BUDGET', gsi1sk: '2026-01-01T00:00:00.000Z', entityType: 'BUDGET', total: 170 }
    });
  });

  it('createBudget devolve false se já existe; outros erros propagam', async () => {
    await expect(repoWith(async () => { throw conditionalFailure(); }).createBudget(budget())).resolves.toBe(false);
    await expect(repoWith(async () => { throw new Error('throttled'); }).createBudget(budget())).rejects.toThrow('throttled');
  });

  it('getBudget/getPayment reconstroem entidades sem as chaves técnicas', async () => {
    const stored = { pk: 'ORDER#42', sk: 'BUDGET', gsi1pk: 'BUDGET', gsi1sk: 'x', entityType: 'BUDGET', ...budget() };
    const repo = repoWith(async () => ({ Item: stored }));
    const found = await repo.getBudget(42);
    expect(found).toBeInstanceOf(Budget);
    expect(found).not.toHaveProperty('pk');
    expect(repo.client.send.mock.calls[0][0].input).toMatchObject({ Key: { pk: 'ORDER#42', sk: 'BUDGET' }, ConsistentRead: true });

    const repoP = repoWith(async () => ({ Item: { pk: 'ORDER#42', sk: 'PAYMENT#p', ...payment() } }));
    expect(await repoP.getPayment(42, 'p')).toBeInstanceOf(Payment);
    expect(repoP.client.send.mock.calls[0][0].input.Key).toEqual({ pk: 'ORDER#42', sk: 'PAYMENT#p' });

    const empty = repoWith(async () => ({}));
    await expect(empty.getBudget(1)).resolves.toBeNull();
    await expect(empty.getPayment(1, 'x')).resolves.toBeNull();
  });

  it('save usa lock otimista e incrementa a versão', async () => {
    const repo = repoWith(async () => ({}));
    const b = budget();
    await repo.saveBudget(b);
    expect(b.version).toBe(1);
    expect(repo.client.send.mock.calls[0][0].input).toMatchObject({
      ConditionExpression: '#v = :expected',
      ExpressionAttributeValues: { ':expected': 0 },
      Item: { version: 1 }
    });

    const p = payment();
    await repo.createPayment(p);
    await repo.savePayment(p);
    expect(repo.client.send.mock.calls[1][0].input.Item).toMatchObject({ pk: 'ORDER#42', sk: 'PAYMENT#p', gsi1pk: 'PAYMENT' });
  });

  it('conflito de versão → ConcurrencyError; outros erros propagam', async () => {
    await expect(repoWith(async () => { throw conditionalFailure(); }).saveBudget(budget())).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(repoWith(async () => { throw new Error('boom'); }).savePayment(payment())).rejects.toThrow('boom');
  });

  it('getOrderBilling separa orçamento e pagamentos em ordem cronológica', async () => {
    const p1 = { pk: 'ORDER#42', sk: 'PAYMENT#a', ...payment(), paymentId: 'a', createdAt: '2026-01-03' };
    const p2 = { pk: 'ORDER#42', sk: 'PAYMENT#b', ...payment(), paymentId: 'b', createdAt: '2026-01-02' };
    const repo = repoWith(async () => ({ Items: [p1, { pk: 'ORDER#42', sk: 'BUDGET', ...budget() }, p2] }));
    const result = await repo.getOrderBilling(42);
    expect(result.budget.total).toBe(170);
    expect(result.payments.map((p) => p.paymentId)).toEqual(['b', 'a']);
    expect((await repo.listPayments(42))).toHaveLength(2);

    const none = repoWith(async () => ({}));
    await expect(none.getOrderBilling(1)).resolves.toEqual({ budget: null, payments: [] });
  });

  it('listBudgets consulta o GSI, com filtro opcional de status', async () => {
    const repo = repoWith(async () => ({ Items: [{ pk: 'ORDER#42', sk: 'BUDGET', ...budget() }] }));
    expect(await repo.listBudgets({ status: 'APPROVED' })).toHaveLength(1);
    expect(repo.client.send.mock.calls[0][0].input).toMatchObject({
      IndexName: 'gsi1', ScanIndexForward: false, FilterExpression: '#s = :status',
      ExpressionAttributeValues: { ':type': 'BUDGET', ':status': 'APPROVED' }
    });
    await repo.listBudgets();
    expect(repo.client.send.mock.calls[1][0].input).not.toHaveProperty('FilterExpression');
    expect(await repoWith(async () => ({})).listBudgets()).toEqual([]);
  });

  it('cria o DocumentClient real quando não injetado', () => {
    const repo = new DynamoBillingRepository({ tableName: 't', region: 'us-east-1', endpoint: 'http://localhost:4566' });
    expect(repo.client).toBeDefined();
    expect(new DynamoBillingRepository({ tableName: 't', region: 'us-east-1' }).client).toBeDefined();
  });
});
