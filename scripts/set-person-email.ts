/**
 * Points one Person row at the address that actually signs in.
 *
 * `JUBOT_ALLOWED_EMAILS` decides *who may sign in*; `people.email` decides *which
 * of the two they are*. The two must agree, or an allowed address lands in a
 * signed-in shell with no ledger behind it. The README states this as a `psql`
 * one-liner, which a Windows checkout has no psql for — this needs nothing that is
 * not already a dependency, the same way `db:apply` does.
 *
 * It is deliberately one row and one column: there is no path here that writes an
 * entry, a category or anything else, so it can be run against a live database
 * without reading the rest of it.
 *
 *   npx vercel env pull .env.production.local
 *   npm run db:person -- yuval someone@gmail.com
 */

import pg from "pg";

const [personId, email] = process.argv.slice(2);

if (personId === undefined || email === undefined) {
  throw new Error("Usage: npm run db:person -- <personId> <email>");
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  throw new Error(`That does not look like an email address: ${email}`);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error(
    "DATABASE_URL is not set. Pull it with `npx vercel env pull .env.production.local`, " +
      "or set it in the environment before running this.",
  );
}

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

const client = new pg.Client({
  connectionString,
  ssl: local ? false : { rejectUnauthorized: true },
});

await client.connect();

// Host only, so the output says which database was touched without ever showing
// the password that came with it.
console.log(`connected to ${new URL(connectionString).host}`);

try {
  const updated = await client.query<{ id: string; email: string }>(
    `update people set email = $2 where id = $1 returning id, email`,
    [personId, email],
  );

  if (updated.rowCount === 0) {
    const known = await client.query<{ id: string }>(`select id from people order by id`);
    throw new Error(
      `No person ${personId}. There are exactly two: ${known.rows.map((row) => row.id).join(", ")}`,
    );
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
