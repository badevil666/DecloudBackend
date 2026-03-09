// ─────────────────────────────────────────────────────────────────────────────
// HTTP Request / Response Logger
// Mount after express.json() so req.body is already parsed.
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set(['signature', 'nonce', 'token', 'jwt', 'password', 'secret']);

const STATUS_LABEL = (code) => {
  if (code < 300) return '✔';
  if (code < 400) return '↪';
  if (code < 500) return '✘';
  return '💀';
};

const maskSensitive = (obj, depth = 0) => {
  if (depth > 4 || typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => maskSensitive(v, depth + 1));
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) =>
      SENSITIVE_KEYS.has(k.toLowerCase())
        ? [k, '***']
        : [k, maskSensitive(v, depth + 1)]
    )
  );
};

const fmt = (obj) => JSON.stringify(obj, null, 2)
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n');

const logger = (req, res, next) => {
  const start = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8).toUpperCase();

  // ── REQUEST ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  [${reqId}] ▶  ${req.method} ${req.originalUrl}`);
  console.log(`  IP: ${req.ip}   Time: ${new Date().toISOString()}`);

  const hasBody = req.body && Object.keys(req.body).length > 0;
  if (hasBody) {
    console.log(`  Body:`);
    console.log(fmt(maskSensitive(req.body)));
  }
  console.log(`${'─'.repeat(60)}`);

  // ── RESPONSE (intercept res.json) ────────────────────────────────────────
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const ms = Date.now() - start;
    const code = res.statusCode;
    const label = STATUS_LABEL(code);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  [${reqId}] ${label}  ${req.method} ${req.originalUrl}`);
    console.log(`  Status: ${code}   Duration: ${ms}ms`);

    if (body !== undefined) {
      console.log(`  Response:`);
      console.log(fmt(maskSensitive(body)));
    }
    console.log(`${'─'.repeat(60)}\n`);

    return originalJson(body);
  };

  next();
};

module.exports = logger;
