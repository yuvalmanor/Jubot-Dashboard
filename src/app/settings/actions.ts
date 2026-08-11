"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { findPersonByEmail } from "@/db/people";
import {
  saveAllocationTargets,
  saveAppreciation,
  saveConcentrationAccounts,
} from "@/db/settings";
import {
  InvalidAllocationTargetError,
  InvalidAppreciationError,
  buildAllocationTargets,
  buildAppreciationAssumption,
} from "@/domain/networth/net-worth-analytics";
import { ASSET_CATEGORIES } from "@/domain/snapshot/snapshot";
import { requireHouseholdEmail } from "@/session";

/**
 * The household's dials. Nothing written here is a measurement — these are the
 * numbers the household chose — so every one of them is stored rather than
 * compiled in, and every screen that uses one says which one it used.
 *
 * Either Person may set any of them: an assumption about property or a רצוי
 * target is a household position, not one Person's own naming.
 */

export type SettingsErrorCode =
  | "no-person"
  | "bad-appreciation"
  | "bad-targets"
  | "failed";

interface Outcome {
  readonly code: SettingsErrorCode | null;
  readonly detail?: string;
  readonly done?: string;
}

function backTo(outcome: Outcome): never {
  const params = new URLSearchParams();
  if (outcome.code !== null) params.set("error", outcome.code);
  if (outcome.detail !== undefined) params.set("detail", outcome.detail);
  if (outcome.done !== undefined) params.set("done", outcome.done);
  const search = params.toString();
  redirect(search.length === 0 ? "/settings" : `/settings?${search}`);
}

function failureFor(error: unknown): Outcome {
  if (error instanceof InvalidAppreciationError) {
    return { code: "bad-appreciation", detail: error.message };
  }
  if (error instanceof InvalidAllocationTargetError) {
    return { code: "bad-targets", detail: error.message };
  }
  return { code: "failed" };
}

function readText(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

/**
 * A percentage as the household types it — `3`, `3.5`, blank for none — read into
 * whole basis points. Blank is nought rather than a refusal: "we assume nothing"
 * is a position, and it is the one the system starts from.
 */
function readBasisPoints(
  form: FormData,
  field: string,
  what: string,
  fail: (message: string) => Error,
): number {
  const text = readText(form, field).trim().replace("%", "");
  if (text.length === 0) return 0;

  const percent = Number(text);
  if (!Number.isFinite(percent)) {
    throw fail(`${what} is not a number: ${JSON.stringify(text)}`);
  }
  const basisPoints = Math.round(percent * 100);
  if (Math.abs(percent * 100 - basisPoints) > 1e-9) {
    throw fail(`${what} is finer than a hundredth of a percent`);
  }
  return basisPoints;
}

async function requireSignedIn(): Promise<void> {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email);
  if (person === null) {
    backTo({ code: "no-person", detail: email });
  }
}

async function run(work: () => Promise<Outcome>): Promise<never> {
  let outcome: Outcome;
  try {
    outcome = await work();
  } catch (error) {
    outcome = failureFor(error);
  }
  revalidatePath("/settings");
  revalidatePath("/net-worth");
  backTo(outcome);
}

/** The property-appreciation assumption. A setting, so it can be argued with. */
export async function setAppreciation(form: FormData): Promise<void> {
  await requireSignedIn();

  await run(async () => {
    const assumption = buildAppreciationAssumption(
      readBasisPoints(
        form,
        "appreciation",
        "הנחת עליית הערך",
        (message) => new InvalidAppreciationError(message),
      ),
    );
    await saveAppreciation(assumption);
    return { code: null, done: "appreciation" };
  });
}

/** The רצוי targets, written as one set — a bucket left blank is left untargeted. */
export async function setAllocationTargets(form: FormData): Promise<void> {
  await requireSignedIn();

  await run(async () => {
    const targets = buildAllocationTargets(
      ASSET_CATEGORIES.map((category) => ({
        category,
        basisPoints: readBasisPoints(
          form,
          `target:${category}`,
          `היעד ל־${category}`,
          (message) => new InvalidAllocationTargetError(message),
        ),
      })),
    );
    await saveAllocationTargets(targets);
    return { code: null, done: "targets" };
  });
}

/**
 * Which accounts a concentration is watched on. Named by id rather than matched on
 * a name, so renaming the Apple RSU account cannot silently make the concentration
 * read as nothing.
 */
export async function setConcentrationAccounts(form: FormData): Promise<void> {
  await requireSignedIn();

  await run(async () => {
    const ids = form.getAll("accountId").filter((value): value is string => typeof value === "string");
    await saveConcentrationAccounts(ids);
    return { code: null, done: "concentration" };
  });
}
