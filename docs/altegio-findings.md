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
