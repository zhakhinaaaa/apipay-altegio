import { config } from "./config";
import { db } from "./db";
import * as altegio from "./altegio";
import * as apipay from "./apipay";

export interface BookingRow {
  id: number;
  altegio_record_id: string;
  altegio_company_id: string;
  apipay_invoice_id: string | null;
  phone: string;
  amount: number;
  status: string;
  altegio_marked_paid_at: string | null;
}

export class BookingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BookingError";
  }
}

export function findByRecordId(recordId: string): BookingRow | undefined {
  return db
    .prepare("SELECT * FROM bookings WHERE altegio_record_id = ?")
    .get(recordId) as BookingRow | undefined;
}

export function findByInvoiceId(invoiceId: string): BookingRow | undefined {
  return db
    .prepare("SELECT * FROM bookings WHERE apipay_invoice_id = ?")
    .get(invoiceId) as BookingRow | undefined;
}

/**
 * Создаёт счёт ApiPay по записи Altegio.
 * Повторный вызов по той же записи счёт НЕ дублирует: связка уже лежит в БД,
 * а на стороне ApiPay страхует external_order_id_idempotency.
 */
export async function createInvoiceForRecord(
  recordId: string
): Promise<{ booking: BookingRow; created: boolean }> {
  const existing = findByRecordId(recordId);
  if (existing?.apipay_invoice_id) {
    return { booking: existing, created: false };
  }

  const record = await altegio.getRecord(recordId);

  const rawPhone = record.client?.phone ?? "";
  const phone = apipay.normalizePhone(rawPhone);
  if (!phone) {
    throw new BookingError(
      "missing_phone",
      `В записи ${recordId} нет корректного телефона клиента — счёт не создаём`
    );
  }

  const amount = altegio.recordAmount(record);
  if (!amount || amount <= 0) {
    throw new BookingError(
      "missing_amount",
      `В записи ${recordId} нулевая стоимость услуг — счёт не создаём`
    );
  }

  const invoice = await apipay.createInvoice({
    phoneNumber: phone,
    amount,
    description: `${altegio.recordServiceTitle(record)}, запись №${recordId}`,
    idempotencyKey: `altegio-record-${recordId}`,
  });

  db.prepare(
    `INSERT INTO bookings
       (altegio_record_id, altegio_company_id, apipay_invoice_id, phone, amount, status)
     VALUES (?, ?, ?, ?, ?, 'invoice_created')
     ON CONFLICT(altegio_record_id) DO UPDATE SET
       apipay_invoice_id = excluded.apipay_invoice_id,
       updated_at = datetime('now')`
  ).run(
    recordId,
    String(config.altegio.companyId),
    String(invoice.id),
    phone,
    amount
  );

  return { booking: findByRecordId(recordId)!, created: true };
}

/**
 * Отмечает предоплату в Altegio (вариант Б: приход по кассе).
 * Повторный вызов транзакцию не задваивает — защищает altegio_marked_paid_at.
 */
export async function markPrepaymentInAltegio(booking: BookingRow): Promise<boolean> {
  if (booking.altegio_marked_paid_at) return false;

  const record = await altegio.getRecord(booking.altegio_record_id);

  await altegio.createPrepaymentTransaction({
    record,
    amount: booking.amount,
    comment: `Предоплата ApiPay, счёт №${booking.apipay_invoice_id}`,
  });

  db.prepare(
    `UPDATE bookings
        SET altegio_marked_paid_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`
  ).run(booking.id);

  return true;
}
