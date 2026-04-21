const express = require('express');
const { withTransaction, pool } = require('../db/pool');
const { verifyMomoSignature, captureRawBody } = require('../middleware/webhookAuth');
const push = require('../services/push');

const router = express.Router();

/**
 * POST /webhook/momo
 *
 * Receives an incoming mobile money payment notification.
 * Steps:
 *   1. Verify HMAC signature (middleware)
 *   2. Idempotency check via momo_ref unique index
 *   3. Resolve seller from merchant code
 *   4. Match sender phone → customer
 *   5a. Match found  → atomic write + real-time push
 *   5b. No match     → park as unmatched + notify seller
 */
router.post(
  '/webhook/momo',
  captureRawBody,        // must come before verifyMomoSignature
  verifyMomoSignature,
  async (req, res) => {
    // Always return 200 quickly — the provider will retry on non-2xx
    const { momo_ref, sender_phone, amount_rwf, merchant_code } = req.body;

    // Basic payload validation
    if (!momo_ref || !sender_phone || !amount_rwf || !merchant_code) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!Number.isInteger(amount_rwf) || amount_rwf <= 0) {
      return res.status(400).json({ error: 'amount_rwf must be a positive integer' });
    }

    try {
      // ── Step 2: Idempotency check ────────────────────────────────────────
      // Check both tables — a momo_ref might already be in transaction (matched)
      // or unmatched_payment (parked). Either way, we've seen it.
      const dupCheck = await pool.query(
        `SELECT 1 FROM transaction        WHERE momo_ref = $1
         UNION ALL
         SELECT 1 FROM unmatched_payment  WHERE momo_ref = $1
         LIMIT 1`,
        [momo_ref]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(200).json({ status: 'already_processed' });
      }

      // ── Step 3: Resolve seller ────────────────────────────────────────────
      const sellerResult = await pool.query(
        'SELECT id FROM seller WHERE momo_merchant_code = $1',
        [merchant_code]
      );
      if (sellerResult.rows.length === 0) {
        // Unknown merchant code — not our webhook
        return res.status(404).json({ error: 'Unknown merchant code' });
      }
      const sellerId = sellerResult.rows[0].id;

      // ── Step 4: Match phone → customer ────────────────────────────────────
      const customerResult = await pool.query(
        `SELECT c.id AS customer_id, cv.id AS conversation_id
         FROM customer c
         JOIN conversation cv ON cv.customer_id = c.id
         WHERE c.seller_id = $1 AND c.phone = $2`,
        [sellerId, sender_phone]
      );

      if (customerResult.rows.length === 0) {
        // ── Step 5b: No match — park as unmatched ──────────────────────────
        await pool.query(
          `INSERT INTO unmatched_payment (seller_id, phone, amount_rwf, momo_ref)
           VALUES ($1, $2, $3, $4)`,
          [sellerId, sender_phone, amount_rwf, momo_ref]
        );

        // Notify seller of unknown incoming payment
        push.push(sellerId, 'unmatched_payment', {
          phone: sender_phone,
          amount_rwf,
          momo_ref,
          received_at: new Date().toISOString(),
        });

        return res.status(200).json({ status: 'parked' });
      }

      const { customer_id, conversation_id } = customerResult.rows[0];

      // ── Step 5a: Atomic write ─────────────────────────────────────────────
      const result = await withTransaction(async (client) => {
        // Insert transaction record
        const txnResult = await client.query(
          `INSERT INTO transaction
             (conversation_id, customer_id, kind, amount_rwf, source, momo_ref)
           VALUES ($1, $2, 'payment', $3, 'mobile_money', $4)
           RETURNING *`,
          [conversation_id, customer_id, amount_rwf, momo_ref]
        );
        const txn = txnResult.rows[0];

        // Update running balance counter
        const customerResult = await client.query(
          `UPDATE customer
           SET total_paid_rwf = total_paid_rwf + $1
           WHERE id = $2
           RETURNING total_paid_rwf, total_owed_rwf`,
          [amount_rwf, customer_id]
        );
        const customer = customerResult.rows[0];

        // Insert chat message linked to transaction
        const msgResult = await client.query(
          `INSERT INTO message
             (conversation_id, type, transaction_id)
           VALUES ($1, 'transaction', $2)
           RETURNING *`,
          [conversation_id, txn.id]
        );
        const message = msgResult.rows[0];

        // Bump conversation's last_activity_at for chat list ordering
        await client.query(
          `UPDATE conversation SET last_activity_at = now() WHERE id = $1`,
          [conversation_id]
        );

        return { txn, customer, message };
      });

      // ── Push real-time update (after commit) ──────────────────────────────
      push.push(sellerId, 'payment_received', {
        conversation_id,
        customer_id,
        message: {
          id: result.message.id,
          type: 'transaction',
          created_at: result.message.created_at,
          transaction: {
            id: result.txn.id,
            kind: 'payment',
            amount_rwf,
            source: 'mobile_money',
            note: result.txn.note ?? null,
          },
        },
        customer: {
          total_paid_rwf: result.customer.total_paid_rwf,
          total_owed_rwf: result.customer.total_owed_rwf,
        },
      });

      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook processing error:', err.message);
      // Return 500 so the provider retries — our idempotency check will deduplicate
      return res.status(500).json({ error: 'Processing error' });
    }
  }
);

module.exports = router;
