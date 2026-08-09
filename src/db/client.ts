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
  pool ??= new Pool({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: true } : false,
    // Serverless: one connection per instance keeps a free-tier pool from filling up.
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function query<Row extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const result = await getPool().query<Row>(text, values as unknown[]);
  return result.rows;
}
