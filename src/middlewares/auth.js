const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token necessário para autenticação.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    console.warn(`[Auth Middleware] JWT verification failed: ${error.message}`);
    return res.status(401).json({ message: 'Token inválido.' });
  }
}

function authorize(roles = []) {
  return (req, res, next) => {
    if (!roles.length || roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ message: 'Acesso negado.' });
  };
}

module.exports = {
  authenticate,
  authorize
};
