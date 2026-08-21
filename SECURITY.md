# Security notes

## Telegram bootstrap routes

`POST /telegram/setup` is an admin-only bootstrap endpoint. Once a Telegram chat is configured, either through the `TELEGRAM_CHAT_ID` Worker variable or the legacy persisted `telegram:chat_id:v1` KV value, the deployed Worker returns `404 Not Found` for this route and performs no Telegram setup work.

`POST /telegram/test` always requires the same `ADMIN_TOKEN` authentication used by the other administrative routes.
