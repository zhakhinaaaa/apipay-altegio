import Fastify from "fastify";
import { config } from "./config";
import { db } from "./db";
import { apipayWebhookRoutes } from "./webhooks/apipay";

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

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then((address) => app.log.info(`apipay-altegio-app listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
