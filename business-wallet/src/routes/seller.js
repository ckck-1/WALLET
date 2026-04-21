const express = require('express');
const { pool } = require('../db/pool');
const push = require('../services/push');

const router = express.Router();

/**
 * GET /seller/:id/dashboard
 * Returns today's revenue, total owed, customer count, and recent transactions.
 * All reads — no joins on balance columns (they're running counters).
 */
router.get('/:id/dashboard', async (req, res) => {
  const { id: seller_id } = req.params;

  try {
    const [totals, recent, unmatched] = await Promise.all([
      // Totals across all customers
      pool.query(
        `SELECT
           COUNT(*)::int                         AS customer_count,
           COALESCE(SUM(total_paid_rwf), 0)::int AS total_paid_rwf,
           COALESCE(SUM(total_owed_rwf), 0)::int AS total_owed_rwf
         FROM customer
         WHERE seller_id = $1`,
        [seller_id]
      ),

      // Recent transactions (last 20) with customer name
      pool.query(
        `SELECT
           t.id,
           t.kind,
           t.amount_rwf,
           t.note,
           t.source,
           t.created_at,
           c.name AS customer_name,
           c.id   AS customer_id
         FROM transaction t
         JOIN customer c ON c.id = t.customer_id
         WHERE c.seller_id = $1
         ORDER BY t.created_at DESC
         LIMIT 20`,
        [seller_id]
      ),

      // Today's revenue (payments received today only)
      pool.query(
        `SELECT COALESCE(SUM(t.amount_rwf), 0)::int AS today_rwf
         FROM transaction t
         JOIN customer c ON c.id = t.customer_id
         WHERE c.seller_id = $1
           AND t.kind = 'payment'
           AND t.created_at >= CURRENT_DATE`,
        [seller_id]
      ),
    ]);

    return res.json({
      today_rwf:      unmatched.rows[0].today_rwf,
      total_paid_rwf: totals.rows[0].total_paid_rwf,
      total_owed_rwf: totals.rows[0].total_owed_rwf,
      customer_count: totals.rows[0].customer_count,
      recent_transactions: recent.rows,
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

/**
 * GET /seller/:id/events
 * Server-Sent Events stream for real-time updates.
 * The client connects once and receives push events as they happen.
 *
 * Events emitted:
 *   payment_received  — mobile money payment matched to a customer
 *   debt_recorded     — seller manually logged a debt
 *   unmatched_payment — payment arrived with unknown phone number
 */
router.get('/:id/events', (req, res) => {
  const { id: seller_id } = req.params;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Render
  res.flushHeaders();

  // Send a heartbeat every 30s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  res.on('close', () => clearInterval(heartbeat));

  // Register this connection in the push service
  push.subscribe(seller_id, res);
});

/**
 * GET /seller/:id/unmatched
 * Fetch all unresolved unmatched payments for a seller.
 */
router.get('/:id/unmatched', async (req, res) => {
  const { id: seller_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, phone, amount_rwf, momo_ref, received_at
       FROM unmatched_payment
       WHERE seller_id = $1 AND resolved_at IS NULL
       ORDER BY received_at DESC`,
      [seller_id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Unmatched payments error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch unmatched payments' });
  }
});

/**
 * POST /seller/:id/unmatched/:payment_id/resolve
 * Link an unmatched payment to an existing customer.
 * Body: { customer_id }
 *
 * Promotes the payment to a real TRANSACTION atomically.
 */
router.post('/:id/unmatched/:payment_id/resolve', async (req, res) => {
  const { id: seller_id, payment_id } = req.params;
  const { customer_id } = req.body;

  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id is required' });
  }

  const { withTransaction } = require('../db/pool');

  try {
    const result = await withTransaction(async (client) => {
      // Fetch the unmatched payment
      const pmtResult = await client.query(
        `SELECT * FROM unmatched_payment
         WHERE id = $1 AND seller_id = $2 AND resolved_at IS NULL`,
        [payment_id, seller_id]
      );
      if (pmtResult.rows.length === 0) {
        throw Object.assign(new Error('Not found'), { status: 404 });
      }
      const pmt = pmtResult.rows[0];

      // Get the customer's conversation
      const convResult = await client.query(
        `SELECT cv.id AS conversation_id
         FROM customer c
         JOIN conversation cv ON cv.customer_id = c.id
         WHERE c.id = $1 AND c.seller_id = $2`,
        [customer_id, seller_id]
      );
      if (convResult.rows.length === 0) {
        throw Object.assign(new Error('Customer not found'), { status: 404 });
      }
      const { conversation_id } = convResult.rows[0];

      // Insert the real transaction
      const txnResult = await client.query(
        `INSERT INTO transaction
           (conversation_id, customer_id, kind, amount_rwf, source, momo_ref)
         VALUES ($1, $2, 'payment', $3, 'mobile_money', $4)
         RETURNING *`,
        [conversation_id, customer_id, pmt.amount_rwf, pmt.momo_ref]
      );
      const txn = txnResult.rows[0];

      // Update customer balance
      const customerResult = await client.query(
        `UPDATE customer
         SET total_paid_rwf = total_paid_rwf + $1
         WHERE id = $2
         RETURNING total_paid_rwf, total_owed_rwf`,
        [pmt.amount_rwf, customer_id]
      );

      // Insert message card
      const msgResult = await client.query(
        `INSERT INTO message (conversation_id, type, transaction_id)
         VALUES ($1, 'transaction', $2)
         RETURNING *`,
        [conversation_id, txn.id]
      );

      // Stamp unmatched payment as resolved
      await client.query(
        `UPDATE unmatched_payment SET resolved_at = now() WHERE id = $1`,
        [payment_id]
      );

      await client.query(
        `UPDATE conversation SET last_activity_at = now() WHERE id = $1`,
        [conversation_id]
      );

      return {
        txn,
        customer: customerResult.rows[0],
        message: msgResult.rows[0],
        conversation_id,
        customer_id,
      };
    });

    // Push the resolved payment to the seller's chat
    push.push(seller_id, 'payment_received', {
      conversation_id: result.conversation_id,
      customer_id:     result.customer_id,
      message: {
        id:         result.message.id,
        type:       'transaction',
        created_at: result.message.created_at,
        transaction: {
          id:         result.txn.id,
          kind:       'payment',
          amount_rwf: result.txn.amount_rwf,
          source:     'mobile_money',
          note:       null,
        },
      },
      customer: result.customer,
    });

    return res.status(200).json({ status: 'resolved' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Resolve unmatched error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve payment' });
  }
});

module.exports = router;
