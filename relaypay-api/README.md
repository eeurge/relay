# relaypay-api

Google sign-in API for Relay. This is a separate Postgres service. Do not point it at the Aiven MySQL `DATABASE_URL`.

## Render env vars

Set these on the API service (no values in git):

- `SITE_ORIGIN`
- `GOOGLE_CLIENT_ID`
- `POSTGRES_URL`

`DATABASE_URL` is used only when it starts with `postgres://` or `postgresql://`. The MySQL Aiven URI will be ignored. Set `POSTGRES_URL` to the Postgres connection string.

Apply `schema.sql` on first boot (the server also runs it at startup). Bind the service to `https://api.relaypayus.shop`.
