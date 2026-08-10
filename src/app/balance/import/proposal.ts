import { readSheetExport } from "@/db/import";
import { type Person, listPeople } from "@/db/people";
import { parseSheetExport } from "@/domain/import/sheet-export";
import { type ImportProposal, planSheetImport } from "@/domain/import/sheet-importer";

/**
 * The proposal, derived from the committed export on every read.
 *
 * Nothing about it is stored. `planSheetImport` is pure, so the screen and the
 * action that writes both compute the same proposal from the same file — the
 * form only has to carry the corrections a person made to it, never the proposal
 * itself.
 */

/** The ledger is kept in shekels, as elsewhere. Explicit, never inferred. */
export const IMPORT_CURRENCY = "ILS" as const;

export interface LoadedProposal {
  readonly proposal: ImportProposal;
  readonly people: readonly Person[];
}

/** The sheet's banner names a Person by their display name: `יובל`, `עדן`. */
export async function loadProposal(): Promise<LoadedProposal> {
  const [markdown, people] = await Promise.all([readSheetExport(), listPeople()]);

  const proposal = planSheetImport(parseSheetExport(markdown, { currency: IMPORT_CURRENCY }), {
    currency: IMPORT_CURRENCY,
    people: people.map((person) => ({ id: person.id, sheetName: person.displayName })),
  });

  return { proposal, people };
}
