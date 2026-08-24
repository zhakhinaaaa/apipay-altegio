import "dotenv/config";

function optional(name: string): string {
  return process.env[name] ?? "";
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: optional("DB_PATH") || "./data/app.sqlite",
  publicBaseUrl: optional("PUBLIC_BASE_URL"),

  apipay: {
    baseUrl: optional("APIPAY_BASE_URL") || "https://api.apipay.kz/api/v1",
    apiKey: optional("APIPAY_API_KEY"),
    webhookSecret: optional("APIPAY_WEBHOOK_SECRET"),
  },

  altegio: {
    baseUrl: optional("ALTEGIO_BASE_URL") || "https://api.alteg.io/api/v1",
    partnerToken: optional("ALTEGIO_PARTNER_TOKEN"),
    userToken: optional("ALTEGIO_USER_TOKEN"),
    locationId: optional("ALTEGIO_LOCATION_ID"),
  },
};
