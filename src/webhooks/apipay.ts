import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { findByInvoiceId, markPrepaymentInAltegio } from "../booking";
import * as tenants from "../tenants";
import type { Tenant } from "../tenants";

export { verifySignature } from "../signature";

const SIGNATURE_HEADER = "x-webhook-signature";

interface ApiPayWebhookBody {
  event?: string;
  invoice?: {
    id?: number | string;
    status?: string;
    amount?: string | number;
    client_phone?: string;
    external_order_id_idempotency?: string | null;
    paid_at?: string | null;
    is_fully_refunded?: boolean;
  };
  timestamp?: string;
  [key: string]: unknown;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** true — событие новое, false — такое уже обрабатывали. */
function claimEvent(source: string, dedupeKey: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO processed_webhooks (source, dedupe_key) VALUES (?, ?)")
    .run(source, dedupeKey);
  return Number(result.changes) > 0;
}

export const apipayWebhookRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Сохраняем сырое тело: без него подпись не сойдётся.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      const raw = body as Buffer;
      req.rawBody = raw;
      try {
        done(null, raw.length ? JSON.parse(raw.toString("utf8")) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Некоторые сервисы проверяют доступность адреса обычным GET перед сохранением.
  app.get("/webhooks/apipay", async () => ({ ok: true, endpoint: "apipay" }));

  app.post("/webhooks/apipay", async (req, reply) => {
    const raw = req.rawBody ?? Buffer.alloc(0);
    const signature = req.headers[SIGNATURE_HEADER] as string | undefined;

    // Салон определяем ПО ПОДПИСИ, а не по телу запроса: перебираем секреты
    // подключённых салонов. Так тело не влияет ни на что до проверки подписи.
    const tenant = tenants.findByApipaySignature(raw, signature);
    if (!tenant) {
      req.log.warn({ hasSignature: Boolean(signature) }, "apipay webhook: bad signature");
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const body = req.body as ApiPayWebhookBody;
    const invoiceId = body.invoice?.id;
    const status = body.invoice?.status;

    if (body.event === "webhook.test") {
      req.log.info({ companyId: tenant.altegio_company_id }, "apipay webhook: test event accepted");
      return reply.code(200).send({ ok: true });
    }

    if (!invoiceId || !status) {
      req.log.warn({ event: body.event }, "apipay webhook: payload without invoice id/status");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    // Дедуп по (арендатор, invoice.id, status) — ApiPay ретраит одно событие до 11 раз.
    const dedupeKey = `invoice:${tenant.id}:${invoiceId}:${status}`;
    if (!claimEvent("apipay", dedupeKey)) {
      req.log.info({ invoiceId, status }, "apipay webhook: duplicate, skipped");
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    // Отвечаем быстро (лимит ApiPay — 5 секунд), работу делаем после ответа.
    setImmediate(() => void handleStatusChange(app, tenant, String(invoiceId), status));

    return reply.code(200).send({ ok: true });
  });
};

async function handleStatusChange(
  app: FastifyInstance,
  tenant: Tenant,
  invoiceId: string,
  status: string
) {
  try {
    const booking = findByInvoiceId(invoiceId);

    if (!booking) {
      app.log.warn({ invoiceId, status }, "apipay webhook: no booking linked to invoice");
      return;
    }

    // Счёт должен принадлежать тому же салону, чьей подписью подписан вебхук.
    if (booking.tenant_id && booking.tenant_id !== tenant.id) {
      app.log.warn(
        { invoiceId, bookingTenant: booking.tenant_id, signedBy: tenant.id },
        "apipay webhook: счёт принадлежит другому салону — пропущено"
      );
      return;
    }

    if (status !== "paid") {
      db.prepare(
        "UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE apipay_invoice_id = ?"
      ).run(status, invoiceId);
      app.log.info({ invoiceId, status }, "apipay webhook: booking status updated");
      return;
    }

    db.prepare(
      "UPDATE bookings SET status = 'paid', updated_at = datetime('now') WHERE apipay_invoice_id = ?"
    ).run(invoiceId);

    // Вариант Б: приход по кассе Altegio как отметка предоплаты.
    const marked = await markPrepaymentInAltegio(booking);
    app.log.info(
      { invoiceId, altegioRecordId: booking.altegio_record_id, marked },
      marked
        ? "apipay webhook: prepayment recorded in Altegio"
        : "apipay webhook: prepayment already recorded, skipped"
    );
  } catch (err) {
    // Ошибка обработки не должна ронять приложение.
    app.log.error({ err, invoiceId, status }, "apipay webhook: processing failed");
  }
}
