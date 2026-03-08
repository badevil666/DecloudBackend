// Logs request body and response body for every request.
// Mount after express.json() so req.body is already parsed.
const logger = (req, res, next) => {
  const start = Date.now();

  console.log(`\n→ ${req.method} ${req.originalUrl}`);
  if (req.body && Object.keys(req.body).length > 0) {
    // Mask sensitive fields before logging
    const masked = maskSensitive(req.body);
    console.log('  req.body:', JSON.stringify(masked, null, 2));
  }

  // Intercept res.json to capture the response body
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const ms = Date.now() - start;
    console.log(`← ${res.statusCode} ${req.method} ${req.originalUrl} (${ms}ms)`);
    if (body !== undefined) {
      console.log('  res.body:', JSON.stringify(body, null, 2));
    }
    return originalJson(body);
  };

  next();
};

const SENSITIVE_KEYS = new Set(['signature', 'nonce', 'token', 'password', 'secret']);

const maskSensitive = (obj) => {
  if (typeof obj !== 'object' || obj === null) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) =>
      SENSITIVE_KEYS.has(k.toLowerCase()) ? [k, '***'] : [k, v]
    )
  );
};

module.exports = logger;
