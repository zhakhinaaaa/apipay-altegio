import "dotenv/config";

function optional(name: string): string {
  return process.env[name] ?? "";
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: optional("DB_PATH") || "./data/app.sqlite",
  publicBaseUrl: optional("PUBLIC_BASE_URL"),
  // Пока пусто — служебные /dev-адреса выключены.
  devEndpointsToken: optional("DEV_ENDPOINTS_TOKEN"),

  apipay: {
    baseUrl: optional("APIPAY_BASE_URL") || "https://api.apipay.kz/api/v1",
    apiKey: optional("APIPAY_API_KEY"),
    webhookSecret: optional("APIPAY_WEBHOOK_SECRET"),
  },

  altegio: {
    baseUrl: optional("ALTEGIO_BASE_URL") || "https://api.alteg.io/api/v1",
    partnerId: optional("ALTEGIO_PARTNER_ID"),
    /**
     * ID нашего приложения в маркетплейсе. Нужен, чтобы отличить отключение
     * нашей интеграции от отключения другого приложения того же партнёра:
     * Altegio шлёт uninstall на Callback Url каждого из них.
     * Пусто — доверяем любому uninstall, как раньше.
     */
    applicationId: optional("ALTEGIO_APPLICATION_ID"),
    // ID приложения в маркетплейсе — нужен, чтобы увести салон обратно в его карточку.
    appId: optional("ALTEGIO_APP_ID"),
    partnerToken: optional("ALTEGIO_PARTNER_TOKEN"),
    userToken: optional("ALTEGIO_USER_TOKEN"),
    companyId: optional("ALTEGIO_COMPANY_ID"),
    accountId: optional("ALTEGIO_ACCOUNT_ID"),
    expenseId: Number(process.env.ALTEGIO_EXPENSE_ID ?? 5),
  },
};
