/**
 * Simple Server-Sent Events (SSE) push service.
 *
 * One persistent connection per seller, keyed by seller_id.
 * No external broker needed at MVP scale.
 *
 * If you later need multi-instance support on Render,
 * swap the in-memory Map for Redis pub/sub — the push() API stays identical.
 */

// Map<sellerId, Set<Response>>
const channels = new Map();

/**
 * Register a seller's SSE response object.
 * Call this from GET /seller/events.
 */
function subscribe(sellerId, res) {
  if (!channels.has(sellerId)) {
    channels.set(sellerId, new Set());
  }
  channels.get(sellerId).add(res);

  // Clean up when client disconnects
  res.on('close', () => {
    const conns = channels.get(sellerId);
    if (conns) {
      conns.delete(res);
      if (conns.size === 0) channels.delete(sellerId);
    }
  });
}

/**
 * Push an event to all open connections for a seller.
 * Silently skips if seller is offline.
 *
 * @param {string} sellerId
 * @param {string} event   - event name (e.g. 'payment_received')
 * @param {object} data    - payload, will be JSON-stringified
 */
function push(sellerId, event, data) {
  const conns = channels.get(sellerId);
  if (!conns || conns.size === 0) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of conns) {
    try {
      res.write(payload);
    } catch (err) {
      // Connection dropped mid-write — remove it
      conns.delete(res);
    }
  }
}

module.exports = { subscribe, push };
