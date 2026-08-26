import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../src/apipay";
import { recordAmount, recordServiceTitle, type AltegioRecord } from "../src/altegio";

function record(over: Partial<AltegioRecord>): AltegioRecord {
  return {
    id: 1,
    company_id: 1354369,
    staff_id: 3007652,
    visit_id: 1,
    services: [{ id: 1, title: "Маникюр", cost: 9000, cost_to_pay: 9000 }],
    client: { id: 1, phone: "+77001234567" },
    documents: [{ id: 1 }],
    paid_full: 0,
    prepaid: false,
    prepaid_confirmed: false,
    payment_status: 0,
    datetime: "2026-08-26T16:00:00+05:00",
    ...over,
  };
}

test("телефон приводится к формату ApiPay 8XXXXXXXXXX", () => {
  assert.equal(normalizePhone("+7 700 123-45-67"), "87001234567");
  assert.equal(normalizePhone("87001234567"), "87001234567");
  assert.equal(normalizePhone("7001234567"), "87001234567");
});

test("некорректный телефон отбрасывается — счёт не создастся", () => {
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizePhone("не телефон"), null);
});

test("запись без телефона клиента не даёт телефона для счёта", () => {
  const r = record({ client: null });
  assert.equal(normalizePhone(r.client?.phone ?? ""), null);
});

test("сумма считается по cost_to_pay всех услуг", () => {
  assert.equal(recordAmount(record({})), 9000);
  assert.equal(
    recordAmount(
      record({
        services: [
          { id: 1, title: "Маникюр", cost: 9000, cost_to_pay: 9000 },
          { id: 2, title: "Педикюр", cost: 5000, cost_to_pay: 5000 },
        ],
      })
    ),
    14000
  );
});

test("запись без суммы даёт 0 — счёт не создастся", () => {
  assert.equal(recordAmount(record({ services: [] })), 0);
  assert.equal(
    recordAmount(record({ services: [{ id: 1, title: "X", cost: 0, cost_to_pay: 0 }] })),
    0
  );
});

test("описание счёта собирается из названий услуг", () => {
  assert.equal(recordServiceTitle(record({})), "Маникюр");
  assert.equal(recordServiceTitle(record({ services: [] })), "Услуга");
});
