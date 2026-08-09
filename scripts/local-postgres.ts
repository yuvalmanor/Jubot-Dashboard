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

const database = await PGlite.create();

for (const file of ["db/schema.sql", "db/seed.sql"]) {
  await database.exec(readFileSync(fileURLToPath(new URL(file, root)), "utf8"));
  console.log(`applied ${file}`);
}

const server = new PGLiteSocketServer({ db: database, port: PORT, host: "127.0.0.1" });
await server.start();
console.log(`local postgres listening on postgres://postgres@127.0.0.1:${PORT}/postgres`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
