import crypto from "node:crypto";

/**
 * Подпись ApiPay: HMAC-SHA256 от СЫРОГО тела запроса, hex, с префиксом sha256=.
 * Пересериализованный JSON не подойдёт — порядок ключей и пробелы изменятся.
 */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
