import { query } from "./client";

/**
 * The two People. A Google sign-in carries an address, and `people.email` is what
 * turns that address into the Person whose categories and entries are being read.
 *
 * The allow-list (src/domain/access) decides who may sign in; this decides which
 * of the two they are. They are separate questions and are configured separately —
 * an address on the allow-list with no matching Person row gets a signed-in shell
 * and no ledger, which is a clear failure rather than a silent misattribution.
 */

export interface Person {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

interface PersonRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  email: string;
}

function toPerson(row: PersonRow): Person {
  return { id: row.id, displayName: row.display_name, email: row.email };
}

export async function listPeople(): Promise<Person[]> {
  const rows = await query<PersonRow>(`select id, display_name, email from people order by id`);
  return rows.map(toPerson);
}

export async function findPersonByEmail(email: string | undefined | null): Promise<Person | null> {
  if (!email) return null;
  const rows = await query<PersonRow>(
    `select id, display_name, email
       from people
      where lower(email) = lower($1)`,
    [email.trim()],
  );
  const row = rows[0];
  return row === undefined ? null : toPerson(row);
}
