const newrelic = require('newrelic');

// Propagação de Distributed Tracing (W3C traceparent/tracestate + newrelic) pelas
// mensagens SQS: o produtor injeta os headers no envelope e o consumidor os aceita
// numa background transaction — o New Relic liga HTTP → fila → outro serviço num
// único trace distribuído.
function currentTraceHeaders() {
  const headers = {};
  try {
    const transaction = newrelic.getTransaction();
    transaction?.insertDistributedTraceHeaders?.(headers);
  } catch {
    // agente desabilitado (testes/local): sem headers
  }
  return headers;
}

function runConsumerTransaction(name, traceHeaders, work) {
  return new Promise((resolve, reject) => {
    newrelic.startBackgroundTransaction(name, 'SQS', () => {
      const transaction = newrelic.getTransaction();
      try {
        if (traceHeaders && Object.keys(traceHeaders).length) {
          transaction?.acceptDistributedTraceHeaders?.('Queue', traceHeaders);
        }
      } catch {
        // headers inválidos não podem impedir o processamento da mensagem
      }
      Promise.resolve()
        .then(work)
        .then(resolve, (error) => {
          newrelic.noticeError(error);
          reject(error);
        })
        .finally(() => transaction?.end?.());
    });
  });
}

module.exports = {
  currentTraceHeaders,
  runConsumerTransaction
};
