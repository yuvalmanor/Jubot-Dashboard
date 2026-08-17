/**
 * Loads a complete, coherent household into the local database, so every screen
 * can be looked at with numbers that hang together rather than with a handful of
 * rows left behind by a verification run.
 *
 * Two different things go in:
 *
 * - The **מאזן** is real. It is the committed sheet export, put through the very
 *   same importer `/balance/import` uses — same parse, same proposal, same
 *   default selection, same writes. Nothing here restates what the sheet says.
 * - **Everything else is invented**, because nothing in the repository records
 *   the household's actual accounts, balances or grants. The shapes and the
 *   round figures that do appear in CONTEXT.md and the PRD are kept — CGM 1's
 *   two funding legs, CGM 2's $82,000 sitting converted, קרן חירום's 120,000 —
 *   so the screens are exercised the way the real data would exercise them.
 *
 * It is destructive by design: every domain table is emptied first, so a re-run
 * always lands the same database rather than layering onto the last one. People,
 * the tracer amount and the FX rate come from `db/seed.sql` and are left alone.
 *
 * Run with:  npm run db:demo
 */

import pg from "pg";

import { applyImportPlan, readSheetExport } from "@/db/import";
import { parseSheetExport } from "@/domain/import/sheet-export";
import { defaultSelection, planSheetImport, planWrites } from "@/domain/import/sheet-importer";

const CURRENCY = "ILS" as const;

// Stable ids, so a re-run rewrites the same rows and any note anybody made about
// "the IBI account" keeps pointing at it.
const ACCOUNT = {
  leumi: "aacc0001-0000-4000-8000-000000000001",
  hapoalim: "aacc0002-0000-4000-8000-000000000002",
  ayalon: "aacc0003-0000-4000-8000-000000000003",
  ibi: "aacc0004-0000-4000-8000-000000000004",
  hishtalmut: "aacc0005-0000-4000-8000-000000000005",
  pensionYuval: "aacc0006-0000-4000-8000-000000000006",
  pensionEden: "aacc0007-0000-4000-8000-000000000007",
  rsu: "aacc0008-0000-4000-8000-000000000008",
  cgm1: "aacc0009-0000-4000-8000-000000000009",
  cgm2: "aacc0010-0000-4000-8000-000000000010",
  meteor6: "aacc0011-0000-4000-8000-000000000011",
} as const;

const SNAPSHOT = {
  aug2025: "5da70001-0000-4000-8000-000000000001",
  dec2025: "5da70002-0000-4000-8000-000000000002",
  apr2026: "5da70003-0000-4000-8000-000000000003",
  aug2026: "5da70004-0000-4000-8000-000000000004",
} as const;

const PROJECT = {
  cgm1: "9709ec01-0000-4000-8000-000000000001",
  cgm2: "9709ec02-0000-4000-8000-000000000002",
  meteor6: "9709ec03-0000-4000-8000-000000000003",
} as const;

const GRANT = {
  a: "97a70001-0000-4000-8000-000000000001",
  b: "97a70002-0000-4000-8000-000000000002",
} as const;

const VEST = {
  a1: "0e570001-0000-4000-8000-000000000001",
  a2: "0e570002-0000-4000-8000-000000000002",
  a3: "0e570003-0000-4000-8000-000000000003",
  a4: "0e570004-0000-4000-8000-000000000004",
  b1: "0e570005-0000-4000-8000-000000000005",
  b2: "0e570006-0000-4000-8000-000000000006",
  b3: "0e570007-0000-4000-8000-000000000007",
  b4: "0e570008-0000-4000-8000-000000000008",
} as const;

const SCENARIO = {
  cgm3: "5ce70001-0000-4000-8000-000000000001",
  meteor7: "5ce70002-0000-4000-8000-000000000002",
} as const;

const RATE_ITEM = {
  carInsurance: "4a7e0001-0000-4000-8000-000000000001",
  accountant: "4a7e0002-0000-4000-8000-000000000002",
  licence: "4a7e0003-0000-4000-8000-000000000003",
} as const;

