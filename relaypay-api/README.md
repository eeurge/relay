# relaypay-api

Google sign-in API for Relay. Uses the same Aiven MySQL as the main site (`DATABASE_URL`). There is no Postgres.

## Render env vars

Set these on the API web service (do not put values in git):

- `SITE_ORIGIN`
- `GOOGLE_CLIENT_ID`
- `DATABASE_URL`
- `SIGNUP_ACCESS_KEY`

`DATABASE_URL` is the Aiven MySQL Service URI (`mysql://...`). The server creates `rp_users` and `rp_sessions` on boot. New Google accounts also need `SIGNUP_ACCESS_KEY`. Existing accounts can sign in without it.

The homepage prefers same-origin `/api/auth/google` on the main Relay web service. Set `GOOGLE_CLIENT_ID` and `SIGNUP_ACCESS_KEY` there too.

Bind the service to `https://api.relaypayus.shop`.

## Homepage

Leave `data-google-client-id` empty in git. Set it on the `/js/relaypay-auth.js` script tag on the live site, or leave it blank and the page will load the client id from `GET /auth/config`.

## Cloudflare DNS

If `api.relaypayus.shop` is not already pointing at this Render service, add a CNAME:

- Name: `api`
- Target: the hostname Render shows for the API service (usually `*.onrender.com`)
