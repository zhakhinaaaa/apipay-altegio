import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { BookingError, createInvoiceForRecord } from "../booking";
import * as tenants from "../tenants";
import type { Tenant } from "../tenants";
import { createSession, extractCompanyId } from "../setup";

interface AltegioEvent {
  company_id?: number;
  resource?: string;
  resource_id?: number;
  status?: string;
  data?: { id?: number; attendance?: number; deleted?: boolean };
}

/** Значения, по которым Altegio опознаёт салон, безопасны для лога; остальное маскируем. */
const SAFE_KEYS = new Set([
  "salon_id",
  "company_id",
  "application_id",
  "app_id",
  "partner_id",
  "user_id",
  "state",
  "lang",
]);

/**
 * Показывает форму параметров, не раскрывая токены: имена ключей видны целиком,
 * значения — только у заведомо несекретных.
 */
function describeParams(source: unknown): Record<string, string> | undefined {
  if (!source || typeof source !== "object") return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const text = value === null || value === undefined ? "" : String(value);
    out[key] = SAFE_KEYS.has(key.toLowerCase())
      ? text
      : `<${text.length} символов>`;
  }
  return out;
}

/**
 * Состав `user_data` из редиректа Altegio: имена полей видны, значения — нет.
 * В каком виде Altegio его кодирует, документации нет, поэтому пробуем
 * несколько вариантов; если не поддалось — показываем начало строки, по нему
 * видно кодировку (`eyJ` — base64 от JSON, `%7B` — JSON в URL-кодировке).
 */
function describeUserData(query: unknown): Record<string, string> | string | undefined {
  const raw = (query as Record<string, unknown> | undefined)?.user_data;
  if (typeof raw !== "string" || !raw) return undefined;

  const candidates = [
    () => raw,
    () => Buffer.from(raw, "base64").toString("utf8"),
    () => decodeURIComponent(raw),
    () => Buffer.from(raw, "base64url").toString("utf8"),
  ];

  for (const decode of candidates) {
    try {
      const parsed = JSON.parse(decode());
      if (parsed && typeof parsed === "object") return describeParams(parsed);
    } catch {
      // Следующий вариант.
    }
  }
  return `<не разобрано, ${raw.length} символов, начинается с ${raw.slice(0, 12)}>`;
}

/** true — событие новое, false — уже обрабатывали. */
function claimEvent(dedupeKey: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO processed_webhooks (source, dedupe_key) VALUES (?, ?)")
    .run("altegio", dedupeKey);
  return Number(result.changes) > 0;
}

export const altegioWebhookRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Altegio ведёт сюда после согласия на подключение приложения к филиалу
  // (Registration Redirect Url). Отсюда салон уходит на страницу настройки:
  // одноразовая ссылка выдаётся только тому, кто прямо сейчас подключил приложение.
  app.all("/altegio/install", async (req, reply) => {
    const companyId = extractCompanyId(req.query, req.body);

    req.log.info(
      {
        method: req.method,
        companyId: companyId ?? null,
        query: describeParams(req.query),
        body: describeParams(req.body),
        // Altegio кладёт сюда данные подключившего салона одной строкой.
        // Разбираем, чтобы увидеть состав полей: вдруг там есть токен, под
        // которым можно читать кассы. Значения по-прежнему маскируются.
        userData: describeUserData(req.query),
      },
      "altegio: установка приложения в филиал"
    );

    const session = createSession(companyId);
    // Адрес относительный: работает и без заданного PUBLIC_BASE_URL.
    return reply.redirect(`/setup/${session.token}`, 302);
  });

  // Altegio дёргает этот адрес при отключении интеграции (Callback Url).
  // Салон отключился — перестаём обслуживать его записи.
  app.all("/altegio/uninstall", async (req, reply) => {
    const companyId = extractCompanyId(req.query, req.body);
    const deactivated = companyId ? tenants.deactivate(companyId) : false;

    req.log.warn(
      {
        method: req.method,
        companyId: companyId ?? null,
        deactivated,
        query: describeParams(req.query),
        body: describeParams(req.body),
      },
      "altegio: интеграция отключена"
    );
    return reply.code(200).send({ ok: true });
  });

  // Altegio проверяет адрес GET-запросом перед сохранением настройки.
  app.get("/webhooks/altegio", async () => ({ ok: true, endpoint: "altegio" }));

  app.post("/webhooks/altegio", async (req, reply) => {
    const payload = req.body as AltegioEvent | AltegioEvent[];
    const events = Array.isArray(payload) ? payload : [payload];

    // Altegio ждёт быстрый 200; работу делаем после ответа.
    for (const event of events) {
      if (event.resource !== "record") continue;
      if (event.status !== "create" && event.status !== "update") continue;

      const recordId = String(event.resource_id ?? event.data?.id ?? "");
      if (!recordId) continue;

      // Салон определяем по company_id из события — так один адрес вебхука
      // обслуживает сколько угодно подключённых салонов.
      const companyId = event.company_id;
      if (!companyId) {
        req.log.warn({ recordId }, "altegio webhook: в событии нет company_id");
        continue;
      }

      const tenant = tenants.findByCompanyId(companyId);
      if (!tenant) {
        // Салон поставил приложение, но у нас не настроен — запоминаем,
        // чтобы его было видно в списке ожидающих подключения.
        tenants.notePendingSalon(companyId);
        req.log.warn(
          { recordId, companyId },
          "altegio webhook: салон не настроен — событие пропущено, салон записан в ожидающие"
        );
        continue;
      }

      const dedupeKey = `record:${companyId}:${recordId}:${event.status}`;
      if (!claimEvent(dedupeKey)) {
        req.log.info({ recordId, status: event.status }, "altegio webhook: duplicate, skipped");
        continue;
      }

      setImmediate(() => void handleRecord(app, tenant, recordId));
    }

    return reply.code(200).send({ ok: true });
  });
};

async function handleRecord(app: FastifyInstance, tenant: Tenant, recordId: string) {
  try {
    const { booking, created } = await createInvoiceForRecord(tenant, recordId);
    app.log.info(
      {
        recordId,
        companyId: tenant.altegio_company_id,
        invoiceId: booking.apipay_invoice_id,
        created,
      },
      created ? "altegio webhook: invoice created" : "altegio webhook: invoice already exists"
    );
  } catch (err) {
    if (err instanceof BookingError) {
      // Понятная ошибка бизнес-правила: нет телефона или нулевая сумма.
      app.log.warn({ recordId, code: err.code, reason: err.message }, "altegio webhook: skipped");
      return;
    }
    app.log.error({ err, recordId }, "altegio webhook: processing failed");
  }
}