/** Emptied before anything is written. `people`, `money_settings` and `fx_rates` are not. */
const DOMAIN_TABLES = [
  "rate_watch_renewals",
  "rate_watch_items",
  "annual_review_valuations",
  "annual_reviews",
  "funding_plan_executions",
  "scenario_deal_terms",
  "scenario_patterns",
  "scenario_allocations",
  "funding_plan_sources",
  "funding_plans",
  "scenarios",
  "rsu_sales",
  "rsu_vests",
  "rsu_grants",
  "deal_terms",
  "project_expenses",
  "funding_legs",
  "projects",
  "earmarks",
  "positions",
  "snapshot_lines",
  "snapshot_rates",
  "snapshots",
  "entries",
  "category_assignments",
  "personal_categories",
  "household_categories",
  "accounts",
  "settings",
];

// --- the accounts -------------------------------------------------------------

const ACCOUNTS: readonly [string, string, string, string, string, string, string, string][] = [
  // id, person, name, currency, value_basis, category, asset_kind, opened_on
  [ACCOUNT.leumi, "yuval", 'עו"ש לאומי', "ILS", "market", "liquid", "עובר ושב", "2023-01-01"],
  [ACCOUNT.hapoalim, "eden", 'עו"ש הפועלים', "ILS", "market", "liquid", "עובר ושב", "2023-01-01"],
  [ACCOUNT.ayalon, "yuval", "קרן כספית איילון", "ILS", "market", "liquid", "קרן כספית", "2023-01-01"],
  [ACCOUNT.ibi, "yuval", "תיק השקעות IBI", "ILS", "market", "investments", "תיק מנוהל", "2023-01-01"],
  [ACCOUNT.hishtalmut, "eden", "קרן השתלמות מנורה", "ILS", "market", "investments", "קרן השתלמות", "2023-01-01"],
  [ACCOUNT.pensionYuval, "yuval", "פנסיה מנורה", "ILS", "estimate", "pension", "פנסיה", "2023-01-01"],
  [ACCOUNT.pensionEden, "eden", "פנסיה כלל", "ILS", "estimate", "pension", "פנסיה", "2023-01-01"],
  [ACCOUNT.rsu, "yuval", "Apple RSU", "USD", "market", "investments", "מניות", "2023-06-01"],
  // Held at cost, per ADR 0003 — no current valuation exists and none will be sought.
  [ACCOUNT.cgm1, "yuval", "CGM 1", "USD", "cost", "property", 'נדל"ן', "2024-03-01"],
  // Opened between the first two snapshots, so the decomposition has an arrival to explain.
  [ACCOUNT.cgm2, "yuval", "CGM 2", "USD", "cost", "property", 'נדל"ן', "2025-11-01"],
  [ACCOUNT.meteor6, "eden", "Meteor 6", "ILS", "cost", "property", 'נדל"ן', "2023-09-01"],
];

// --- the snapshots ------------------------------------------------------------

interface SnapshotSpec {
  readonly id: string;
  readonly takenOn: string;
  readonly note: string;
  readonly rate: string;
  /** The share price the reading was taken at, in ten-thousandths. */
  readonly sharePrice: number;
  readonly lines: readonly (readonly [string, number])[];
}

/**
 * The RSU line is the share count actually held on the day times that day's price,
 * so the מיפוי and the RSU screens cannot disagree:
 *   Aug 2025    800 × $185.00 = $148,000
 *   Dec 2025    950 × $198.00 = $188,100
 *   Apr 2026  1,100 × $212.00 = $233,200
 *   Aug 2026  1,000 × $224.50 = $224,500   (100 sold in May)
 */
