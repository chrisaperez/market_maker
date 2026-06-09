import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    username    TEXT UNIQUE COLLATE NOCASE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS markets (
    id                 TEXT PRIMARY KEY,
    creator_id         TEXT NOT NULL REFERENCES users(id),
    title              TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    buy_in_cents       INTEGER NOT NULL,
    shares_per_option  INTEGER NOT NULL,
    par_value_cents    INTEGER NOT NULL,
    window_seconds     INTEGER NOT NULL,
    status             TEXT NOT NULL DEFAULT 'lobby',
    opened_at          INTEGER,
    closes_at          INTEGER,
    winning_option_id  TEXT,
    created_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS market_options (
    id          TEXT PRIMARY KEY,
    market_id   TEXT NOT NULL REFERENCES markets(id),
    label       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_options_market ON market_options(market_id);

  CREATE TABLE IF NOT EXISTS memberships (
    market_id   TEXT NOT NULL REFERENCES markets(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL,
    status      TEXT NOT NULL,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (market_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

  CREATE TABLE IF NOT EXISTS orders (
    id          TEXT PRIMARY KEY,
    market_id   TEXT NOT NULL REFERENCES markets(id),
    option_id   TEXT NOT NULL REFERENCES market_options(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    side        TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    quantity    INTEGER NOT NULL,
    remaining   INTEGER NOT NULL,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    seq         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_book ON orders(market_id, option_id, status);

  CREATE TABLE IF NOT EXISTS trades (
    id           TEXT PRIMARY KEY,
    market_id    TEXT NOT NULL REFERENCES markets(id),
    option_id    TEXT NOT NULL REFERENCES market_options(id),
    buyer_id     TEXT NOT NULL REFERENCES users(id),
    seller_id    TEXT NOT NULL REFERENCES users(id),
    price_cents  INTEGER NOT NULL,
    shares       INTEGER NOT NULL,
    total_cents  INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id, timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_trades_option ON trades(option_id, timestamp_ms);

  CREATE TABLE IF NOT EXISTS positions (
    market_id  TEXT NOT NULL REFERENCES markets(id),
    user_id    TEXT NOT NULL REFERENCES users(id),
    option_id  TEXT NOT NULL REFERENCES market_options(id),
    shares     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (market_id, user_id, option_id)
  );

  CREATE TABLE IF NOT EXISTS balances (
    market_id   TEXT NOT NULL REFERENCES markets(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    cash_cents  INTEGER NOT NULL DEFAULT 0,
    funded      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (market_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS settlement_votes (
    market_id  TEXT NOT NULL REFERENCES markets(id),
    user_id    TEXT NOT NULL REFERENCES users(id),
    agree      INTEGER NOT NULL,
    voted_at   INTEGER NOT NULL,
    PRIMARY KEY (market_id, user_id)
  );

  -- Monotonic counter that gives every order a global sequence number,
  -- which is the tie-breaker that enforces strict FIFO (price-time priority).
  CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO counters(name, value) VALUES ('order_seq', 0);
`);

const nextSeqStmt = db.prepare(
  `UPDATE counters SET value = value + 1 WHERE name = 'order_seq' RETURNING value`,
);

/** Returns a strictly increasing sequence number for FIFO ordering. */
export function nextOrderSeq(): number {
  const row = nextSeqStmt.get() as { value: number };
  return row.value;
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Because the server is a single
 * Node process and node:sqlite is synchronous, the whole body executes
 * atomically with no interleaving — which is what keeps the ledger consistent.
 */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
