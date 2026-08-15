import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * A local Postgres for development, with no install and no cost. PGlite is real
 * Postgres compiled to WebAssembly; the socket server puts it behind the ordinary
 * wire protocol, so the app connects with the same `pg` client and the same
 * DATABASE_URL it uses against Neon.
 *
 * Run with:  npx tsx scripts/local-postgres.ts     (or: node --experimental-strip-types)
 * Then:      DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres DATABASE_SSL=disable npm run dev
 */

const PORT = Number(process.env.LOCAL_PG_PORT ?? 5433);
const root = new URL("../", import.meta.url);

/**
 * Held on disk rather than in memory, so a restart keeps whatever was entered.
 * An in-memory database is fine for a verification run that seeds what it needs,
 * and hostile to actually using the app: an afternoon of typing disappears with
 * the process. `LOCAL_PG_DATA=memory://` opts back into the throwaway behaviour.
 */
const DATA_DIR = process.env.LOCAL_PG_DATA ?? fileURLToPath(new URL(".pglite/", root));

const database = await PGlite.create(DATA_DIR);
console.log(DATA_DIR.startsWith("memory:") ? "using an in-memory database" : `data directory ${DATA_DIR}`);

for (const file of ["db/schema.sql", "db/seed.sql"]) {
  await database.exec(readFileSync(fileURLToPath(new URL(file, root)), "utf8"));
  console.log(`applied ${file}`);
}

// maxConnections defaults to 1, and a single-slot server wedges when a client is
// replaced rather than closed cleanly — a restarted dev server, or a pooled
// connection discarded after a failed transaction. Every later connection then
// resets. A handful of slots costs nothing and keeps the local database usable.
const server = new PGLiteSocketServer({
  db: database,
  port: PORT,
  host: "127.0.0.1",
  maxConnections: 8,
});
await server.start();
console.log(`local postgres listening on postgres://postgres@127.0.0.1:${PORT}/postgres`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