const SNAPSHOTS: readonly SnapshotSpec[] = [
  {
    id: SNAPSHOT.aug2025,
    takenOn: "2025-08-31",
    note: "סוף אוגוסט — לפני ההמרה של CGM 2",
    rate: "3.720000",
    sharePrice: 1_850_000,
    lines: [
      [ACCOUNT.leumi, 4_200_000],
      [ACCOUNT.hapoalim, 2_850_000],
      [ACCOUNT.ayalon, 21_000_000],
      [ACCOUNT.ibi, 31_200_000],
      [ACCOUNT.hishtalmut, 18_400_000],
      [ACCOUNT.pensionYuval, 44_300_000],
      [ACCOUNT.pensionEden, 29_700_000],
      [ACCOUNT.rsu, 14_800_000],
      [ACCOUNT.cgm1, 9_908_219],
      [ACCOUNT.meteor6, 25_000_000],
    ],
  },
  {
    id: SNAPSHOT.dec2025,
    takenOn: "2025-12-31",
    note: "סגירת שנה",
    rate: "3.680000",
    sharePrice: 1_980_000,
    lines: [
      [ACCOUNT.leumi, 5_150_000],
      [ACCOUNT.hapoalim, 3_110_000],
      [ACCOUNT.ayalon, 23_500_000],
      [ACCOUNT.ibi, 34_050_000],
      [ACCOUNT.hishtalmut, 19_250_000],
      [ACCOUNT.pensionYuval, 46_100_000],
      [ACCOUNT.pensionEden, 31_000_000],
      [ACCOUNT.rsu, 18_810_000],
      [ACCOUNT.cgm1, 9_908_219],
      [ACCOUNT.cgm2, 8_200_000],
      [ACCOUNT.meteor6, 25_000_000],
    ],
  },
  {
    id: SNAPSHOT.apr2026,
    takenOn: "2026-04-30",
    note: "",
    rate: "3.610000",
    sharePrice: 2_120_000,
    lines: [
      [ACCOUNT.leumi, 4_780_000],
      [ACCOUNT.hapoalim, 3_640_000],
      [ACCOUNT.ayalon, 26_900_000],
      [ACCOUNT.ibi, 33_180_000],
      [ACCOUNT.hishtalmut, 19_980_000],
      [ACCOUNT.pensionYuval, 47_850_000],
      [ACCOUNT.pensionEden, 32_150_000],
      [ACCOUNT.rsu, 23_320_000],
      [ACCOUNT.cgm1, 9_908_219],
      [ACCOUNT.cgm2, 8_200_000],
      [ACCOUNT.meteor6, 25_000_000],
    ],
  },
  {
    id: SNAPSHOT.aug2026,
    takenOn: "2026-08-01",
    note: "המיפוי האחרון",
    rate: "3.650000",
    sharePrice: 2_245_000,
    lines: [
      [ACCOUNT.leumi, 6_240_000],
      [ACCOUNT.hapoalim, 3_020_000],
      [ACCOUNT.ayalon, 29_400_000],
      [ACCOUNT.ibi, 36_720_000],
      [ACCOUNT.hishtalmut, 21_100_000],
      [ACCOUNT.pensionYuval, 49_600_000],
      [ACCOUNT.pensionEden, 33_400_000],
      [ACCOUNT.rsu, 22_450_000],
      [ACCOUNT.cgm1, 9_908_219],
      [ACCOUNT.cgm2, 8_200_000],
      [ACCOUNT.meteor6, 25_000_000],
    ],
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is not set. Start `npm run db:local` and load .env.local.");
  }

  const client = new pg.Client({ connectionString, ssl: false });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(`truncate ${DOMAIN_TABLES.join(", ")} cascade`);

    await loadAccounts(client);
    await loadSnapshots(client);
    await loadHoldings(client);
    await loadProjects(client);
    await loadRsu(client);
    await loadPlanning(client);
    await loadAnnualReview(client);
    await loadRateWatch(client);
    await loadSettings(client);

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }

  // The מאזן, through the real importer. Separate from the transaction above
  // because `applyImportPlan` opens its own, on the app's own pool.
  const outcome = await importTheSheet();

  console.log(`accounts       ${ACCOUNTS.length}`);
  console.log(`snapshots      ${SNAPSHOTS.length}`);
  console.log(`projects       ${Object.keys(PROJECT).length}`);
  // The household lines the panel watches are created by the import above, so
  // flagging them has to come after it.
  const watched = await flagWatchedCategories(connectionString);

  console.log(`grants         ${Object.keys(GRANT).length}`);
  console.log(`scenarios      ${Object.keys(SCENARIO).length}`);
  console.log(`מעקב תעריפים   ${Object.keys(RATE_ITEM).length} annual items, ${watched} watched lines`);
  console.log(
    `מאזן           ${outcome.entries} entries across ${outcome.categories} categories, ` +
      `${outcome.households} household lines`,
  );
}

