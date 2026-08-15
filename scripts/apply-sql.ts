/**
 * Applies `db/schema.sql` and `db/seed.sql` to whatever `DATABASE_URL` points at.
 *
 * The README's `psql -f` does the same job, but psql is a separate install that a
 * Windows checkout will not usually have. This needs nothing that is not already
 * a dependency: the same `pg` client the app connects to Neon with.
 *
 * Both files are idempotent — every statement is `if not exists` or an upsert — so
 * running this against an existing database is how a schema change is applied, not
 * only how an empty one is filled.
 *
 * The connection string is never printed. Pull it into a gitignored file first:
 *
 *   npx vercel env pull .env.production.local
 *   npm run db:apply
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";

const FILES = ["db/schema.sql", "db/seed.sql"];

const root = new URL("../", import.meta.url);

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error(
    "DATABASE_URL is not set. Pull it with `npx vercel env pull .env.production.local`, " +
      "or set it in the environment before running this.",
  );
}

// The same rule the app applies: TLS everywhere except a local database.
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

const client = new pg.Client({
  connectionString,
  ssl: local ? false : { rejectUnauthorized: true },
});

await client.connect();

// Host only, so the output says which database was touched without ever showing
// the password that came with it.
const host = new URL(connectionString).host;
console.log(`connected to ${host}`);

try {
  for (const file of FILES) {
    await client.query(readFileSync(fileURLToPath(new URL(file, root)), "utf8"));
    console.log(`applied ${file}`);
  }

  const people = await client.query<{ id: string; email: string }>(
    `select id, email from people order by id`,
  );
  console.log("\npeople rows — these must match JUBOT_ALLOWED_EMAILS:");
  for (const row of people.rows) {
    console.log(`  ${row.id.padEnd(6)} ${row.email}`);
  }
} finally {
  await client.end();
}
