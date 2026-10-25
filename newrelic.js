'use strict';

// Desabilitado em testes (NODE_ENV=test, setado automaticamente pelo Jest) para
// evitar que o agente tente conectar ao coletor da New Relic durante `npm test`.
// Fora de testes, pode ser desligado explicitamente com NEW_RELIC_ENABLED=false.
const isTestEnv = process.env.NODE_ENV === 'test';
const explicitlyDisabled = process.env.NEW_RELIC_ENABLED === 'false';

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'oficina-billing-service'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY || '',
  agent_enabled: !isTestEnv && !explicitlyDisabled && Boolean(process.env.NEW_RELIC_LICENSE_KEY),
  distributed_tracing: {
    enabled: true
  },
  logging: {
    // Os logs de aplicação já são estruturados e correlacionados via pino
    // (ver src/middlewares/requestLogger.js) — o agente só loga o próprio diagnóstico.
    level: 'info'
  },
  application_logging: {
    forwarding: {
      enabled: true
    }
  },
  allow_all_headers: true,
  attributes: {
    exclude: [
      'request.headers.authorization',
      'request.headers.cookie',
      'response.headers.set-cookie*'
    ]
  }
};