async function loadAccounts(client: pg.Client): Promise<void> {
  for (const row of ACCOUNTS) {
    await client.query(
      `insert into accounts (id, person_id, name, currency, value_basis, category, asset_kind, opened_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date)`,
      [...row],
    );
  }
}

async function loadSnapshots(client: pg.Client): Promise<void> {
  for (const snapshot of SNAPSHOTS) {
    await client.query(
      `insert into snapshots (id, taken_on, note, rsu_price_ten_thousandths, rsu_price_currency)
       values ($1, $2::date, $3, $4, 'USD')`,
      [snapshot.id, snapshot.takenOn, snapshot.note === "" ? null : snapshot.note, snapshot.sharePrice],
    );

    await client.query(
      `insert into snapshot_rates (snapshot_id, base, quote, rate) values ($1, 'USD', 'ILS', $2)`,
      [snapshot.id, snapshot.rate],
    );

    for (const [accountId, amount] of snapshot.lines) {
      const currency = ACCOUNTS.find((account) => account[0] === accountId)?.[3];
      await client.query(
        `insert into snapshot_lines (snapshot_id, account_id, amount_minor, currency, source, measured_on)
         values ($1, $2, $3, $4, 'entered', $5::date)`,
        [snapshot.id, accountId, amount, currency, snapshot.takenOn],
      );
    }
  }
}

async function loadHoldings(client: pg.Client): Promise<void> {
  const positions: readonly (readonly [string, string | null, string])[] = [
    [ACCOUNT.ibi, "1159235", "1159235 ACWI"],
    [ACCOUNT.ibi, "1209220", "1209220 FTSE"],
    [ACCOUNT.hishtalmut, null, "מסלול כללי"],
    [ACCOUNT.rsu, null, "AAPL"],
  ];
  for (const [accountId, securityId, name] of positions) {
    await client.query(
      `insert into positions (account_id, security_id, name) values ($1, $2, $3)`,
      [accountId, securityId, name],
    );
  }

  // קרן חירום is the figure CONTEXT.md names. The second claim is what makes the
  // account's free balance worth reading: 294,000 held, 165,000 spoken for.
  const earmarks: readonly (readonly [string, string, number, string])[] = [
    [ACCOUNT.ayalon, "קרן חירום", 12_000_000, "2024-01-01"],
    [ACCOUNT.ayalon, "רזרבה לשיפוץ", 4_500_000, "2025-06-01"],
  ];
  for (const [accountId, name, amount, declaredOn] of earmarks) {
    await client.query(
      `insert into earmarks (account_id, name, amount_minor, currency, declared_on)
       values ($1, $2, $3, 'ILS', $4::date)`,
      [accountId, name, amount, declaredOn],
    );
  }
}

