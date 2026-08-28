import { config } from "./config";
import type { Tenant } from "./tenants";

export type InvoiceStatus =
  | "processing"
  | "pending"
  | "paid"
  | "cancelled"
  | "expired"
  | "error"
  | "partially_refunded";

export interface Invoice {
  id: number | string;
  status: InvoiceStatus;
  amount: string | number;
  client_phone?: string;
  kaspi_invoice_id?: string | null;
  external_order_id_idempotency?: string | null;
  created_at?: string;
}

export class ApiPayError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
    this.name = "ApiPayError";
  }
}

/** Ключ ApiPay свой у каждого арендатора — берём из его строки в таблице. */
async function request<T>(
  tenant: Tenant,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${config.apipay.baseUrl}${path}`, {
    method,
    headers: {
      "X-API-Key": tenant.apipay_api_key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    // Никогда не логируем сам ключ — только статус и тело ответа.
    throw new ApiPayError(
      res.status,
      parsed,
      `ApiPay ${method} ${path} failed with ${res.status}`
    );
  }

  return parsed as T;
}

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

/**
 * Телефон в ApiPay принимается строго в формате 8XXXXXXXXXX.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return `8${digits.slice(1)}`;
  }
  if (digits.length === 10) return `8${digits}`;
  return null;
}

export interface CreateInvoiceInput {
  phoneNumber: string;
  amount: number;
  description?: string;
  /** ID записи Altegio — он же ключ идемпотентности на стороне ApiPay. */
  idempotencyKey: string;
}

export async function createInvoice(
  tenant: Tenant,
  input: CreateInvoiceInput
): Promise<Invoice> {
  const payload = await request<unknown>(tenant, "POST", "/invoices", {
    phone_number: input.phoneNumber,
    amount: input.amount,
    description: input.description?.slice(0, 500),
    external_order_id_idempotency: input.idempotencyKey,
  });
  return unwrap<Invoice>(payload);
}

export async function getInvoice(tenant: Tenant, id: string | number): Promise<Invoice> {
  return unwrap<Invoice>(await request<unknown>(tenant, "GET", `/invoices/${id}`));
}

/** Только песочница: на боевом счёте вернёт 403 not_sandbox. */
export async function simulateStatus(
  tenant: Tenant,
  id: string | number,
  status: "paid" | "cancelled" | "expired" | "error" | "qr_scanned"
): Promise<Invoice> {
  return unwrap<Invoice>(
    await request<unknown>(tenant, "POST", `/invoices/${id}/simulate-status`, { status })
  );
}
