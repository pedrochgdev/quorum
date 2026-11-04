// SQLite through Node's built-in driver (node:sqlite). No external dependencies.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

type Param = string | number | bigint | null | Uint8Array;
type Row = Record<string, any>;

let db: DatabaseSync | null = null;

export function openDb(file?: string) {
  if (db) return db;
  const path = file ?? (config.dbFile || join(config.dataDir, 'quorum.db'));
  if (path !== ':memory:') mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

const conn = () => db ?? openDb();

export const all = <T = Row>(sql: string, ...params: Param[]) => conn().prepare(sql).all(...params) as T[];
export const get = <T = Row>(sql: string, ...params: Param[]) => conn().prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: Param[]) => conn().prepare(sql).run(...params);

export function tx<T>(fn: () => T): T {
  const c = conn();
  c.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    c.exec('COMMIT');
    return out;
  } catch (err) {
    c.exec('ROLLBACK');
    throw err;
  }
}

function migrate(d: DatabaseSync) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    paypal_email TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    list_price REAL NOT NULL,
    floor_price REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    tiers_json TEXT NOT NULL,
    embedding_json TEXT,
    paypal_catalog_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quorums (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    merchant_id TEXT NOT NULL REFERENCES merchants(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','negotiating','settling','closed','failed')),
    min_members INTEGER NOT NULL,
    closes_at TEXT NOT NULL,
    final_price REAL,
    market_json TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS quorums_status ON quorums(status, closes_at);

  CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    email TEXT,
    text TEXT NOT NULL,
    parsed_json TEXT NOT NULL,
    category TEXT NOT NULL,
    max_price REAL,
    deadline TEXT,
    embedding_json TEXT NOT NULL,
    quorum_id TEXT REFERENCES quorums(id),
    status TEXT NOT NULL CHECK (status IN ('grouped','waiting','committed')),
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS intents_status ON intents(status, category);

  CREATE TABLE IF NOT EXISTS commitments (
    id TEXT PRIMARY KEY,
    quorum_id TEXT NOT NULL REFERENCES quorums(id),
    intent_id TEXT REFERENCES intents(id),
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('paypal','mock')),
    paypal_order_id TEXT UNIQUE,
    authorization_id TEXT,
    authorized_amount REAL NOT NULL,
    captured_amount REAL,
    capture_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('created','authorized','captured','voided','failed')),
    failure_reason TEXT,
    referrer_id TEXT REFERENCES commitments(id),
    authorized_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS commitments_quorum ON commitments(quorum_id, status);

  CREATE TABLE IF NOT EXISTS negotiations (
    id TEXT PRIMARY KEY,
    quorum_id TEXT NOT NULL REFERENCES quorums(id),
    turns_json TEXT NOT NULL,
    final_price REAL,
    status TEXT NOT NULL,
    engine TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    quorum_id TEXT NOT NULL REFERENCES quorums(id),
    commitment_id TEXT NOT NULL REFERENCES commitments(id),
    amount REAL NOT NULL,
    batch_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    ref_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    ref_id TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    engine TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Simulated PayPal ledger, used only when PAYPAL_MODE=mock or for seeded demo buyers.
  CREATE TABLE IF NOT EXISTS mock_paypal (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    parent_id TEXT,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    payer_email TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `);
}