async function loadProjects(client: pg.Client): Promise<void> {
  await client.query(
    `insert into projects (id, name, currency, account_id, started_on) values
       ($1, 'CGM 1',    'USD', $2, '2024-03-01'),
       ($3, 'CGM 2',    'USD', $4, '2025-11-01'),
       ($5, 'Meteor 6', 'ILS', $6, '2023-09-01')`,
    [PROJECT.cgm1, ACCOUNT.cgm1, PROJECT.cgm2, ACCOUNT.cgm2, PROJECT.meteor6, ACCOUNT.meteor6],
  );

  // CGM 1's two legs are the pair CONTEXT.md describes: 109,800₪ and $69,000 of
  // Apple RSU. A rate is recorded only on the leg that actually converted.
  await client.query(
    `insert into funding_legs (project_id, source, amount_minor, currency, usd_ils_rate, paid_on) values
       ($1, 'RSU אפל',        6900000,  'USD', null,   '2024-03-01'),
       ($1, 'כסף נזיל פנוי',  10980000, 'ILS', 3.65,   '2024-03-01'),
       ($2, 'המרה מהכספית',   8200000,  'USD', null,   '2025-11-01'),
       ($3, 'כסף נזיל פנוי',  25000000, 'ILS', null,   '2023-09-01')`,
    [PROJECT.cgm1, PROJECT.cgm2, PROJECT.meteor6],
  );

  // Leaves CGM 1 with roughly $21,188 still undeployed — the figure the PRD names.
  await client.query(
    `insert into project_expenses (project_id, description, amount_minor, currency, usd_ils_rate, paid_on) values
       ($1, 'רכישת הנכס',    7000000,  'USD', null, '2024-04-15'),
       ($1, 'עלויות סגירה',  789419,   'USD', null, '2024-05-20'),
       ($2, 'שכר טרחה',      2450000,  'ILS', 3.68, '2025-12-10'),
       ($3, 'רכישת הנכס',    24500000, 'ILS', null, '2023-10-01')`,
    [PROJECT.cgm1, PROJECT.cgm2, PROJECT.meteor6],
  );

  // A promise off the sponsor's paperwork, never a measurement.
  await client.query(
    `insert into deal_terms (project_id, target_return_bp, hold_months, distribution, source, recorded_on) values
       ($1, 1800, 60, 'רבעוני',         'מצגת החברה',    '2024-03-01'),
       ($2, 1750, 60, 'בסוף התקופה',    'הסכם השותפות',  '2025-11-01'),
       ($3, 2200, 48, 'חצי-שנתי',       'מצגת החברה',    '2023-09-01')`,
    [PROJECT.cgm1, PROJECT.cgm2, PROJECT.meteor6],
  );
}

async function loadRsu(client: pg.Client): Promise<void> {
  // Grant A cleared סעיף 102's twenty-four months in June 2025, so its lots are
  // Qualified; grant B does not clear until March 2027, so its are not. Both
  // states are on screen at once, which is the point of the calculator.
  await client.query(
    `insert into rsu_grants
       (id, person_id, reference, granted_on, total_shares,
        grant_price_ten_thousandths, grant_price_currency, grant_price_source)
     values
       ($1, 'yuval', 'RSU-2023-A', '2023-06-01', 800, 1494219, 'USD', 'stated'),
       ($2, 'yuval', 'RSU-2025-B', '2025-03-01', 600, 2050000, 'USD', 'stated')`,
    [GRANT.a, GRANT.b],
  );

  await client.query(
    `insert into rsu_vests (id, grant_id, vested_on, shares, price_ten_thousandths, price_currency) values
       ($1, $9,  '2023-12-01', 200, 1620000, 'USD'),
       ($2, $9,  '2024-06-01', 200, 1710000, 'USD'),
       ($3, $9,  '2024-12-01', 200, 1905000, 'USD'),
       ($4, $9,  '2025-06-01', 200, 2010000, 'USD'),
       ($5, $10, '2025-09-01', 150, 2075000, 'USD'),
       ($6, $10, '2026-03-01', 150, 2160000, 'USD'),
       ($7, $10, '2026-09-01', 150, 2280000, 'USD'),
       ($8, $10, '2027-03-01', 150, 2350000, 'USD')`,
    [VEST.a1, VEST.a2, VEST.a3, VEST.a4, VEST.b1, VEST.b2, VEST.b3, VEST.b4, GRANT.a, GRANT.b],
  );

  // One sale out of a named lot, which is what decides how it was taxed.
  await client.query(
    `insert into rsu_sales (vest_id, sold_on, shares, price_ten_thousandths, price_currency)
     values ($1, '2026-05-20', 100, 2200000, 'USD')`,
    [VEST.a1],
  );
}

