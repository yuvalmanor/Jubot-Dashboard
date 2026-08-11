import {
  type AllocationTargets,
  type AppreciationAssumption,
  NO_APPRECIATION,
  buildAllocationTargets,
  buildAppreciationAssumption,
} from "@/domain/networth/net-worth-analytics";
import { type Currency, isCurrency, money } from "@/domain/money/money";
import {
  type GpWindow,
  DEFAULT_GP_WINDOW,
  buildGpWindow,
  gpWindowKey,
  parseGpWindow,
  sharePrice,
} from "@/domain/rsu/rsu-position";
import {
  type FeeSchedule,
  type TaxRates,
  NO_FEES,
  SECTION_102_RATES,
  buildFeeSchedule,
  buildTaxRates,
} from "@/domain/rsu/rsu-tax";
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
const MARKET_MOVING_KEY = "decomposition.market_account_ids";
const GP_WINDOW_KEY = "rsu.gp_window";
const ORDINARY_RATE_KEY = "rsu.tax.ordinary_bp";
const CAPITAL_GAINS_RATE_KEY = "rsu.tax.capital_gains_bp";
const BROKER_PER_SHARE_KEY = "rsu.fees.broker_per_share";
const BROKER_FLAT_KEY = "rsu.fees.broker_flat";
const TRUSTEE_FEE_KEY = "rsu.fees.trustee_bp";

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
  /**
   * The accounts the household says move on their own. Everything else that moved
   * between two snapshots is money that went in or came out. Empty is the position
   * the system starts from, not a setting nobody got round to.
   */
  readonly marketMovingAccountIds: readonly string[];
  /**
   * The span of closes a GP estimate averages. A setting precisely because which
   * window סעיף 102 means is the open question — the household confirms it against
   * an ESOP statement and corrects it here, with no deploy involved.
   */
  readonly gpWindow: GpWindow;
  /**
   * The two rates a sale can meet. Settings rather than constants because a
   * marginal rate that could only move by shipping a deploy would stop reading as
   * the household's belief and start reading as a fact of the world.
   */
  readonly taxRates: TaxRates;
  /** What the broker and the trustee charge. Facts about them, not about the code. */
  readonly fees: FeeSchedule;
}

export const DEFAULT_SETTINGS: HouseholdSettings = {
  appreciation: NO_APPRECIATION,
  targets: [],
  concentrationAccountIds: [],
  marketMovingAccountIds: [],
  gpWindow: DEFAULT_GP_WINDOW,
  taxRates: SECTION_102_RATES,
  fees: NO_FEES,
};

/**
 * A fee amount as it is stored: an integer and the currency it is an amount of,
 * `1900:USD`. The currency is not assumed, because a commission is charged in the
 * broker's currency and nothing here may convert it at a rate nobody named.
 */
function splitAmount(key: string, text: string): { units: number; currency: Currency } {
  const [units = "", currency = ""] = text.trim().split(":");
  const value = Number(units);
  if (!Number.isSafeInteger(value)) {
    throw new MalformedSettingError(key, `${JSON.stringify(units)} is not a whole number`);
  }
  if (!isCurrency(currency)) {
    throw new MalformedSettingError(key, `unknown currency ${JSON.stringify(currency)}`);
  }
  return { units: value, currency };
}

/** A stored commission per share — ten-thousandths, the scale a price is held at. */
function storedPrice(key: string, text: string) {
  const { units, currency } = splitAmount(key, text);
  return sharePrice(units, currency);
}

/** A stored flat charge — minor units, the scale money is held at. */
function storedMoney(key: string, text: string) {
  const { units, currency } = splitAmount(key, text);
  return money(units, currency);
}

