import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { BookingError, createInvoiceForRecord } from "../booking";
import * as tenants from "../tenants";
import type { Tenant } from "../tenants";

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

/** true — событие новое, false — уже обрабатывали. */
function claimEvent(dedupeKey: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO processed_webhooks (source, dedupe_key) VALUES (?, ?)")
    .run("altegio", dedupeKey);
  return Number(result.changes) > 0;
}

export const altegioWebhookRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Altegio ведёт сюда после согласия на подключение приложения к филиалу
  // (Registration Redirect Url). Достаточно ответить 200 — установка завершится.
  // Параметры логируем: по ним заводится новый салон в таблице tenants.
  app.all("/altegio/install", async (req, reply) => {
    req.log.info(
      {
        method: req.method,
        query: describeParams(req.query),
        body: describeParams(req.body),
      },
      "altegio: установка приложения в филиал"
    );
    return reply.type("text/html").send(
      "<h2>ApiPay ↔ Altegio</h2><p>Интеграция подключена. Можно вернуться в Altegio.</p>"
    );
  });

  // Altegio дёргает этот адрес при отключении интеграции (Callback Url).
  app.all("/altegio/uninstall", async (req, reply) => {
    req.log.warn(
      {
        method: req.method,
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