async function loadPlanning(client: pg.Client): Promise<void> {
  await client.query(
    `insert into scenarios (id, name, note, created_on, is_active) values
       ($1, 'CGM 3 ב־2027',    'התוכנית שאנחנו עוקבים אחריה', '2026-06-01', true),
       ($2, 'Meteor 7 ב־2027', 'במקום עוד CGM',               '2026-06-01', false)`,
    [SCENARIO.cgm3, SCENARIO.meteor7],
  );

  await client.query(
    `insert into funding_plans (scenario_id, needs_amount_minor, needs_currency, needed_by) values
       ($1, 9500000,  'USD', '2027-06-30'),
       ($2, 30000000, 'ILS', '2027-12-31')`,
    [SCENARIO.cgm3, SCENARIO.meteor7],
  );

  // A seeded amount states which figure it came from and on which day, so it can
  // be held against the reading rather than ageing into a number of unknown vintage.
  await client.query(
    `insert into funding_plan_sources
       (scenario_id, source, amount_minor, currency, origin, seed_figure, seeded_as_of)
     values
       ($1, 'כסף נזיל פנוי', 15000000, 'ILS', 'seeded', 'free-liquid', '2026-08-01'),
       ($1, 'RSU אפל',       4000000,  'USD', 'stated', null,          null),
       ($2, 'כסף נזיל פנוי', 12000000, 'ILS', 'seeded', 'free-liquid', '2026-08-01'),
       ($2, 'חיסכון שוטף',   9000000,  'ILS', 'stated', null,          null)`,
    [SCENARIO.cgm3, SCENARIO.meteor7],
  );

  await client.query(
    `insert into scenario_allocations (scenario_id, goal, monthly_amount_minor, target_minor, currency) values
       ($1, 'נדל"ן',     1000000, 35000000, 'ILS'),
       ($1, 'קרן חירום', 200000,  15000000, 'ILS')`,
    [SCENARIO.cgm3],
  );

  // "A Meteor every year for five years", priced off Meteor 6's recorded terms.
  await client.query(
    `insert into scenario_patterns
       (scenario_id, amount_minor, currency, every_months, occurrences, first_on, modelled_on)
     values ($1, 25000000, 'ILS', 12, 5, '2027-01-01', $2)`,
    [SCENARIO.meteor7, PROJECT.meteor6],
  );

  // The scenario stress-tests the sponsor's promise without touching what the
  // paperwork actually said.
  await client.query(
    `insert into scenario_deal_terms (scenario_id, project_id, target_return_bp, hold_months)
     values ($1, $2, 1900, null)`,
    [SCENARIO.meteor7, PROJECT.meteor6],
  );
}

async function loadAnnualReview(client: pg.Client): Promise<void> {
  // ADR 0002: only what cannot be recomputed. No income, expense or saving
  // columns — those stay live off the ledger.
  await client.query(
    `insert into annual_reviews
       (year, note, recorded_on, closing_snapshot_id,
        closing_usd_ils_rate, closing_share_price_ten_thousandths, closing_share_price_currency)
     values (2025, 'השנה שבה CGM 2 הומר ועדיין לא הושקע', '2026-01-15', $1, 3.68, 1980000, 'USD')`,
    [SNAPSHOT.dec2025],
  );

  // What somebody judged these to be worth at the close. Per ADR 0003 this never
  // becomes the project's מיפוי value — it sits beside the cost and differs from it.
  await client.query(
    `insert into annual_review_valuations (year, project_id, amount_minor, currency) values
       (2025, $1, 10500000, 'USD'),
       (2025, $2, 26500000, 'ILS')`,
    [PROJECT.cgm1, PROJECT.meteor6],
  );
}

