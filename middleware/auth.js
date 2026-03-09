const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Auth middleware factory.
 * Reads JWT from req.body.jwt, verifies it, and attaches decoded payload to req.user.
 *
 * @param {string|null} requiredRole - 'CLIENT' | 'STORAGE_PEER' | null (any authenticated role)
 */
const authenticate = (requiredRole = null) => (req, res, next) => {
  // Accept token from body (POST) or Authorization: Bearer <token> header (GET)
  const authHeader = req.headers.authorization;
  const token =
    req.body?.token ||
    (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'JWT required (body.token or Authorization: Bearer <token>)' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired JWT' });
  }

  if (requiredRole && decoded.role !== requiredRole) {
    return res.status(403).json({ error: `Access denied: ${requiredRole} role required` });
  }

  req.user = decoded; // { sub, role, wallet_address }
  next();
};

module.exports = authenticate;
