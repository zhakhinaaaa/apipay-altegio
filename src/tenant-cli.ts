/**
 * Управление подключёнными салонами.
 *
 * На сервере (внутри контейнера):
 *   docker compose exec app node dist/tenant-cli.js list
 *   docker compose exec app node dist/tenant-cli.js add --company 1354369 \
 *       --user-token ... --account 2747575 --apipay-key ... --apipay-secret ...
 *   docker compose exec app node dist/tenant-cli.js setup-link --company 1354369
 *   docker compose exec app node dist/tenant-cli.js disable --company 1354369
 *
 * Локально при разработке: npm run tenant -- list
 *
 * Секреты передаются аргументами, поэтому запускать только на своей машине
 * или на сервере — не в общих логах CI.
 */
import { db } from "./db";
import * as tenants from "./tenants";
import { createSession, setupUrl } from "./setup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function mask(secret: string): string {
  return secret.length <= 4 ? "****" : `****${secret.slice(-4)}`;
}

function required(name: string): string {
  const value = arg(name);
  if (!value) {
    console.error(`Не хватает --${name}`);
    process.exit(1);
  }
  return value;
}

const command = process.argv[2];

switch (command) {
  case "list": {
    const rows = db
      .prepare("SELECT * FROM tenants ORDER BY id")
      .all() as unknown as tenants.Tenant[];

    if (rows.length === 0) {
      console.log("Салонов пока нет.");
      break;
    }
    for (const t of rows) {
      console.log(
        [
          `#${t.id}`,
          t.active ? "активен" : "выключен",
          `Altegio company ${t.altegio_company_id}`,
          `касса ${t.altegio_account_id}`,
          `статья ${t.altegio_expense_id}`,
          `user token ${mask(t.altegio_user_token)}`,
          `apipay key ${mask(t.apipay_api_key)}`,
          `apipay secret ${mask(t.apipay_webhook_secret)}`,
          t.title ?? "",
        ].join(" | ")
      );
    }
    break;
  }

  case "pending": {
    const rows = tenants.listPendingSalons();
    if (rows.length === 0) {
      console.log("Салонов, ожидающих настройки, нет.");
      break;
    }
    console.log("Поставили приложение в Altegio, но у нас не настроены:");
    for (const s of rows) {
      console.log(
        `  Altegio company ${s.altegio_company_id} | событий: ${s.events_count} | впервые: ${s.first_seen_at} | последнее: ${s.last_seen_at}`
      );
    }
    console.log("\nЧтобы подключить: add --company <id> --user-token ... --account ... --apipay-key ... --apipay-secret ...");
    break;
  }

  case "add": {
    const tenant = tenants.upsert({
      altegioCompanyId: required("company"),
      altegioUserToken: required("user-token"),
      altegioAccountId: required("account"),
      altegioExpenseId: Number(arg("expense") ?? 5),
      apipayApiKey: required("apipay-key"),
      apipayWebhookSecret: required("apipay-secret"),
      title: arg("title"),
    });
    console.log(`Готово: салон #${tenant.id}, Altegio company ${tenant.altegio_company_id}`);
    break;
  }

  // Ссылка на страницу настройки для салона, который не может пройти её сам
  // (например, потерял ссылку после подключения). Живёт сутки.
  case "setup-link": {
    const companyId = required("company");
    const session = createSession(companyId);
    console.log(setupUrl(session.token));
    console.log(`Действует до ${session.expires_at} UTC.`);
    break;
  }

  case "disable": {
    const companyId = required("company");
    console.log(
      tenants.deactivate(companyId) ? `Салон ${companyId} выключен.` : `Салон ${companyId} не найден.`
    );
    break;
  }

  default:
    console.log(
      "Команды: list | pending | add | setup-link | disable  (см. комментарий в начале файла)"
    );
}
