# Altegio: результаты разведки тестового кабинета

Дата: 2026-08-26. Все данные — тестовые, секретов здесь нет.

## Доступ

- Партнёр: ID `2548`, приложение ApiPay1.
- Авторизация: `Authorization: Bearer <partner_token>, User <user_token>`,
  заголовок `Accept: application/vnd.api.v2+json`.
- User token берётся через `POST /auth` под учёткой тестового кабинета.
  Токен аккаунта разработчика прав на компании НЕ даёт (`companies?my=1` пуст,
  `records/{id}` → 403 Insufficient rights).

## Сущности тестовой компании

| Что | ID | Значение |
|---|---|---|
| Компания | `1354369` | ApiPay |
| Услуга | `13794356` | Маникюр, cost 9000 |
| Сотрудники | `3007652`, `3007653` | Сотрудник 1, Георгий |
| Клиент | `185875876` | Тестовый, `+77001234567` |
| Запись | `668216530` | visit_id `570290965` |
| Кассы | `2747574` / `2747575` | Основная касса (cash) / Расчетный счет (cashless) |

## Поля записи, относящиеся к оплате

Из `GET /record/{company_id}/{record_id}`:

- `services[].cost` / `cost_to_pay` — стоимость услуги (9000).
- `client.phone` — `+77001234567`, для ApiPay нормализуем в `8XXXXXXXXXX`.
- `paid_full` = 0
- `prepaid` = false
- `prepaid_confirmed` = false
- `payment_status` = 0
- `visit_id`, `documents[0].id` — документ визита, к нему привязываются
  финансовые транзакции.

Важно: у обоих сотрудников `prepaid = "forbidden"` — штатный механизм
предоплаты Altegio на уровне сотрудника сейчас выключен.

`GET /transactions/{company_id}` — пусто, транзакций ещё нет.


## Подключение приложения (рабочая схема)

Altegio шлёт вебхуки только приложению, **подключённому к филиалу**.
Прописать webhook URL в кабинете разработчика недостаточно.

1. Кабинет разработчика → приложение типа **Non-public** (модерация не нужна).
2. Connection settings:
   - Address to send notifications to → `<public>/webhooks/altegio`
   - Callback Url → `<public>/altegio/uninstall`
   - Registration Redirect Url → `<public>/altegio/install`
   Подключение завершается только если Registration Redirect Url отвечает.
3. API Access → отметить права **до** подключения. Системный пользователь
   добавляется в филиал с теми правами, что заданы на момент подключения;
   после изменения прав нужно Disconnect + Connect заново.
4. API Access отдаёт **системный User Token** приложения — интеграция должна
   ходить в API под ним, а не под личным токеном сотрудника.

Тестовое приложение: ID `2315`, `apipay_prepay_test`, аккаунт разработчика
ApiPay1 (партнёр 2548).

## Проверенная сквозная цепочка

    POST /webhooks/altegio  <- Altegio (UA GuzzleHttp/7), 2 события, 1 счёт
    POST /webhooks/apipay   <- ApiPay  (UA Kaspi-Pay-API/1.0)
    -> приход 9000 в кассе «Расчетный счет», комментарий со счётом

## Маркетплейс: что выяснилось 2026-08-28

### Подключение салона

- **Registration Redirect Url работает только у Public-приложения.** Пока
  приложение было Non-public, кнопка Connect подключала салон молча: браузер
  оставался в карточке приложения, на наш адрес не приходило ничего. После
  переключения на Public тот же Connect стал вести на
  `GET /altegio/install?salon_id=<company_id>`.
- Обе галочки под Registration Redirect Url работают, но им нужно сохранение
  **и** новое подключение — на подключениях, сделанных до сохранения, эффекта
  нет. «Open registration form in iframe» добавляет в карточку приложения
  вкладку **Settings**, внутри которой открывается наша страница. «Pass user
  data» добавляет к редиректу `user_data` и `user_data_sign`.
- `user_data` — base64 от JSON с полями `id`, `name`, `phone`, `email`,
  `is_approved`, `avatar`, `salon_name`. Это профиль сотрудника, который
  подключает приложение. **Токена там нет**, доступа к финансам он не даёт.
  `user_data_sign` — 64 hex-символа, похоже на HMAC-SHA256; проверка подписи
  не реализована.
- Вкладка Settings при каждом открытии сначала прогоняет экран согласия
  Altegio, и только после «Continue» отдаёт управление нашей странице.
- Отключение приходит на Callback Url: `POST /altegio/uninstall`, тело
  `{salon_id, application_id, event: "uninstall", partner_token}`.
  Обратного события при повторном подключении Altegio **не присылает** —
  поэтому у CLI есть `enable`.

### Чего приложению нельзя

Системный User Token приложения (раздел API Access) даёт читать сотрудников,
услуги, компанию и записи, но **не финансы филиала**:

    GET /accounts/{company_id}      → No rights to manage the location
    GET /transactions/{company_id}  → No rights to manage the location

Так отвечает и при полностью выданных правах (Finance 13/13, Settings 30/30).
Обходных путей нет: без `User` заголовка — «No user ID specified»,
`/company/{id}/accounts` и `/api/v2/...` — «An error occurred».

При этом запись работает, и касса в ней обязательна:

    POST /finance_transactions/{company_id} с пустым телом
      → Cash register ID is required

Отсюда и решение: номер кассы салон вводит на странице настройки сам.
`listAccounts` в коде оставлен — если Altegio когда-нибудь откроет доступ,
форма сразу начнёт подставлять кассу без вопросов.
