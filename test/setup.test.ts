import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// База создаётся при импорте модуля, поэтому путь подменяем заранее.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apipay-altegio-setup-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PUBLIC_BASE_URL = "https://altegio.apipay.kz/";

// require, а не import: статический import сработал бы раньше подмены DB_PATH.
const setup = require("../src/setup") as typeof import("../src/setup");
const tenants = require("../src/tenants") as typeof import("../src/tenants");
const { db } = require("../src/db") as typeof import("../src/db");

test("ID филиала находится под любым из имён, которые шлёт Altegio", () => {
  assert.equal(setup.extractCompanyId({ salon_id: "1354369" }), "1354369");
  assert.equal(setup.extractCompanyId({ company_id: 1354369 }), "1354369");
  assert.equal(setup.extractCompanyId({}, { salonId: "42" }), "42");
});

test("нечисловые и пустые значения за ID филиала не принимаются", () => {
  assert.equal(setup.extractCompanyId({ salon_id: "" }), undefined);
  assert.equal(setup.extractCompanyId({ salon_id: "не число" }), undefined);
  assert.equal(setup.extractCompanyId(undefined, "строка", 5), undefined);
});

test("ссылка на настройку находится по своему токену", () => {
  const session = setup.createSession("1354369");
  const found = setup.findSession(session.token);

  assert.equal(found?.altegio_company_id, "1354369");
  assert.equal(setup.setupUrl(session.token), `https://altegio.apipay.kz/setup/${session.token}`);
});

test("чужой токен ничего не открывает", () => {
  assert.equal(setup.findSession("подобранный-токен"), undefined);
});

test("ссылка без известного филиала создаётся — салон введёт ID сам", () => {
  const session = setup.createSession(undefined);
  assert.equal(setup.findSession(session.token)?.altegio_company_id, null);
});

test("просроченная ссылка не открывается и вычищается", () => {
  const session = setup.createSession("1000009");
  db.prepare("UPDATE setup_sessions SET expires_at = datetime('now', '-1 hour') WHERE token = ?").run(
    session.token
  );

  assert.equal(setup.findSession(session.token), undefined);
  assert.ok(setup.purgeExpiredSessions() >= 1);
});

test("после настройки в ссылке остаётся филиал и отметка о завершении", () => {
  const session = setup.createSession(undefined);
  setup.completeSession(session.token, "1000010");

  const done = setup.findSession(session.token);
  assert.equal(done?.altegio_company_id, "1000010");
  assert.ok(done?.completed_at);
});

test("отключение приложения выводит салон из обслуживания", () => {
  tenants.upsert({
    altegioCompanyId: "1000011",
    altegioUserToken: "user-token",
    altegioAccountId: "111",
    apipayApiKey: "key",
    apipayWebhookSecret: "secret",
  });

  assert.ok(tenants.findByCompanyId("1000011"));
  assert.equal(tenants.deactivate("1000011"), true);
  assert.equal(tenants.findByCompanyId("1000011"), undefined);
  assert.equal(tenants.deactivate("1000011"), false);
});
