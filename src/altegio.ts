import { config } from "./config";
import type { Tenant } from "./tenants";

export interface AltegioService {
  id: number;
  title: string;
  cost: number;
  cost_to_pay: number;
}

export interface AltegioRecord {
  id: number;
  company_id: number;
  staff_id: number;
  visit_id: number;
  services: AltegioService[];
  client: { id: number; phone: string; display_name?: string } | null;
  documents?: Array<{ id: number; type_title?: string }>;
  paid_full: number;
  prepaid: boolean;
  prepaid_confirmed: boolean;
  payment_status: number;
  datetime: string;
}

export class AltegioError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
    this.name = "AltegioError";
  }
}

/**
 * Partner token принадлежит приложению и общий для всех салонов,
 * user token — свой у каждого салона, поэтому берётся из арендатора.
 */
async function request<T>(
  tenant: Tenant,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${config.altegio.baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.api.v2+json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.altegio.partnerToken}, User ${tenant.altegio_user_token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  // Altegio отвечает 200 с success:false — считаем это ошибкой тоже.
  if (!res.ok || parsed?.success === false) {
    const message = parsed?.meta?.message ?? `HTTP ${res.status}`;
    // Токены в сообщение не попадают — только путь и текст ошибки Altegio.
    throw new AltegioError(res.status, parsed, `Altegio ${method} ${path}: ${message}`);
  }

  return (parsed?.data ?? parsed) as T;
}

export async function getRecord(
  tenant: Tenant,
  recordId: string | number
): Promise<AltegioRecord> {
  return request<AltegioRecord>(
    tenant,
    "GET",
    `/record/${tenant.altegio_company_id}/${recordId}`
  );
}

/** Сумма к оплате по записи — сумма cost_to_pay всех услуг. */
export function recordAmount(record: AltegioRecord): number {
  return (record.services ?? []).reduce((sum, s) => sum + (s.cost_to_pay ?? s.cost ?? 0), 0);
}

export function recordServiceTitle(record: AltegioRecord): string {
  return (record.services ?? []).map((s) => s.title).join(", ") || "Услуга";
}

/** Документ визита — к нему привязывается финансовая транзакция. */
export function recordDocumentId(record: AltegioRecord): number | undefined {
  return record.documents?.[0]?.id;
}

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

export interface FinanceTransaction {
  id: number;
  amount: number;
  account_id: number;
  expense_id: number;
  document_id: number;
  comment: string;
}

/**
 * Вариант Б из ТЗ: приход по кассе как отметка принятой предоплаты.
 * expense_id = 5 (Service payments, тип 7 — приход), сумма положительная.
 */
export async function createPrepaymentTransaction(params: {
  tenant: Tenant;
  record: AltegioRecord;
  amount: number;
  comment: string;
}): Promise<FinanceTransaction> {
  const { tenant, record, amount, comment } = params;

  return request<FinanceTransaction>(
    tenant,
    "POST",
    `/finance_transactions/${tenant.altegio_company_id}`,
    {
      account_id: Number(tenant.altegio_account_id),
      expense_id: tenant.altegio_expense_id,
      amount,
      date: formatDate(new Date()),
      document_id: recordDocumentId(record) ?? 0,
      client_id: record.client?.id ?? 0,
      master_id: record.staff_id ?? 0,
      comment,
    }
  );
}
