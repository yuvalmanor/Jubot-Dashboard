# Jubot

A private household financial dashboard for two people. See [CONTEXT.md](CONTEXT.md) for the
domain language, [docs/adr](docs/adr) for the decisions, and [plans/jubot.md](plans/jubot.md)
for the phased build.

## Stack

Next.js (App Router) + TypeScript on Vercel, Postgres on Neon or Supabase, Tailwind,
Auth.js with Google OAuth restricted to two accounts. Everything stays on free tiers.

Domain modules under `src/domain/` import nothing from Next.js, React or the database
client ([ADR 0004](docs/adr/0004-framework-free-domain-modules-on-a-zero-cost-stack.md)).
They take plain data and return plain data; persistence and rendering wrap them from the
outside. `src/domain/architecture.test.ts` enforces this.

## Gates

All three must pass before anything is committed.

```bash
npm test && npx tsc --noEmit && npm run build
```

## Local development

1. `npm install`
2. `cp .env.example .env.local` and fill it in (see below).
3. Start a database. Either point `DATABASE_URL` at a real one and apply the SQL:
   ```bash
   psql "$DATABASE_URL" -f db/schema.sql -f db/seed.sql
   ```
   or run the bundled local one, which needs no install:
   ```bash
   npm run db:local
   ```
   `db:local` is PGlite — real Postgres compiled to WebAssembly — served over the ordinary
   wire protocol on port 5433, with `db/schema.sql` and `db/seed.sql` already applied. The
   app connects to it with the same `pg` client it uses against Neon. It is a
   devDependency: nothing in the deployed app imports it.
4. `npm run dev`

### Google OAuth client

In the Google Cloud console, create an OAuth 2.0 Client ID of type *Web application*.
Authorised redirect URIs:

- `http://localhost:3000/api/auth/callback/google`
- `https://<your-vercel-domain>/api/auth/callback/google`

Put the client ID and secret in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, and the two
household addresses in `JUBOT_ALLOWED_EMAILS`. An address outside that list is refused in
the `signIn` callback, so no session is ever issued for it.

## Deploying

1. Create a Postgres database on Neon or Supabase (free tier) and run `db/schema.sql` and
   `db/seed.sql` against it.
2. Import the repository into Vercel (Hobby plan).
3. Set `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `JUBOT_ALLOWED_EMAILS` and
   `DATABASE_URL` as environment variables in the Vercel project.
4. Add the deployed domain's callback URL to the Google OAuth client.
5. Deploy.

## Money

Every amount in the system is an integer number of minor units plus an explicit currency
code — never a float, never a bare number. `src/domain/money/money.ts` owns the arithmetic:
addition across currencies throws, conversion requires an explicit rate that names its
currency pair, and rounding happens at the minor-unit boundary, half away from zero. Rates
are read as exact decimals rather than doubles, so 3.65 means 365/100.
