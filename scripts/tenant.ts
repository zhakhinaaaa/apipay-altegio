/**
 * Управление подключёнными салонами.
 *
 *   npm run tenant -- list
 *   npm run tenant -- add --company 1354369 --user-token ... --account 2747575 \
 *                         --apipay-key ... --apipay-secret ... [--expense 5] [--title "Салон"]
 *   npm run tenant -- disable --company 1354369
 *
 * Секреты передаются аргументами, поэтому запускать только на сервере.
 */
import { db } from "../src/db";
import * as tenants from "../src/tenants";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function mask(secret: string): string {
  return secret.length <= 4 ? "****" : `****${secret.slice(-4)}`;
}

function require_(name: string): string {
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
    const rows = db.prepare("SELECT * FROM tenants ORDER BY id").all() as tenants.Tenant[];
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

  case "add": {
    const tenant = tenants.upsert({
      altegioCompanyId: require_("company"),
      altegioUserToken: require_("user-token"),
      altegioAccountId: require_("account"),
      altegioExpenseId: Number(arg("expense") ?? 5),
      apipayApiKey: require_("apipay-key"),
      apipayWebhookSecret: require_("apipay-secret"),
      title: arg("title"),
    });
    console.log(`Готово: салон #${tenant.id}, Altegio company ${tenant.altegio_company_id}`);
    break;
  }

  case "disable": {
    const companyId = require_("company");
    const res = db
      .prepare("UPDATE tenants SET active = 0, updated_at = datetime('now') WHERE altegio_company_id = ?")
      .run(companyId);
    console.log(Number(res.changes) ? `Салон ${companyId} выключен.` : `Салон ${companyId} не найден.`);
    break;
  }

  default:
    console.log("Команды: list | add | disable  (см. комментарий в начале файла)");
}
