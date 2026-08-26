import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { BookingError, createInvoiceForRecord } from "../booking";

interface AltegioEvent {
  company_id?: number;
  resource?: string;
  resource_id?: number;
  status?: string;
  data?: { id?: number; attendance?: number; deleted?: boolean };
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
  app.get("/altegio/install", async (req, reply) => {
    req.log.info({ query: req.query }, "altegio: установка приложения в филиал");
    return reply.type("text/html").send(
      "<h2>ApiPay \u2194 Altegio</h2><p>Интеграция подключена. Можно вернуться в Altegio.</p>"
    );
  });

  // Altegio дёргает этот адрес при отключении интеграции (Callback Url).
  app.all("/altegio/uninstall", async (req, reply) => {
    req.log.warn({ query: req.query }, "altegio: интеграция отключена");
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

      const dedupeKey = `record:${recordId}:${event.status}`;
      if (!claimEvent(dedupeKey)) {
        req.log.info({ recordId, status: event.status }, "altegio webhook: duplicate, skipped");
        continue;
      }

      setImmediate(() => void handleRecord(app, recordId));
    }

    return reply.code(200).send({ ok: true });
  });
};

async function handleRecord(app: FastifyInstance, recordId: string) {
  try {
    const { booking, created } = await createInvoiceForRecord(recordId);
    app.log.info(
      { recordId, invoiceId: booking.apipay_invoice_id, created },
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
