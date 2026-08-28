import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// База создаётся при импорте модуля, поэтому путь подменяем заранее.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apipay-altegio-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");

// require, а не import: статический import сработал бы раньше подмены DB_PATH.
const tenants = require("../src/tenants") as typeof import("../src/tenants");

function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

const salonA = {
  altegioCompanyId: "1000001",
  altegioUserToken: "user-token-a",
  altegioAccountId: "111",
  apipayApiKey: "apipay-key-a",
  apipayWebhookSecret: "secret-a",
  title: "Салон А",
};

const salonB = {
  altegioCompanyId: "1000002",
  altegioUserToken: "user-token-b",
  altegioAccountId: "222",
  apipayApiKey: "apipay-key-b",
  apipayWebhookSecret: "secret-b",
  title: "Салон Б",
};

test("салон находится по altegio company_id", () => {
  tenants.upsert(salonA);
  tenants.upsert(salonB);

  assert.equal(tenants.findByCompanyId("1000001")?.title, "Салон А");
  assert.equal(tenants.findByCompanyId("1000002")?.title, "Салон Б");
  assert.equal(tenants.findByCompanyId("9999999"), undefined);
});

test("повторный upsert обновляет салон, а не заводит второй", () => {
  const before = tenants.listActive().length;
  tenants.upsert({ ...salonA, apipayApiKey: "apipay-key-a-new" });

  assert.equal(tenants.listActive().length, before);
  assert.equal(tenants.findByCompanyId("1000001")?.apipay_api_key, "apipay-key-a-new");
});

test("вебхук ApiPay опознаёт салон по подписи", () => {
  const body = '{"event":"invoice.status_changed","invoice":{"id":1,"status":"paid"}}';
  const raw = Buffer.from(body);

  assert.equal(
    tenants.findByApipaySignature(raw, sign(body, "secret-a"))?.altegio_company_id,
    "1000001"
  );
  assert.equal(
    tenants.findByApipaySignature(raw, sign(body, "secret-b"))?.altegio_company_id,
    "1000002"
  );
});

test("чужая или отсутствующая подпись не даёт салона", () => {
  const body = '{"event":"invoice.status_changed","invoice":{"id":1,"status":"paid"}}';
  const raw = Buffer.from(body);

  assert.equal(tenants.findByApipaySignature(raw, sign(body, "secret-чужой")), undefined);
  assert.equal(tenants.findByApipaySignature(raw, "sha256=deadbeef"), undefined);
  assert.equal(tenants.findByApipaySignature(raw, undefined), undefined);
});

test("незнакомый салон попадает в список ожидающих и считает события", () => {
  tenants.notePendingSalon("7777777");
  tenants.notePendingSalon("7777777");

  const pending = tenants.listPendingSalons().find((s) => s.altegio_company_id === "7777777");
  assert.ok(pending, "салон должен попасть в ожидающие");
  assert.equal(pending.events_count, 2);
});

test("после настройки салон уходит из списка ожидающих", () => {
  tenants.notePendingSalon("8888888");
  assert.ok(tenants.listPendingSalons().some((s) => s.altegio_company_id === "8888888"));

  tenants.upsert({
    altegioCompanyId: "8888888",
    altegioUserToken: "t",
    altegioAccountId: "1",
    apipayApiKey: "k",
    apipayWebhookSecret: "s",
  });

  assert.equal(
    tenants.listPendingSalons().some((s) => s.altegio_company_id === "8888888"),
    false
  );
});

test("подпись от другого тела запроса не проходит", () => {
  const real = Buffer.from('{"invoice":{"id":1,"status":"paid"}}');
  const forged = '{"invoice":{"id":1,"status":"cancelled"}}';

  assert.equal(tenants.findByApipaySignature(real, sign(forged, "secret-a")), undefined);
});