/** How a fee amount goes back — `1900:USD`. The inverse of `splitAmount`. */
function joinAmount(units: number, currency: Currency): string {
  return `${units}:${currency}`;
}

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
  const marketMoving = byKey.get(MARKET_MOVING_KEY);
  const gpWindow = byKey.get(GP_WINDOW_KEY);
  const ordinary = byKey.get(ORDINARY_RATE_KEY);
  const capitalGains = byKey.get(CAPITAL_GAINS_RATE_KEY);
  const brokerPerShare = byKey.get(BROKER_PER_SHARE_KEY);
  const brokerFlat = byKey.get(BROKER_FLAT_KEY);
  const trustee = byKey.get(TRUSTEE_FEE_KEY);

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
    marketMovingAccountIds: marketMoving === undefined ? [] : splitIds(marketMoving),
    gpWindow: gpWindow === undefined ? DEFAULT_GP_WINDOW : parseGpWindow(gpWindow),
    taxRates: buildTaxRates({
      ordinaryBasisPoints:
        ordinary === undefined
          ? SECTION_102_RATES.ordinaryBasisPoints
          : wholeNumber(ORDINARY_RATE_KEY, ordinary),
      capitalGainsBasisPoints:
        capitalGains === undefined
          ? SECTION_102_RATES.capitalGainsBasisPoints
          : wholeNumber(CAPITAL_GAINS_RATE_KEY, capitalGains),
    }),
    fees: buildFeeSchedule({
      brokerPerShare: brokerPerShare === undefined ? null : storedPrice(BROKER_PER_SHARE_KEY, brokerPerShare),
      brokerFlat: brokerFlat === undefined ? null : storedMoney(BROKER_FLAT_KEY, brokerFlat),
      trusteeBasisPoints: trustee === undefined ? 0 : wholeNumber(TRUSTEE_FEE_KEY, trustee),
    }),
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

/**
 * Which accounts a change decomposition reads as moving on their own. A
 * cost-held account is refused the mark by the decomposition itself (ADR 0003),
 * so nothing here has to remember to.
 */
export async function saveMarketMovingAccounts(accountIds: readonly string[]): Promise<void> {
  await put(MARKET_MOVING_KEY, [...new Set(accountIds)].join(","));
}

/**
 * The GP estimation window. Stored rather than compiled in because the correct
 * window for סעיף 102 is exactly the thing that needs confirming — and an estimate
 * already taken keeps the window it was taken under, so changing this corrects the
 * next reading rather than silently rewriting the last one.
 */
export async function saveGpWindow(window: GpWindow): Promise<void> {
  await put(GP_WINDOW_KEY, gpWindowKey(buildGpWindow(window)));
}

/**
 * The two rates a sale can meet. 62.17% and 25% are what the household believes
 * סעיף 102 charges, and a belief belongs in a row rather than in a constant.
 */
export async function saveTaxRates(rates: TaxRates): Promise<void> {
  const checked = buildTaxRates(rates);
  await withTransaction(async (run) => {
    for (const [key, basisPoints] of [
      [ORDINARY_RATE_KEY, checked.ordinaryBasisPoints],
      [CAPITAL_GAINS_RATE_KEY, checked.capitalGainsBasisPoints],
    ] as const) {
      await run(
        `insert into settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, String(basisPoints)],
      );
    }
  });
}

/**
 * What the broker and the trustee charge. Written as one set: a charge left blank
 * is deleted rather than left behind, because "we pay no flat commission" and "we
 * once did" are different states and a stale row would make them look alike.
 */
export async function saveFeeSchedule(fees: FeeSchedule): Promise<void> {
  const checked = buildFeeSchedule(fees);
  const values: readonly (readonly [string, string | null])[] = [
    [
      BROKER_PER_SHARE_KEY,
      checked.brokerPerShare === null
        ? null
        : joinAmount(checked.brokerPerShare.tenThousandths, checked.brokerPerShare.currency),
    ],
    [
      BROKER_FLAT_KEY,
      checked.brokerFlat === null
        ? null
        : joinAmount(checked.brokerFlat.minorUnits, checked.brokerFlat.currency),
    ],
    [TRUSTEE_FEE_KEY, checked.trusteeBasisPoints === 0 ? null : String(checked.trusteeBasisPoints)],
  ];

  await withTransaction(async (run) => {
    for (const [key, value] of values) {
      if (value === null) {
        await run(`delete from settings where key = $1`, [key]);
        continue;
      }
      await run(
        `insert into settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, value],
      );
    }
  });
}
