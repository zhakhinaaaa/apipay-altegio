import Fastify from "fastify";
import { config } from "./config";
import { db } from "./db";
import { apipayWebhookRoutes } from "./webhooks/apipay";
import { altegioWebhookRoutes } from "./webhooks/altegio";
import { BookingError, createInvoiceForRecord } from "./booking";

const app = Fastify({
  logger: {
    transport: { target: "pino-pretty" },
    redact: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "req.headers['x-webhook-signature']",
    ],
  },
});

app.get("/health", async () => {
  const dbOk = db.prepare("SELECT 1").get() !== undefined;
  return { status: "ok", db: dbOk };
});

app.register(apipayWebhookRoutes);
app.register(altegioWebhookRoutes);

// Ручной запуск сценария без вебхука Altegio — удобно для отладки и демо.
app.post<{ Params: { recordId: string } }>("/dev/records/:recordId/invoice", async (req, reply) => {
  try {
    const { booking, created } = await createInvoiceForRecord(req.params.recordId);
    return { created, booking };
  } catch (err) {
    if (err instanceof BookingError) {
      return reply.code(422).send({ error: err.code, message: err.message });
    }
    throw err;
  }
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then((address) => app.log.info(`apipay-altegio-app listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
