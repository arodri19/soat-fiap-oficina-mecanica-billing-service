const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand
} = require('@aws-sdk/lib-dynamodb');
const { Budget } = require('../../domain/Budget');
const { Payment } = require('../../domain/Payment');

class ConcurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConcurrencyError';
  }
}

const isConditionalFailure = (error) => error?.name === 'ConditionalCheckFailedException';

/**
 * Persistência do billing no DynamoDB (NoSQL) — single-table design:
 *
 *   pk = ORDER#<orderId>   sk = BUDGET                → orçamento da OS (1 por OS)
 *   pk = ORDER#<orderId>   sk = PAYMENT#<paymentId>   → cobranças da OS
 *   gsi1pk = BUDGET | PAYMENT, gsi1sk = createdAt     → listagens cronológicas
 *
 * Tudo que pertence a uma OS fica na mesma partição: uma única Query traz
 * orçamento + pagamentos (consulta consolidada usada pelo os-service via REST).
 * Escritas usam condition expressions: criação só se não existir (idempotência
 * de comandos reentregues) e atualização só na versão lida (lock otimista).
 */
class DynamoBillingRepository {
  constructor({ tableName, region, endpoint, documentClient }) {
    this.tableName = tableName;
    this.client = documentClient || DynamoDBDocumentClient.from(
      new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) }),
      { marshallOptions: { removeUndefinedValues: true } }
    );
  }

  static budgetKey(orderId) {
    return { pk: `ORDER#${orderId}`, sk: 'BUDGET' };
  }

  static paymentKey(orderId, paymentId) {
    return { pk: `ORDER#${orderId}`, sk: `PAYMENT#${paymentId}` };
  }

  #toItem(entity, key, type) {
    const { history, ...rest } = entity;
    return { ...key, gsi1pk: type, gsi1sk: entity.createdAt, entityType: type, ...rest, history };
  }

  static #strip(item) {
    const { pk, sk, gsi1pk, gsi1sk, entityType, ...rest } = item;
    return rest;
  }

  async #put(item, { create, expectedVersion }) {
    const params = { TableName: this.tableName, Item: item };
    if (create) {
      params.ConditionExpression = 'attribute_not_exists(pk)';
    } else {
      params.ConditionExpression = '#v = :expected';
      params.ExpressionAttributeNames = { '#v': 'version' };
      params.ExpressionAttributeValues = { ':expected': expectedVersion };
    }
    await this.client.send(new PutCommand(params));
  }

  // true = criado agora; false = já existia (comando reentregue)
  async createBudget(budget) {
    try {
      await this.#put(this.#toItem(budget, DynamoBillingRepository.budgetKey(budget.orderId), 'BUDGET'), { create: true });
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async getBudget(orderId) {
    const { Item } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: DynamoBillingRepository.budgetKey(orderId),
      ConsistentRead: true
    }));
    return Item ? new Budget(DynamoBillingRepository.#strip(Item)) : null;
  }

  async saveBudget(budget) {
    await this.#save(budget, DynamoBillingRepository.budgetKey(budget.orderId), 'BUDGET');
  }

  async createPayment(payment) {
    await this.#put(this.#toItem(payment, DynamoBillingRepository.paymentKey(payment.orderId, payment.paymentId), 'PAYMENT'), { create: true });
  }

  async getPayment(orderId, paymentId) {
    const { Item } = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: DynamoBillingRepository.paymentKey(orderId, paymentId),
      ConsistentRead: true
    }));
    return Item ? new Payment(DynamoBillingRepository.#strip(Item)) : null;
  }

  async savePayment(payment) {
    await this.#save(payment, DynamoBillingRepository.paymentKey(payment.orderId, payment.paymentId), 'PAYMENT');
  }

  async #save(entity, key, type) {
    const expectedVersion = entity.version;
    const item = this.#toItem({ ...entity, version: expectedVersion + 1 }, key, type);
    try {
      await this.#put(item, { create: false, expectedVersion });
      entity.version = expectedVersion + 1;
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new ConcurrencyError(`${type} ${key.pk}/${key.sk} alterado concorrentemente (versão ${expectedVersion}).`);
      }
      throw error;
    }
  }

  async getOrderBilling(orderId) {
    const { Items = [] } = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `ORDER#${orderId}` },
      ConsistentRead: true
    }));
    const budgetItem = Items.find((item) => item.sk === 'BUDGET');
    return {
      budget: budgetItem ? new Budget(DynamoBillingRepository.#strip(budgetItem)) : null,
      payments: Items
        .filter((item) => item.sk.startsWith('PAYMENT#'))
        .map((item) => new Payment(DynamoBillingRepository.#strip(item)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    };
  }

  async listPayments(orderId) {
    return (await this.getOrderBilling(orderId)).payments;
  }

  async listBudgets({ status, limit = 50 } = {}) {
    const params = {
      TableName: this.tableName,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :type',
      ExpressionAttributeValues: { ':type': 'BUDGET' },
      ScanIndexForward: false,
      Limit: limit
    };
    if (status) {
      params.FilterExpression = '#s = :status';
      params.ExpressionAttributeNames = { '#s': 'status' };
      params.ExpressionAttributeValues[':status'] = status;
    }
    const { Items = [] } = await this.client.send(new QueryCommand(params));
    return Items.map((item) => new Budget(DynamoBillingRepository.#strip(item)));
  }
}

module.exports = { DynamoBillingRepository, ConcurrencyError };
