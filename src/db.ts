import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    altegio_company_id TEXT NOT NULL UNIQUE,
    altegio_user_token TEXT NOT NULL,
    altegio_account_id TEXT NOT NULL,
    altegio_expense_id INTEGER NOT NULL DEFAULT 5,
    apipay_api_key TEXT NOT NULL,
    apipay_webhook_secret TEXT NOT NULL,
    title TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  -- Салоны, которые подключили приложение в Altegio, но ещё не настроены у нас
  -- (не заведены в tenants). Нужны, чтобы онбординг не терялся в логах.
  CREATE TABLE IF NOT EXISTS pending_salons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    altegio_company_id TEXT NOT NULL UNIQUE,
    events_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processed_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source, dedupe_key)
  );
`);

function hasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

// Миграция для баз, созданных до появления мультиарендности: связываем
// существующие записи с их арендатором по altegio_company_id.
if (!hasColumn("bookings", "tenant_id")) {
  db.exec("ALTER TABLE bookings ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bookings_tenant ON bookings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_invoice ON bookings(apipay_invoice_id);
`);