/**
 * מעקב תעריפים: the typed band, and the flags that fill the derived one.
 *
 * Invented like everything outside the מאזן — the household's real annual bills
 * are one undated snapshot in the sheet and the plan retires them rather than
 * backfilling them — but shaped like the figures the plan names, so the panel is
 * exercised the way real data would exercise it. The car policy is the case the
 * 10% / 300₪ bars were chosen for: 5,139 → 5,900 is +761₪ and +15%.
 *
 * Nothing here is written to `entries`, and nothing needs to be: this money is
 * already in the imported מאזן, inside `רכב` and `קבועות`.
 */
async function loadRateWatch(client: pg.Client): Promise<void> {
  await client.query(
    `insert into rate_watch_items (id, name, started_on) values
       ($1, 'ביטוח רכב מקיף', '2024-09-01'),
       ($2, 'רו״ח',           '2025-03-15'),
       ($3, 'רישוי רכב',      '2025-05-20')`,
    [RATE_ITEM.carInsurance, RATE_ITEM.accountant, RATE_ITEM.licence],
  );

  // The amount is the policy total, in whatever number of תשלומים it was billed.
  await client.query(
    `insert into rate_watch_renewals (item_id, renewed_on, amount_minor, currency) values
       ($1, '2024-09-01', 513900, 'ILS'),
       ($1, '2025-09-01', 590000, 'ILS'),
       ($2, '2025-03-15', 334600, 'ILS'),
       ($2, '2026-03-15', 360000, 'ILS'),
       ($3, '2025-05-20', 115400, 'ILS')`,
    [RATE_ITEM.carInsurance, RATE_ITEM.accountant, RATE_ITEM.licence],
  );
}

/**
 * The derived band's half: the subscriptions the sheet has recorded every month
 * since 2024-07, flagged as Watched Categories.
 *
 * After the import rather than inside the transaction above, because the
 * household lines it flags are created by the importer. One boolean per row and
 * no amount anywhere — the panel reads the very entries the grid does.
 */
async function flagWatchedCategories(connectionString: string): Promise<number> {
  const client = new pg.Client({ connectionString, ssl: false });
  await client.connect();
  try {
    const result = await client.query(
      `update household_categories set watched = true
        where name in ('רייזאפ', 'מכבי', 'אינטרנט', 'אפל מיוזיק', 'לובי99')`,
    );
    return result.rowCount ?? 0;
  } finally {
    await client.end();
  }
}

async function loadSettings(client: pg.Client): Promise<void> {
  const settings: readonly (readonly [string, string])[] = [
    ["appreciation.property_bp", "300"],
    ["allocation_target.liquid", "1500"],
    ["allocation_target.investments", "3500"],
    ["allocation_target.pension", "2500"],
    ["allocation_target.property", "2500"],
    // The RSU stake is the concentration worth watching.
    ["concentration.account_ids", ACCOUNT.rsu],
    // What moves with the market, so the decomposition can tell growth from deposits.
    ["decomposition.market_account_ids", [ACCOUNT.ibi, ACCOUNT.hishtalmut, ACCOUNT.rsu].join(",")],
    ["rsu.holding_account_id", ACCOUNT.rsu],
  ];

  for (const [key, value] of settings) {
    await client.query(`insert into settings (key, value) values ($1, $2)`, [key, value]);
  }
}

/**
 * The מאזן, imported exactly as the review screen would import it: the same
 * parse, the same proposal, and the proposal's own default selection — which is
 * what the screen shows before anybody changes anything.
 */
async function importTheSheet() {
  const markdown = await readSheetExport();
  const proposal = planSheetImport(parseSheetExport(markdown, { currency: CURRENCY }), {
    currency: CURRENCY,
    people: [
      { id: "yuval", sheetName: "יובל" },
      { id: "eden", sheetName: "עדן" },
    ],
  });

  return applyImportPlan(planWrites(proposal, defaultSelection(proposal)));
}

await main();
