import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apipay-uninstall-"));
process.env.DB_PATH = path.join(tmp, "test.sqlite");
process.env.ALTEGIO_APPLICATION_ID = "2401";

import type * as AltegioWebhook from "../src/webhooks/altegio";
// require, а не import: модуль читает конфиг при загрузке.
const hook: typeof AltegioWebhook = require("../src/webhooks/altegio");

test("id приложения берётся из тела и из query", () => {
  assert.equal(hook.extractApplicationId({}, { application_id: "2332" }), "2332");
  assert.equal(hook.extractApplicationId({ app_id: 2401 }), "2401");
  assert.equal(hook.extractApplicationId({}, {}), undefined);
});

test("отключение чужого приложения салон не гасит", () => {
  // Ровно тот случай, что был на проде: Disconnect у приложения 2332
  // выключал нашу интеграцию.
  assert.equal(hook.isForeignUninstall("2332"), true);
});

test("отключение нашего приложения обрабатывается", () => {
  assert.equal(hook.isForeignUninstall("2401"), false);
});

test("без application_id доверяем событию", () => {
  // Altegio может не прислать id — тогда лучше отключить, чем игнорировать.
  assert.equal(hook.isForeignUninstall(undefined), false);
});
