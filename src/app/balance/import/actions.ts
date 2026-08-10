"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DatabaseNotConfiguredError } from "@/db/client";
import { SheetExportMissingError, applyImportPlan } from "@/db/import";
import { findPersonByEmail } from "@/db/people";
import { type ImportProposal, conflictKey, planSummary, planWrites } from "@/domain/import/sheet-importer";
import { monthKey } from "@/domain/time/calendar-month";
import { requireHouseholdEmail } from "@/session";

import { loadProposal } from "./proposal";

/**
 * The one write in this feature.
 *
 * The form carries corrections, not data: which proposals were confirmed, the
 * household name each joins, and how any reported conflict was settled. The
 * proposal itself is recomputed from the committed export, so what gets written
 * is always the export as this codebase reads it plus the household's decisions —
 * never a stale copy carried through a browser.
 */

export type ImportErrorCode =
  | "no-person"
  | "no-export"
  | "nothing-selected"
  | "no-database"
  | "stale-form"
  | "failed";

/** The form and the proposal it was rendered from no longer line up. */
class StaleFormError extends Error {
  constructor() {
    super("The submitted form does not match the current proposal");
    this.name = "StaleFormError";
  }
}

function backTo(params: Record<string, string>): never {
  const query = new URLSearchParams(params).toString();
  redirect(query.length === 0 ? "/balance/import" : `/balance/import?${query}`);
}

/**
 * Fields are numbered, never named after the category.
 *
 * A category name may contain a double quote — `שכ"ד` and `חו"ל` both do — and a
 * quote inside a multipart field *name* closes it early, so those fields arrive
 * mangled and the categories go missing without any error. Positions are the
 * proposal's own order, which is deterministic because `planSheetImport` is pure
 * and the export is a committed file; the counts below are what catches the case
 * where it is not.
 */
function readSelection(proposal: ImportProposal, form: FormData) {
  const conflicts = proposal.flags.filter((flag) => flag.kind === "overlap-conflict");

  if (
    Number(form.get("categoryCount")) !== proposal.categories.length ||
    Number(form.get("conflictCount")) !== conflicts.length
  ) {
    throw new StaleFormError();
  }

  const includedKeys = new Set<string>();
  const householdNames = new Map<string, string>();
  const conflictChoices = new Map<string, number>();

  proposal.categories.forEach((category, index) => {
    if (form.get(`include:${index}`) === "1") includedKeys.add(category.key);

    const household = form.get(`household:${index}`);
    if (typeof household === "string") householdNames.set(category.key, household);
  });

  conflicts.forEach((conflict, index) => {
    const chosen = form.get(`conflict:${index}`);
    const minorUnits = Number(chosen);
    // A radio whose value did not survive the round trip is dropped rather than
    // written as a zero, which would be a figure nobody chose.
    if (typeof chosen === "string" && Number.isSafeInteger(minorUnits)) {
      conflictChoices.set(conflictKey(conflict.categoryKey, conflict.month), minorUnits);
    }
  });

  return { includedKeys, householdNames, conflictChoices };
}

function codeFor(error: unknown): ImportErrorCode {
  if (error instanceof SheetExportMissingError) return "no-export";
  if (error instanceof DatabaseNotConfiguredError) return "no-database";
  if (error instanceof StaleFormError) return "stale-form";
  return "failed";
}

export async function runImport(form: FormData): Promise<void> {
  const email = await requireHouseholdEmail();

  let outcome: Record<string, string>;
  try {
    const person = await findPersonByEmail(email);
    if (person === null) backTo({ error: "no-person", detail: email });

    const { proposal } = await loadProposal();
    const plan = planWrites(proposal, readSelection(proposal, form));

    if (plan.categories.length === 0) backTo({ error: "nothing-selected" });

    const written = await applyImportPlan(plan);
    const span = planSummary(plan);

    outcome = {
      done: "1",
      categories: String(written.categories),
      entries: String(written.entries),
      months: String(span.months),
      ...(span.from === null ? {} : { from: monthKey(span.from) }),
      ...(span.to === null ? {} : { to: monthKey(span.to) }),
    };
  } catch (error) {
    // `redirect` works by throwing; letting it through is how backTo returns.
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
    if (typeof error === "object" && error !== null && "digest" in error) throw error;
    outcome = { error: codeFor(error) };
  }

  revalidatePath("/balance");
  revalidatePath("/balance/categories");
  revalidatePath("/balance/import");
  backTo(outcome);
}
