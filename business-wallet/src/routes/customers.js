const express = require('express');
const { withTransaction, pool } = require('../db/pool');

const router = express.Router();

/**
 * POST /customers
 * Create a customer and auto-create their conversation thread.
 * Body: { seller_id, name, phone }
 */
router.post('/', async (req, res) => {
  const { seller_id, name, phone } = req.body;

  if (!seller_id || !name || !phone) {
    return res.status(400).json({ error: 'seller_id, name, and phone are required' });
  }

  try {
    const result = await withTransaction(async (client) => {
      const customerResult = await client.query(
        `INSERT INTO customer (seller_id, name, phone)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [seller_id, name, phone]
      );
      const customer = customerResult.rows[0];

      const convResult = await client.query(
        `INSERT INTO conversation (seller_id, customer_id)
         VALUES ($1, $2)
         RETURNING *`,
        [seller_id, customer.id]
      );

      return { customer, conversation: convResult.rows[0] };
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json({ error: 'A customer with this phone number already exists' });
    }
    console.error('Create customer error:', err.message);
    return res.status(500).json({ error: 'Failed to create customer' });
  }
});

/**
 * GET /customers?seller_id=...
 * List all customers for a seller with their balances, sorted by recent activity.
 */
router.get('/', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const result = await pool.query(
      `SELECT
         c.id,
         c.name,
         c.phone,
         c.total_paid_rwf,
         c.total_owed_rwf,
         (c.total_paid_rwf - c.total_owed_rwf) AS net_rwf,
         c.created_at,
         cv.id          AS conversation_id,
         cv.last_activity_at
       FROM customer c
       JOIN conversation cv ON cv.customer_id = c.id
       WHERE c.seller_id = $1
       ORDER BY cv.last_activity_at DESC`,
      [seller_id]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('List customers error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

module.exports = router;
