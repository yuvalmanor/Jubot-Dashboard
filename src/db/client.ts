import { Pool } from "pg";

/**
 * Postgres access lives at the edge of the system (ADR 0004). Domain modules are
 * handed plain data; they never reach in here.
 */

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not set");
    this.name = "DatabaseNotConfiguredError";
  }
}

let pool: Pool | undefined;

function needsSsl(connectionString: string): boolean {
  if (process.env.DATABASE_SSL === "disable") return false;
  return !/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new DatabaseNotConfiguredError();
  }
  if (pool === undefined) {
    pool = new Pool({
      connectionString,
      ssl: needsSsl(connectionString) ? { rejectUnauthorized: true } : false,
      // Serverless: one connection per instance keeps a free-tier pool from filling up.
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // An idle client that dies — a dropped Neon connection, a restarted local
    // database — emits on the pool. Without a listener that becomes an unhandled
    // 'error' event and takes the process down; the pool itself recovers by
    // opening a fresh connection on the next query.
    pool.on("error", () => undefined);
  }
  return pool;
}

export async function query<Row extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const result = await getPool().query<Row>(text, values as unknown[]);
  return result.rows;
}

/** The same shape as `query`, but bound to one connection inside a transaction. */
export type TransactionQuery = <Row extends Record<string, unknown>>(
  text: string,
  values?: readonly unknown[],
) => Promise<Row[]>;

/**
 * Run a unit of work atomically. A Personal Category and its Household assignment
 * are written through here, because a state where one landed and the other did not
 * is exactly the state the model forbids.
 *
 * The callback must use the supplied runner. The pool holds a single connection,
 * so calling the module-level `query` from inside a transaction would wait on the
 * connection the transaction is already holding.
 */
export async function withTransaction<T>(work: (run: TransactionQuery) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const run: TransactionQuery = async (text, values = []) => {
    const result = await client.query(text, values as unknown[]);
    return result.rows as never;
  };

  try {
    await client.query("begin");
    const outcome = await work(run);
    await client.query("commit");
    client.release();
    return outcome;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    // Discard rather than return to the pool. A connection whose transaction
    // failed part-way through is not provably in a clean protocol state, and the
    // next query on it would read the wrong thing rather than fail loudly. The
    // pool opens a fresh one; for two users that costs nothing worth keeping.
    client.release(true);
    throw error;
  }
}
