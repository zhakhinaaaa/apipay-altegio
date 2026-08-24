# apipay-altegio-app

Интеграция Altegio ↔ ApiPay: автоматическое выставление счёта на предоплату при записи клиента и подтверждение оплаты в Altegio после оплаты счёта. Работает только в тестовом режиме (Altegio test-кабинет + ApiPay sandbox), реальные деньги не списываются.

Статус: в разработке. Разделы ниже будут дополняться по мере готовности шагов (см. план в репозитории).

## Стек

- Node.js 20 + TypeScript
- Fastify — HTTP-сервер
- better-sqlite3 — хранение связки `altegio_record_id ↔ apipay_invoice_id`
- Docker Compose — запуск
- ngrok — приём вебхуков локально

## Установка

```bash
npm install
cp .env.example .env
```

Заполните `.env` своими sandbox-ключами (см. ниже — раздел про доступы будет дополнен на шаге подключения ApiPay/Altegio).

## Запуск (разработка, без Docker)

```bash
npm run dev
```

Проверка: `GET http://localhost:3000/health` → `{"status":"ok","db":true}`

## Запуск через Docker Compose

```bash
docker compose up --build
```

Имя контейнера: `apipay-altegio-app`.

## Дальше (будет дополнено)

- как настроить вебхуки ApiPay и Altegio через ngrok;
- как создать тестовую запись и провести сквозной тест оплаты;
- какие ограничения остались.
