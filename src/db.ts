import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    altegio_record_id TEXT NOT NULL UNIQUE,
    altegio_company_id TEXT NOT NULL,
    apipay_invoice_id TEXT UNIQUE,
    phone TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'invoice_created',
    altegio_marked_paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processed_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source, dedupe_key)
  );
`);
