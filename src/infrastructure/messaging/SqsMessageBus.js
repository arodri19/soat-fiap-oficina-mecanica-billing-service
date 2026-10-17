const {
  SQSClient,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} = require('@aws-sdk/client-sqs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Adaptador de mensageria sobre Amazon SQS (filas standard + DLQ por redrive policy,
 * provisionadas pelo Terraform de cada serviço).
 *
 * Semântica "at-least-once": a mensagem só é apagada da fila depois que o handler
 * conclui com sucesso. Se o handler lançar erro, a mensagem volta a ficar visível
 * após o visibility timeout e é reprocessada; depois de N tentativas (maxReceiveCount)
 * o SQS a move para a DLQ — os handlers precisam ser idempotentes.
 */
class SqsMessageBus {
  constructor({ region, endpoint, logger, client, waitTimeSeconds = 20, maxMessages = 10, visibilityTimeout = 30 }) {
    this.client = client || new SQSClient({ region, ...(endpoint ? { endpoint } : {}) });
    this.logger = logger;
    this.waitTimeSeconds = waitTimeSeconds;
    this.maxMessages = maxMessages;
    this.visibilityTimeout = visibilityTimeout;
    this.queueUrls = new Map();
    this.running = false;
    this.loops = [];
  }

  async resolveQueueUrl(queueName) {
    if (!this.queueUrls.has(queueName)) {
      const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      this.queueUrls.set(queueName, QueueUrl);
    }
    return this.queueUrls.get(queueName);
  }

  async publish(queueName, envelope) {
    const QueueUrl = await this.resolveQueueUrl(queueName);
    await this.client.send(new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageAttributes: {
        type: { DataType: 'String', StringValue: envelope.type },
        source: { DataType: 'String', StringValue: envelope.source || 'unknown' }
      }
    }));
  }

  subscribe(queueName, handler) {
    this.running = true;
    const loop = this.#poll(queueName, handler);
    this.loops.push(loop);
    return loop;
  }

  async stop() {
    this.running = false;
    await Promise.allSettled(this.loops);
  }

  async #poll(queueName, handler) {
    while (this.running) {
      try {
        const QueueUrl = await this.resolveQueueUrl(queueName);
        const { Messages = [] } = await this.client.send(new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: this.maxMessages,
          WaitTimeSeconds: this.waitTimeSeconds,
          VisibilityTimeout: this.visibilityTimeout,
          MessageSystemAttributeNames: ['ApproximateReceiveCount']
        }));

        for (const message of Messages) {
          await this.#process(QueueUrl, queueName, message, handler);
        }
      } catch (error) {
        this.logger.error({ err: error, queueName }, 'Erro ao consumir fila SQS — nova tentativa em 5s');
        await sleep(5000);
      }
    }
  }

  async #process(QueueUrl, queueName, message, handler) {
    let envelope;
    try {
      envelope = JSON.parse(message.Body);
    } catch {
      // Mensagem malformada nunca vai ser processada com sucesso — deixa ir para a DLQ.
      this.logger.error({ queueName, messageId: message.MessageId }, 'Mensagem SQS com JSON inválido');
      return;
    }

    try {
      await handler(envelope, {
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount || 1)
      });
      await this.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      this.logger.error(
        { err: error, queueName, type: envelope.type, messageId: envelope.messageId },
        'Falha ao processar mensagem — será reentregue pelo SQS'
      );
    }
  }
}

module.exports = SqsMessageBus;
