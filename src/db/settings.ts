import {
  type AllocationTargets,
  type AppreciationAssumption,
  NO_APPRECIATION,
  buildAllocationTargets,
  buildAppreciationAssumption,
} from "@/domain/networth/net-worth-analytics";
import { type AssetCategory, ASSET_CATEGORIES } from "@/domain/snapshot/snapshot";

import { query, withTransaction } from "./client";

/**
 * The household's own dials. Everything here is a number somebody chose rather
 * than a number anybody measured, which is exactly why none of it is a constant in
 * the code: an assumption that can only change by shipping a deploy stops reading
 * as an assumption.
 *
 * Values are stored as text and parsed here, once, into the domain types that
 * validate them. A row nobody has written yet reads as its default, and the
 * default is always the one that asserts least — no appreciation, no targets, no
 * account watched.
 */

const APPRECIATION_KEY = "appreciation.property_bp";
const TARGET_PREFIX = "allocation_target.";
const CONCENTRATION_KEY = "concentration.account_ids";

interface SettingRow extends Record<string, unknown> {
  key: string;
  value: string;
}

export class MalformedSettingError extends Error {
  constructor(key: string, detail: string) {
    super(`Setting "${key}" is malformed: ${detail}`);
    this.name = "MalformedSettingError";
  }
}

export interface HouseholdSettings {
  readonly appreciation: AppreciationAssumption;
  readonly targets: AllocationTargets;
  /** The accounts whose share of total wealth is watched — the Apple RSU holding. */
  readonly concentrationAccountIds: readonly string[];
}

export const DEFAULT_SETTINGS: HouseholdSettings = {
  appreciation: NO_APPRECIATION,
  targets: [],
  concentrationAccountIds: [],
};

function wholeNumber(key: string, text: string): number {
  const value = Number(text.trim());
  if (!Number.isInteger(value)) {
    throw new MalformedSettingError(key, `${JSON.stringify(text)} is not a whole number`);
  }
  return value;
}

export async function loadHouseholdSettings(): Promise<HouseholdSettings> {
  const rows = await query<SettingRow>(`select key, value from settings`);
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const appreciation = byKey.get(APPRECIATION_KEY);
  const concentration = byKey.get(CONCENTRATION_KEY);

  const targets = ASSET_CATEGORIES.flatMap((category) => {
    const stored = byKey.get(`${TARGET_PREFIX}${category}`);
    if (stored === undefined) return [];
    return [{ category, basisPoints: wholeNumber(`${TARGET_PREFIX}${category}`, stored) }];
  });

  return {
    appreciation:
      appreciation === undefined
        ? DEFAULT_SETTINGS.appreciation
        : buildAppreciationAssumption(wholeNumber(APPRECIATION_KEY, appreciation)),
    targets: buildAllocationTargets(targets),
    concentrationAccountIds:
      concentration === undefined ? [] : splitIds(concentration),
  };
}

function splitIds(text: string): readonly string[] {
  return text
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

async function put(key: string, value: string): Promise<void> {
  await query(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

export async function saveAppreciation(assumption: AppreciationAssumption): Promise<void> {
  await put(APPRECIATION_KEY, String(assumption.annualBasisPoints));
}

/**
 * Write the whole set at once. A target left out is deleted rather than left
 * behind: the household setting no target for a bucket and the household having
 * once set one are different states, and a stale row would make them look alike.
 */
export async function saveAllocationTargets(targets: AllocationTargets): Promise<void> {
  const wanted = new Map<AssetCategory, number>(
    targets.map((target) => [target.category, target.basisPoints]),
  );

  await withTransaction(async (run) => {
    for (const category of ASSET_CATEGORIES) {
      const key = `${TARGET_PREFIX}${category}`;
      const basisPoints = wanted.get(category);
      if (basisPoints === undefined) {
        await run(`delete from settings where key = $1`, [key]);
        continue;
      }
      await run(
        `insert into settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, String(basisPoints)],
      );
    }
  });
}

export async function saveConcentrationAccounts(accountIds: readonly string[]): Promise<void> {
  await put(CONCENTRATION_KEY, [...new Set(accountIds)].join(","));
}
