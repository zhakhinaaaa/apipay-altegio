import crypto from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { config } from "../config";
import { db } from "../db";
import { findByInvoiceId, markPrepaymentInAltegio } from "../booking";

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

/**
 * Подпись считается HMAC-SHA256 от СЫРОГО тела запроса.
 * Пересериализованный JSON не подойдёт — порядок ключей и пробелы изменятся.
 */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const markProcessed = () =>
  db.prepare(
    "INSERT OR IGNORE INTO processed_webhooks (source, dedupe_key) VALUES (?, ?)"
  );

/** true — событие новое, false — такое уже обрабатывали. */
function claimEvent(source: string, dedupeKey: string): boolean {
  const result = markProcessed().run(source, dedupeKey);
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

    if (!verifySignature(raw, signature, config.apipay.webhookSecret)) {
      req.log.warn({ hasSignature: Boolean(signature) }, "apipay webhook: bad signature");
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const body = req.body as ApiPayWebhookBody;
    const invoiceId = body.invoice?.id;
    const status = body.invoice?.status;

    if (body.event === "webhook.test") {
      req.log.info("apipay webhook: test event accepted");
      return reply.code(200).send({ ok: true });
    }

    if (!invoiceId || !status) {
      req.log.warn({ event: body.event }, "apipay webhook: payload without invoice id/status");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    // Дедуп по (invoice.id, status) — ApiPay ретраит одно событие до 11 раз.
    const dedupeKey = `invoice:${invoiceId}:${status}`;
    if (!claimEvent("apipay", dedupeKey)) {
      req.log.info({ invoiceId, status }, "apipay webhook: duplicate, skipped");
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    // Отвечаем быстро (лимит ApiPay — 5 секунд), работу делаем после ответа.
    setImmediate(() => void handleStatusChange(app, String(invoiceId), status));

    return reply.code(200).send({ ok: true });
  });
};

async function handleStatusChange(app: FastifyInstance, invoiceId: string, status: string) {
  try {
    const booking = findByInvoiceId(invoiceId);

    if (!booking) {
      app.log.warn({ invoiceId, status }, "apipay webhook: no booking linked to invoice");
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
