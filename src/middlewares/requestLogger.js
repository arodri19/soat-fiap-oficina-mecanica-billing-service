const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');
const newrelic = require('newrelic');

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  timestamp: pino.stdTimeFunctions.isoTime
});

// Cada linha de log carrega o requestId (correlação entre logs da mesma requisição)
// e os metadados de trace da New Relic (trace.id/span.id), para cruzar logs com APM
// mesmo sem usar o forwarder oficial deles.
const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = existing || crypto.randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customProps: () => newrelic.getLinkingMetadata(),
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  }
});

module.exports = { logger, requestLogger };
