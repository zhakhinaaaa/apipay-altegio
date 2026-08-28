/**
 * Страница самостоятельного подключения салона.
 *
 * Без неё салон, поставивший приложение из маркетплейса, ничего не получает:
 * его ключи ApiPay приходилось заводить руками на сервере. Здесь салон
 * вводит их сам, а мы проверяем и записываем в таблицу tenants.
 *
 * Адрес публичный, поэтому вход только по одноразовой ссылке: её выдаёт
 * Altegio-редирект в момент подключения приложения к филиалу.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { config } from "./config";
import { db } from "./db";
import * as altegio from "./altegio";
import { checkApiKey } from "./apipay";
import * as tenants from "./tenants";

const SESSION_TTL_HOURS = 24;

export interface SetupSession {
  token: string;
  altegio_company_id: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

/** Ссылка живёт сутки: дольше держать открытый вход в настройку незачем. */
export function createSession(companyId?: string | number | null): SetupSession {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO setup_sessions (token, altegio_company_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_TTL_HOURS} hours'))`
  ).run(token, companyId === undefined || companyId === null ? null : String(companyId));
  return findSession(token)!;
}

/** Возвращает сессию, только пока она не просрочена. */
export function findSession(token: string): SetupSession | undefined {
  return db
    .prepare("SELECT * FROM setup_sessions WHERE token = ? AND expires_at > datetime('now')")
    .get(token) as SetupSession | undefined;
}

export function completeSession(token: string, companyId: string): void {
  db.prepare(
    "UPDATE setup_sessions SET completed_at = datetime('now'), altegio_company_id = ? WHERE token = ?"
  ).run(companyId, token);
}

export function setupUrl(token: string): string {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return `${base}/setup/${token}`;
}

/** Просроченные ссылки не нужны — чистим при старте. */
export function purgeExpiredSessions(): number {
  const res = db.prepare("DELETE FROM setup_sessions WHERE expires_at <= datetime('now')").run();
  return Number(res.changes);
}

