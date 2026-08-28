import Fastify from "fastify";
import { config } from "./config";
import { db } from "./db";
import { apipayWebhookRoutes } from "./webhooks/apipay";
import { altegioWebhookRoutes } from "./webhooks/altegio";
import { BookingError, createInvoiceForRecord } from "./booking";
import * as tenants from "./tenants";

const app = Fastify({
  // Автолог каждого запроса выключен: в консоли остаются только
  // осмысленные события интеграции.
  disableRequestLogging: true,
  logger: {
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    },
    redact: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "req.headers['x-webhook-signature']",
      "req.headers['x-dev-token']",
    ],
  },
});

app.get("/health", async () => {
  const dbOk = db.prepare("SELECT 1").get() !== undefined;
  return { status: "ok", db: dbOk, tenants: tenants.listActive().length };
});

app.register(apipayWebhookRoutes);
app.register(altegioWebhookRoutes);

// Ручной запуск сценария без вебхука Altegio — для отладки и демо.
// Адрес публичный, поэтому закрыт токеном: без DEV_ENDPOINTS_TOKEN он выключен.
app.post<{ Params: { recordId: string }; Querystring: { company?: string } }>(
  "/dev/records/:recordId/invoice",
  async (req, reply) => {
    if (!config.devEndpointsToken) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (req.headers["x-dev-token"] !== config.devEndpointsToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const active = tenants.listActive();
    const tenant = req.query.company
      ? tenants.findByCompanyId(req.query.company)
      : active.length === 1
        ? active[0]
        : undefined;

    if (!tenant) {
      return reply.code(400).send({
        error: "tenant_required",
        message:
          active.length === 0
            ? "Ни один салон не подключён"
            : "Подключено несколько салонов — укажите ?company=<altegio_company_id>",
      });
    }

    try {
      const { booking, created } = await createInvoiceForRecord(tenant, req.params.recordId);
      return { created, booking };
    } catch (err) {
      if (err instanceof BookingError) {
        return reply.code(422).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  }
);

// Первый запуск после перехода на мультиарендность: переносим одиночную
// конфигурацию из .env в таблицу и подшиваем к ней старые записи.
const seeded = tenants.seedFromEnv();
if (seeded) {
  app.log.info(
    { companyId: seeded.altegio_company_id },
    "tenants: салон импортирован из .env"
  );
}
const backfilled = tenants.backfillBookings();
if (backfilled > 0) {
  app.log.info({ count: backfilled }, "tenants: старым записям проставлен салон");
}

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(
      { tenants: tenants.listActive().length },
      `apipay-altegio-app listening on ${address}`
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
