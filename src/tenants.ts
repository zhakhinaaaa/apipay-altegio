import { config } from "./config";
import { db } from "./db";
import { verifySignature } from "./signature";

/**
 * Арендатор — одна связка «салон Altegio ↔ аккаунт ApiPay».
 * Все вебхуки приходят на общие адреса, а разделяются по этой таблице.
 */
export interface Tenant {
  id: number;
  altegio_company_id: string;
  altegio_user_token: string;
  altegio_account_id: string;
  altegio_expense_id: number;
  apipay_api_key: string;
  apipay_webhook_secret: string;
  title: string | null;
  active: number;
}

export function findByCompanyId(companyId: string | number): Tenant | undefined {
  return db
    .prepare("SELECT * FROM tenants WHERE altegio_company_id = ? AND active = 1")
    .get(String(companyId)) as Tenant | undefined;
}

export function findById(id: number): Tenant | undefined {
  return db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Tenant | undefined;
}

export function listActive(): Tenant[] {
  return db
    .prepare("SELECT * FROM tenants WHERE active = 1 ORDER BY id")
    .all() as unknown as Tenant[];
}

/**
 * Определяет арендатора по подписи вебхука ApiPay: перебирает секреты активных
 * арендаторов и возвращает того, чей секрет даёт совпадение.
 *
 * Так мы ни на секунду не доверяем телу запроса до проверки подписи — в отличие
 * от варианта «прочитать invoice_id, найти арендатора, потом проверить».
 */
export function findByApipaySignature(raw: Buffer, header: string | undefined): Tenant | undefined {
  if (!header) return undefined;
  return listActive().find((t) => verifySignature(raw, header, t.apipay_webhook_secret));
}

export interface TenantInput {
  altegioCompanyId: string;
  altegioUserToken: string;
  altegioAccountId: string;
  altegioExpenseId?: number;
  apipayApiKey: string;
  /**
   * Устарело: вебхук ApiPay теперь один на всё приложение, и секрет к нему
   * общий (`APIPAY_WEBHOOK_SECRET`). Поле осталось для салонов, заведённых
   * со своим секретом до перехода.
   */
  apipayWebhookSecret?: string;
  title?: string;
}

/** Добавляет арендатора или обновляет существующего по altegio_company_id. */
export function upsert(input: TenantInput): Tenant {
  db.prepare(
    `INSERT INTO tenants
       (altegio_company_id, altegio_user_token, altegio_account_id, altegio_expense_id,
        apipay_api_key, apipay_webhook_secret, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(altegio_company_id) DO UPDATE SET
       altegio_user_token   = excluded.altegio_user_token,
       altegio_account_id   = excluded.altegio_account_id,
       altegio_expense_id   = excluded.altegio_expense_id,
       apipay_api_key       = excluded.apipay_api_key,
       apipay_webhook_secret= excluded.apipay_webhook_secret,
       title                = COALESCE(excluded.title, tenants.title),
       active               = 1,
       updated_at           = datetime('now')`
  ).run(
    input.altegioCompanyId,
    input.altegioUserToken,
    input.altegioAccountId,
    input.altegioExpenseId ?? 5,
    input.apipayApiKey,
    input.apipayWebhookSecret ?? "",
    input.title ?? null
  );

  clearPendingSalon(input.altegioCompanyId);
  return findByCompanyId(input.altegioCompanyId)!;
}

/** Салон отключил приложение в Altegio — перестаём его обслуживать. */
export function deactivate(companyId: string | number): boolean {
  const res = db
    .prepare(
      "UPDATE tenants SET active = 0, updated_at = datetime('now') WHERE altegio_company_id = ? AND active = 1"
    )
    .run(String(companyId));
  return Number(res.changes) > 0;
}

/**
 * Первый запуск после перехода на мультиарендность: если в .env заданы значения
 * старой одно-салонной конфигурации, заводим из них арендатора. Уже существующую
 * строку не трогаем — .env перестаёт быть источником правды после первого запуска.
 */
export function seedFromEnv(): Tenant | undefined {
  const { altegio, apipay } = config;
  if (!altegio.companyId || !altegio.userToken || !apipay.apiKey || !apipay.webhookSecret) {
    return undefined;
  }
  if (findByCompanyId(altegio.companyId)) return undefined;

  return upsert({
    altegioCompanyId: String(altegio.companyId),
    altegioUserToken: altegio.userToken,
    altegioAccountId: String(altegio.accountId),
    altegioExpenseId: altegio.expenseId,
    apipayApiKey: apipay.apiKey,
    apipayWebhookSecret: apipay.webhookSecret,
    title: "Импортирован из .env",
  });
}

export interface PendingSalon {
  id: number;
  altegio_company_id: string;
  events_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Салон прислал событие, но у нас не настроен. Запоминаем его, чтобы было видно,
 * кого нужно подключить — иначе такой салон теряется в логах.
 */
export function notePendingSalon(companyId: string | number): void {
  db.prepare(
    `INSERT INTO pending_salons (altegio_company_id, events_count)
     VALUES (?, 1)
     ON CONFLICT(altegio_company_id) DO UPDATE SET
       events_count = pending_salons.events_count + 1,
       last_seen_at = datetime('now')`
  ).run(String(companyId));
}

export function listPendingSalons(): PendingSalon[] {
  return db
    .prepare("SELECT * FROM pending_salons ORDER BY last_seen_at DESC")
    .all() as unknown as PendingSalon[];
}

/** Салон настроен — из списка ожидающих убираем. */
export function clearPendingSalon(companyId: string | number): void {
  db.prepare("DELETE FROM pending_salons WHERE altegio_company_id = ?").run(String(companyId));
}

/** Проставляет tenant_id записям, заведённым до перехода на мультиарендность. */
export function backfillBookings(): number {
  const result = db
    .prepare(
      `UPDATE bookings
          SET tenant_id = (SELECT id FROM tenants WHERE tenants.altegio_company_id = bookings.altegio_company_id)
        WHERE tenant_id IS NULL`
    )
    .run();
  return Number(result.changes);
}
