const crypto = require('crypto');

/**
 * Verifies the HMAC-SHA256 signature sent by the MoMo provider.
 * Must run BEFORE body parsing so we have access to the raw buffer.
 *
 * The provider signs the raw request body with the shared secret and
 * sends the hex digest in the X-Momo-Signature header.
 */
function verifyMomoSignature(req, res, next) {
  const signature = req.headers['x-momo-signature'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  const secret = process.env.MOMO_WEBHOOK_SECRET;
  if (!secret) {
    console.error('MOMO_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody) // rawBody is attached by the raw body capture middleware below
    .digest('hex');

  // Constant-time comparison prevents timing attacks
  const sigBuffer      = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  next();
}

/**
 * Express middleware to capture the raw request body as a Buffer.
 * Attach to the webhook route BEFORE express.json().
 * This is necessary because express.json() consumes the stream.
 */
function captureRawBody(req, res, next) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    // Also parse JSON from the buffer so downstream handlers get req.body
    try {
      req.body = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      req.body = {};
    }
    next();
  });
  req.on('error', next);
}

module.exports = { verifyMomoSignature, captureRawBody };