// --- Отрисовка страницы -----------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         max-width: 560px; margin: 0 auto; padding: 32px 20px 64px; line-height: 1.5; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .sub { color: #6b7280; margin-top: 0; }
  label { display: block; margin-top: 20px; font-weight: 600; }
  .hint { font-weight: 400; color: #6b7280; font-size: 14px; margin-top: 2px; }
  input, select { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-top: 6px;
                  border: 1px solid #cbd5e1; border-radius: 8px; font-size: 15px;
                  background: transparent; color: inherit; }
  button { margin-top: 28px; width: 100%; padding: 12px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
  .box { background: rgba(127,127,127,.12); border-radius: 8px; padding: 12px 14px; margin-top: 20px; }
  .error { background: #fee2e2; color: #991b1b; border-radius: 8px; padding: 12px 14px; margin-top: 20px; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function message(title: string, text: string): string {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
}

/**
 * Касса по умолчанию: предоплата приходит безналом, поэтому берём безналичную,
 * а если такой нет — первую из списка. Салон кассу не выбирает: цель страницы —
 * один-единственный ввод, API-ключ.
 */
export function defaultAccount(accounts: altegio.AltegioAccount[]): altegio.AltegioAccount | undefined {
  return accounts.find((a) => a.type_slug === "cashless") ?? accounts[0];
}

interface FormState {
  companyId: string | null;
  accounts: altegio.AltegioAccount[];
  accountsError?: string;
  values: Record<string, string>;
  error?: string;
}

function form(state: FormState): string {
  const v = state.values;

  const companyField = state.companyId
    ? `<div class="box">Филиал Altegio: <b>${esc(state.companyId)}</b></div>`
    : `<label>ID вашего филиала в Altegio
  <div class="hint">Число из адреса кабинета Altegio, например <code>.../company/1354369/</code></div>
  <input name="company_id" inputmode="numeric" required value="${esc(v.company_id)}">
</label>`;

  const preset = defaultAccount(state.accounts);
  const accountField = preset
    ? `<p class="hint">Предоплата будет зачисляться в кассу «${esc(preset.title)}».</p>`
    : `<label>ID кассы Altegio
  <div class="hint">${esc(
    state.accountsError ?? "Список касс получить не удалось — введите ID кассы вручную"
  )}</div>
  <input name="account_id" inputmode="numeric" required value="${esc(v.account_id)}">
</label>`;

  return page(
    "Подключение ApiPay",
    `<h1>Подключение ApiPay</h1>
<p class="sub">Остался один шаг: укажите API-ключ вашего аккаунта ApiPay — после этого
счета на предоплату будут выставляться автоматически.</p>

${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}

<form method="post">
${companyField}

<label>API-ключ ApiPay
  <div class="hint">ApiPay → настройки организации → API-ключ</div>
  <input name="apipay_api_key" required autocomplete="off" value="${esc(v.apipay_api_key)}">
</label>

${accountField}

<button type="submit">Подключить</button>
</form>`
  );
}

function expiredPage(): string {
  return message(
    "Ссылка больше не действует",
    "Откройте настройку заново: в кабинете Altegio отключите и снова подключите приложение ApiPay — сразу после подключения появится свежая ссылка."
  );
}

// --- Определение филиала ----------------------------------------------------

/** Ключи, под которыми Altegio может прислать идентификатор филиала. */
const COMPANY_KEYS = ["salon_id", "company_id", "salon", "company", "salonId", "companyId"];

/**
 * Точный набор параметров Altegio-редиректа заранее не известен, поэтому
 * идентификатор филиала ищем по нескольким именам и в query, и в теле.
 */
export function extractCompanyId(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    for (const key of COMPANY_KEYS) {
      const value = record[key];
      if (value === undefined || value === null) continue;
      const text = String(value).trim();
      if (/^\d+$/.test(text)) return text;
    }
  }
  return undefined;
}

// --- Маршруты ---------------------------------------------------------------

interface SetupBody {
  company_id?: string;
  apipay_api_key?: string;
  account_id?: string;
}

/** Кассы филиала; ошибку не бросаем — форма умеет работать и без списка. */
async function loadAccounts(
  app: FastifyInstance,
  companyId: string | null
): Promise<{ accounts: altegio.AltegioAccount[]; accountsError?: string }> {
  if (!companyId || !config.altegio.userToken) {
    return { accounts: [], accountsError: "Список касс недоступен — введите ID кассы вручную" };
  }
  try {
    return { accounts: await altegio.listAccounts(config.altegio.userToken, companyId) };
  } catch (err) {
    app.log.warn({ err, companyId }, "setup: не удалось получить список касс");
    return {
      accounts: [],
      accountsError: "Список касс получить не удалось — введите ID кассы вручную",
    };
  }
}

// Форма отправляется как обычный HTML-form, а не JSON. Парсер регистрируется
// в server.ts на корневом экземпляре — он же нужен на /altegio/install.
export const setupRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/setup", async (_req, reply) =>
    reply
      .type("text/html")
      .send(
        message(
          "Страница настройки",
          "Откройте её по ссылке, которую Altegio показывает сразу после подключения приложения к филиалу."
        )
      )
  );

  app.get<{ Params: { token: string } }>("/setup/:token", async (req, reply) => {
    const session = findSession(req.params.token);
    if (!session) return reply.code(404).type("text/html").send(expiredPage());

    const existing = session.altegio_company_id
      ? tenants.findByCompanyId(session.altegio_company_id)
      : undefined;
    const { accounts, accountsError } = await loadAccounts(app, session.altegio_company_id);

    return reply.type("text/html").send(
      form({
        companyId: session.altegio_company_id,
        accounts,
        accountsError,
        values: {
          company_id: "",
          apipay_api_key: "",
          // Уже подключённому салону подставляем его текущую кассу.
          account_id: existing?.altegio_account_id ?? "",
        },
      })
    );
  });

  app.post<{ Params: { token: string }; Body: SetupBody }>("/setup/:token", async (req, reply) => {
    const session = findSession(req.params.token);
    if (!session) return reply.code(404).type("text/html").send(expiredPage());

    const body = req.body ?? {};
    const companyId = session.altegio_company_id ?? String(body.company_id ?? "").trim();
    const apiKey = String(body.apipay_api_key ?? "").trim();

    const { accounts, accountsError } = await loadAccounts(
      app,
      /^\d+$/.test(companyId) ? companyId : null
    );

    // Кассу выбираем сами; вручную её вводят, только если список касс не пришёл.
    const accountId =
      String(defaultAccount(accounts)?.id ?? "") || String(body.account_id ?? "").trim();

    const fail = (error: string) =>
      reply
        .code(400)
        .type("text/html")
        .send(
          form({
            companyId: session.altegio_company_id,
            accounts,
            accountsError,
            values: {
              company_id: companyId,
              apipay_api_key: apiKey,
              account_id: accountId,
            },
            error,
          })
        );

    if (!/^\d+$/.test(companyId)) return fail("ID филиала — это число из адреса кабинета Altegio.");
    if (!apiKey) return fail("Укажите API-ключ ApiPay.");
    if (!/^\d+$/.test(accountId)) return fail("Укажите ID кассы для зачисления предоплаты.");

    if (!config.altegio.userToken) {
      app.log.error("setup: не задан ALTEGIO_USER_TOKEN — подключить салон невозможно");
      return fail("Приложение настроено не полностью. Напишите в поддержку ApiPay.");
    }

    // Филиал из ссылки назвал сам Altegio — его проверять нечем и незачем.
    // А вот введённый руками нужно подтвердить обращением к Altegio, иначе
    // по такой ссылке можно было бы настроить чужой салон.
    if (!session.altegio_company_id && accountsError) {
      return fail(
        `Не удалось подтвердить филиал ${companyId} в Altegio. Проверьте номер филиала и то, что приложение ApiPay к нему подключено.`
      );
    }
    if (accounts.length && !accounts.some((a) => String(a.id) === accountId)) {
      return fail("Такой кассы в этом филиале нет.");
    }

    const keyCheck = await checkApiKey(apiKey);
    if (keyCheck === "invalid") {
      return fail("ApiPay не принял этот API-ключ. Проверьте и попробуйте снова.");
    }
    if (keyCheck === "unknown") {
      app.log.warn({ companyId }, "setup: ключ ApiPay проверить не удалось, сохраняем как есть");
    }

    const title = await altegio.getCompanyTitle(config.altegio.userToken, companyId);

    const tenant = tenants.upsert({
      altegioCompanyId: companyId,
      altegioUserToken: config.altegio.userToken,
      altegioAccountId: accountId,
      apipayApiKey: apiKey,
      title,
    });
    completeSession(session.token, companyId);

    app.log.info(
      { companyId, tenantId: tenant.id, apipayKeyChecked: keyCheck === "ok" },
      "setup: салон подключился самостоятельно"
    );

    return reply.type("text/html").send(
      page(
        "Готово",
        `<h1>Готово</h1>
<p>Салон <b>${esc(title ?? companyId)}</b> подключён. Теперь при новой записи клиенту
автоматически выставляется счёт на предоплату, а после оплаты приход попадает
в финансы Altegio.</p>
<p>Можно вернуться в Altegio и создать запись для проверки.</p>`
      )
    );
  });
};
