const express = require('express');
const cors = require('cors');
const newrelic = require('newrelic');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./openapi.json');
const routes = require('./routes');
const { requestLogger } = require('./middlewares/requestLogger');

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'billing-service', uptime: process.uptime() });
});

app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(requestLogger);

app.use('/api-docs', (req, res, next) => {
  req.swaggerDoc = { ...swaggerSpec, servers: [{ url: `${req.protocol}://${req.get('host')}/api`, description: 'Servidor atual' }] };
  next();
}, swaggerUi.serveFiles(swaggerSpec), swaggerUi.setup());
app.use('/api', routes);

const STATUS_BY_ERROR = { ValidationError: 400, InvalidTransitionError: 409 };

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: 'JSON inválido no corpo da requisição.' });
  }
  if (STATUS_BY_ERROR[err.name]) {
    return res.status(STATUS_BY_ERROR[err.name]).json({ message: err.message });
  }
  req.log?.error({ err }, 'Erro não tratado');
  newrelic.noticeError(err, { path: req.originalUrl, method: req.method });
  return res.status(500).json({ message: 'Erro interno do servidor.' });
});

module.exports = app;
