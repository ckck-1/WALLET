require('dotenv').config();
const { pool } = require('../src/db/pool');

const SQL = `
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── SELLER ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seller (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(120)  NOT NULL,
  phone               VARCHAR(20)   NOT NULL UNIQUE,
  momo_merchant_code  VARCHAR(40)   NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── CUSTOMER ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        UUID         NOT NULL REFERENCES seller(id) ON DELETE CASCADE,
  name             VARCHAR(120) NOT NULL,
  phone            VARCHAR(20)  NOT NULL,
  total_paid_rwf   INT          NOT NULL DEFAULT 0 CHECK (total_paid_rwf >= 0),
  total_owed_rwf   INT          NOT NULL DEFAULT 0 CHECK (total_owed_rwf >= 0),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (seller_id, phone)     -- one customer per phone per seller
);

-- ── CONVERSATION ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        UUID        NOT NULL REFERENCES seller(id) ON DELETE CASCADE,
  customer_id      UUID        NOT NULL UNIQUE REFERENCES customer(id) ON DELETE CASCADE,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── TRANSACTION ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transaction (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID         NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  customer_id     UUID         NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  kind            VARCHAR(10)  NOT NULL CHECK (kind IN ('payment', 'debt')),
  amount_rwf      INT          NOT NULL CHECK (amount_rwf > 0),
  note            VARCHAR(200),
  momo_ref        VARCHAR(80)  UNIQUE,          -- NULL for manual entries; UNIQUE prevents duplicate webhooks
  source          VARCHAR(20)  NOT NULL CHECK (source IN ('mobile_money', 'manual')),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── MESSAGE ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  sender_id       UUID,                          -- NULL = system / auto message
  type            VARCHAR(20) NOT NULL CHECK (type IN ('text', 'transaction')),
  body            TEXT,                          -- for type=text
  transaction_id  UUID        REFERENCES transaction(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── UNMATCHED_PAYMENT ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unmatched_payment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    UUID        NOT NULL REFERENCES seller(id) ON DELETE CASCADE,
  phone        VARCHAR(20) NOT NULL,
  amount_rwf   INT         NOT NULL CHECK (amount_rwf > 0),
  momo_ref     VARCHAR(80) NOT NULL UNIQUE,
  resolved_at  TIMESTAMPTZ,                      -- stamped when seller links it
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── INDEXES ───────────────────────────────────────────────────────────────
-- Hot path: phone → customer lookup on every webhook
CREATE INDEX IF NOT EXISTS idx_customer_phone_seller
  ON customer (seller_id, phone);

-- Chat thread: load messages in order
CREATE INDEX IF NOT EXISTS idx_message_conversation
  ON message (conversation_id, created_at);

-- Dashboard: open unmatched payments per seller
CREATE INDEX IF NOT EXISTS idx_unmatched_seller
  ON unmatched_payment (seller_id, resolved_at)
  WHERE resolved_at IS NULL;

-- Chat list: sort by most recent activity
CREATE INDEX IF NOT EXISTS idx_conversation_seller_activity
  ON conversation (seller_id, last_activity_at DESC);
`;

async function migrate() {
  console.log('Running migrations...');
  try {
    await pool.query(SQL);
    console.log('✓ All tables and indexes created');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
