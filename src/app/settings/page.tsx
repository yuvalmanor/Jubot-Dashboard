import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { loadAccounts } from "@/db/accounts";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail } from "@/db/people";
import { type HouseholdSettings, loadHouseholdSettings } from "@/db/settings";
import { toDecimalString } from "@/domain/money/money";
import { targetFor } from "@/domain/networth/net-worth-analytics";
import { sharePriceToDecimalString } from "@/domain/rsu/rsu-position";
import {
  type Account,
  ASSET_CATEGORIES,
  ASSET_CATEGORY_LABELS,
  VALUE_BASIS_LABELS,
  accountsOpenOn,
} from "@/domain/snapshot/snapshot";
import { dateOf } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import {
  type SettingsErrorCode,
  setAllocationTargets,
  setAppreciation,
  setConcentrationAccounts,
  setFees,
  setGpWindow,
  setMarketMovingAccounts,
  setTaxRates,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * The household's own dials. Everything on this screen is a number somebody chose
 * rather than one anybody measured — which is why it is here at all: an assumption
 * that could only change by shipping a deploy would stop reading as an assumption
 * and start reading as a fact.
 */

const PERCENT_STEP = "0.01";

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Basis points back into the percentage the household typed — 1250 reads as `12.5`. */
function asPercentText(basisPoints: number | null): string {
  if (basisPoints === null || basisPoints === 0) return "";
  return String(basisPoints / 100);
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const loaded = await loadPage(email);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="הגדרות"
        subtitle="ההנחות והיעדים של משק הבית — לא מדידות, ולכן לא קבועים בקוד"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            <AppreciationPanel settings={loaded.settings} />
            <TargetsPanel settings={loaded.settings} />
            <ConcentrationPanel settings={loaded.settings} accounts={loaded.accounts} />
            <MarketMovingPanel settings={loaded.settings} accounts={loaded.accounts} />
            <GpWindowPanel settings={loaded.settings} />
            <TaxRatesPanel settings={loaded.settings} />
            <FeesPanel settings={loaded.settings} />
          </>
        ) : (
          <UnavailablePanel reason={loaded.reason} />
        )}
      </main>
    </div>
  );
}

// --- loading -----------------------------------------------------------------

type Loaded =
  | { kind: "ok"; person: Person; settings: HouseholdSettings; accounts: readonly Account[] }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string): Promise<Loaded> {
  try {
    const person = await findPersonByEmail(email);
    if (person === null) {
      return {
        kind: "unavailable",
        reason: `הכתובת ${email} אינה משויכת לאף אדם בטבלת people. יש לעדכן את שתי הכתובות במסד (ראו README).`,
      };
    }
    const [settings, accounts] = await Promise.all([loadHouseholdSettings(), loadAccounts()]);
    return { kind: "ok", person, settings, accounts };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the appreciation assumption ---------------------------------------------

function AppreciationPanel({ settings }: { settings: HouseholdSettings }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הנחת עליית ערך לנדל״ן</h2>
      <p className="mt-1 text-sm text-stone-600">
        נכס המוחזק בעלות לעולם אינו מוערך מחדש במיפוי. ההנחה הזאת אינה משנה את המיפוי — היא מאפשרת
        לקרוא את השווי נטו כטווח בין מה שנרשם לבין מה שהוא היה שווה אם היה עולה בקצב הזה. כל מספר
        שמשתמש בה אומר במפורש באיזו הנחה השתמש.
      </p>

      <form action={setAppreciation} className="mt-4 flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="block text-sm font-medium text-stone-700">אחוז לשנה</span>
          <span className="block text-xs text-stone-500">ריק או אפס — לא מניחים כלום</span>
          <input
            name="appreciation"
            inputMode="decimal"
            dir="ltr"
            step={PERCENT_STEP}
            defaultValue={asPercentText(settings.appreciation.annualBasisPoints)}
            className="tabular mt-1 w-32 rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>
        <SaveButton label="שמירת ההנחה" />
      </form>
    </section>
  );
}

// --- רצוי targets -------------------------------------------------------------

function TargetsPanel({ settings }: { settings: HouseholdSettings }) {
  const total = settings.targets.reduce((running, target) => running + target.basisPoints, 0);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הקצאה רצויה</h2>
      <p className="mt-1 text-sm text-stone-600">
        כמה מהשווי אמור לשבת בכל קטגוריה. קטגוריה שנשארת ריקה אינה יעד של אפס — היא קטגוריה שלא
        נקבע לה יעד, וכך היא תיקרא במסך שווי נטו.
      </p>

      <form action={setAllocationTargets} className="mt-4">
        <div className="grid gap-4 sm:grid-cols-4">
          {ASSET_CATEGORIES.map((category) => (
            <label key={category} className="block">
              <span className="block text-sm font-medium text-stone-700">
                {ASSET_CATEGORY_LABELS[category]}
              </span>
              <input
                name={`target:${category}`}
                inputMode="decimal"
                dir="ltr"
                step={PERCENT_STEP}
                defaultValue={asPercentText(targetFor(settings.targets, category))}
                className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
              />
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <SaveButton label="שמירת היעדים" />
          <p className="text-sm text-stone-500">
            {total === 0 ? (
              "לא נקבעו יעדים."
            ) : (
              <>
                היעדים מסתכמים כרגע ל־<bdi className="tabular">{total / 100}%</bdi>
                {total === 10_000 ? null : " — המערכת לא מתקנת את זה, רק אומרת אותו."}
              </>
            )}
          </p>
        </div>
      </form>
    </section>
  );
}

// --- what a concentration is watched on --------------------------------------

function ConcentrationPanel({
  settings,
  accounts,
}: {
  settings: HouseholdSettings;
  accounts: readonly Account[];
}) {
  const open = accountsOpenOn(accounts, dateOf(new Date()));
  const watched = new Set(settings.concentrationAccountIds);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">ריכוזיות — חשבונות במעקב</h2>
      <p className="mt-1 text-sm text-stone-600">
        אילו חשבונות נספרים כ־<bdi>Apple RSU</bdi> בחישוב חלקם מכלל ההון. הבחירה היא לפי החשבון עצמו
        ולא לפי שמו, כך ששינוי שם לא יגרום לריכוזיות להיקרא בשקט כאפס.
      </p>

      {open.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">
          אין חשבונות פתוחים.{" "}
          <Link href="/accounts" className="underline underline-offset-4">
            הגדרת חשבון
          </Link>{" "}
          קודמת לכל דבר אחר כאן.
        </p>
      ) : (
        <form action={setConcentrationAccounts} className="mt-4">
          <ul className="space-y-2">
            {open.map((account) => (
              <li key={account.id}>
                <label className="flex flex-wrap items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    name="accountId"
                    value={account.id}
                    defaultChecked={watched.has(account.id)}
                    className="size-4 rounded border-stone-300"
                  />
                  <span className="font-medium">
                    <bdi>{account.name}</bdi>
                  </span>
                  <span className="text-xs text-stone-500">
                    {ASSET_CATEGORY_LABELS[account.category]} · <bdi>{account.assetKind}</bdi> ·{" "}
                    {VALUE_BASIS_LABELS[account.valueBasis]} · <bdi>{account.currency}</bdi>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="mt-4">
            <SaveButton label="שמירת המעקב" />
          </div>
        </form>
      )}
    </section>
  );
}

// --- what a change decomposition may call market movement ---------------------

function MarketMovingPanel({
  settings,
  accounts,
}: {
  settings: HouseholdSettings;
  accounts: readonly Account[];
}) {
  const open = accountsOpenOn(accounts, dateOf(new Date()));
  const marked = new Set(settings.marketMovingAccountIds);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">חשבונות שנעים עם השוק</h2>
      <p className="mt-1 text-sm text-stone-600">
        שני צילומים רושמים מצב ולא תנועה, ולכן שום נתון אינו יכול לומר אם קרן עלתה או שהופקד לתוכה
        כסף. זו ההכרעה היחידה בפירוק השינוי, והיא של משק הבית: מה שסומן כאן נקרא{" "}
        <span className="font-medium">תנועת שוק</span>, וכל שאר מה שזז נקרא{" "}
        <span className="font-medium">כסף שנוסף</span>. לא לסמן דבר זו עמדה — ממנה המערכת מתחילה.
      </p>

      {open.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">
          אין חשבונות פתוחים.{" "}
          <Link href="/accounts" className="underline underline-offset-4">
            הגדרת חשבון
          </Link>{" "}
          קודמת לכל דבר אחר כאן.
        </p>
      ) : (
        <form action={setMarketMovingAccounts} className="mt-4">
          <ul className="space-y-2">
            {open.map((account) => {
              const heldAtCost = account.valueBasis === "cost";

              return (
                <li key={account.id}>
                  <label
                    className={`flex flex-wrap items-center gap-3 text-sm ${heldAtCost ? "text-stone-400" : ""}`}
                  >
                    <input
                      type="checkbox"
                      name="accountId"
                      value={account.id}
                      defaultChecked={marked.has(account.id)}
                      disabled={heldAtCost}
                      className="size-4 rounded border-stone-300"
                    />
                    <span className="font-medium">
                      <bdi>{account.name}</bdi>
                    </span>
                    <span className="text-xs text-stone-500">
                      {ASSET_CATEGORY_LABELS[account.category]} · <bdi>{account.assetKind}</bdi> ·{" "}
                      {VALUE_BASIS_LABELS[account.valueBasis]} · <bdi>{account.currency}</bdi>
                    </span>
                    {heldAtCost ? (
                      <span className="text-xs text-stone-500">
                        מוחזק בעלות — אין בו מחיר, ולכן אין בו תנועת שוק (ADR 0003)
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="mt-4">
            <SaveButton label="שמירת הסימון" />
          </div>
        </form>
      )}
    </section>
  );
}

// --- the GP window ------------------------------------------------------------

/**
 * The one dial here that is not a preference. Which window סעיף 102 actually means
 * is an open question of fact, and it lives in a form rather than in the code so
 * that answering it — against an ESOP statement or with the household's רו"ח —
 * costs a submission and not a deploy.
 */
function GpWindowPanel({ settings }: { settings: HouseholdSettings }) {
  const { gpWindow } = settings;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">
        חלון ה־GP לאומדן מחיר ההקצאה
      </h2>
      <p className="mt-1 text-sm text-stone-600">
        מעל אילו סגירות נלקח הממוצע שמשמש כ־GP. המערכת מתחילה מהקריאה של סעיף 102 —{" "}
        <span className="font-medium">30 ימי מסחר שלפני ההקצאה, בלי יום ההקצאה עצמו</span> — והגיליון
        של משק הבית עושה משהו אחר: 15 ימי לוח לכל צד, כולל יום ההקצאה. השאלה הזאת פתוחה, ולכן היא
        כאן: היא נסגרת מול תלוש ESOP או מול רו״ח, ולא מול קוד.
      </p>
      <p className="mt-2 text-sm text-stone-600">
        אומדן שכבר חושב שומר את החלון שבו נלקח. שינוי כאן לא כותב מחדש מספר שכבר נרשם — הוא מסמן אותו
        במסך ה־RSU כמי שנלקח בחלון אחר.
      </p>

      <form action={setGpWindow} className="mt-4 grid gap-4 sm:grid-cols-4">
        <label className="block">
          <span className="block text-sm font-medium text-stone-700">נספר לפי</span>
          <select
            name="basis"
            defaultValue={gpWindow.basis}
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-2"
          >
            <option value="trading">ימי מסחר</option>
            <option value="calendar">ימי לוח</option>
          </select>
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-stone-700">לפני ההקצאה</span>
          <input
            name="before"
            inputMode="numeric"
            dir="ltr"
            defaultValue={String(gpWindow.before)}
            className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-stone-700">אחרי ההקצאה</span>
          <input
            name="after"
            inputMode="numeric"
            dir="ltr"
            defaultValue={String(gpWindow.after)}
            className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <label className="flex items-end gap-3 pb-2 text-sm">
          <input
            type="checkbox"
            name="includesGrantDay"
            defaultChecked={gpWindow.includesGrantDay}
            className="size-4 rounded border-stone-300"
          />
          <span className="font-medium text-stone-700">כולל יום ההקצאה</span>
        </label>

        <div className="sm:col-span-4">
          <SaveButton label="שמירת החלון" />
        </div>
      </form>

      <p className="mt-3 text-sm text-stone-500">
        כרגע:{" "}
        <span className="font-medium text-stone-700">
          {gpWindow.basis === "trading" ? "ימי מסחר" : "ימי לוח"} — {gpWindow.before} לפני
          {gpWindow.includesGrantDay ? ", כולל יום ההקצאה" : ", בלי יום ההקצאה"}
          {gpWindow.after === 0 ? "" : `, ${gpWindow.after} אחרי`}
        </span>
        .{" "}
        <Link href="/rsu" className="underline underline-offset-4">
          מחשבון RSU
        </Link>
      </p>
    </section>
  );
}

// --- the two rates a sale can meet -------------------------------------------

/**
 * What סעיף 102 charges, as the household reads it. The system starts from
 * 62.17% and 25% and holds them here rather than in the code for the same reason
 * every other number on this screen is here: a rate that can only move by
 * shipping a deploy stops reading as a belief and starts reading as a fact.
 */
function TaxRatesPanel({ settings }: { settings: HouseholdSettings }) {
  const { taxRates } = settings;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">שיעורי המס על מכירת RSU</h2>
      <p className="mt-1 text-sm text-stone-600">
        מנה שעברה את 24 החודשים משלמת את השיעור השולי על ה־GP ואת שיעור רווח ההון על כל מה שמעליו.
        מנה שלא עברה — השיעור השולי על הכול. איזו משתי הדרכים חלה נקבע מהשעון של המנה עצמה, ולא
        כאן.
      </p>

      <form action={setTaxRates} className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="block text-sm font-medium text-stone-700">שיעור שולי (הכנסת עבודה)</span>
          <span className="block text-xs text-stone-500">ברירת המחדל: 62.17%</span>
          <input
            name="ordinary"
            inputMode="decimal"
            dir="ltr"
            step={PERCENT_STEP}
            defaultValue={asPercentText(taxRates.ordinaryBasisPoints)}
            className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-stone-700">שיעור רווח הון</span>
          <span className="block text-xs text-stone-500">ברירת המחדל: 25%</span>
          <input
            name="capitalGains"
            inputMode="decimal"
            dir="ltr"
            step={PERCENT_STEP}
            defaultValue={asPercentText(taxRates.capitalGainsBasisPoints)}
            className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <div className="flex items-end">
          <SaveButton label="שמירת השיעורים" />
        </div>
      </form>
    </section>
  );
}

// --- what the sale costs to make ---------------------------------------------

/**
 * The broker's and the trustee's charges. They come off the net and never off
 * the taxable base — a commission is money that did not arrive, not income
 * nobody earned, and taking it off the base would reduce a tax on a figure the
 * tax authority never saw reduced.
 */
function FeesPanel({ settings }: { settings: HouseholdSettings }) {
  const { fees } = settings;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">עמלות מכירה</h2>
      <p className="mt-1 text-sm text-stone-600">
        מה שהברוקר והנאמן גובים. אלה עובדות עליהם ולא על הקוד, ולכן הן כאן. הן יורדות{" "}
        <span className="font-medium">מהנטו</span> ולא מהבסיס החייב במס: עמלה היא כסף שלא הגיע, לא
        הכנסה שאיש לא הרוויח. הסכומים בדולרים, כי ההחזקה דולרית.
      </p>

      <form action={setFees} className="mt-4 grid gap-4 sm:grid-cols-4">
        <label className="block">
          <span className="block text-sm font-medium text-stone-700">עמלת ברוקר למניה</span>
          <span className="block text-xs text-stone-500">דולרים למניה — ריק פירושו שאין</span>
          <input
            name="brokerPerShare"
            inputMode="decimal"
            dir="ltr"
            defaultValue={fees.brokerPerShare === null ? "" : sharePriceToDecimalString(fees.brokerPerShare)}
            className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-stone-700">עמלה קבועה למכירה</span>
          <span className="block text-xs text-stone-500">נגבית פעם אחת לכל מכירה</span>
          <input
            name="brokerFlat"
            inputMode="decimal"
            dir="ltr"
            defaultValue={fees.brokerFlat === null ? "" : toDecimalString(fees.brokerFlat)}
            className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-stone-700">עמלת נאמן</span>
          <span className="block text-xs text-stone-500">אחוז מהתמורה ברוטו</span>
          <input
            name="trustee"
            inputMode="decimal"
            dir="ltr"
            step={PERCENT_STEP}
            defaultValue={asPercentText(fees.trusteeBasisPoints)}
            className="tabular mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </label>

        <div className="flex items-end">
          <SaveButton label="שמירת העמלות" />
        </div>
      </form>

      <p className="mt-3 text-sm text-stone-500">
        <Link href="/rsu" className="underline underline-offset-4">
          מחשבון RSU
        </Link>{" "}
        מחשב לפיהן את הנטו של כל מכירה.
      </p>
    </section>
  );
}

// --- shared ------------------------------------------------------------------

function SaveButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="rounded-md border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
    >
      {label}
    </button>
  );
}

const ERROR_MESSAGES: Record<SettingsErrorCode, string> = {
  "no-person": "הכתובת שאיתה נכנסת אינה משויכת לאף אדם בטבלת people.",
  "bad-appreciation": "הנחת עליית הערך אינה תקינה. אחוז שלם או עשרוני בין 0 ל־100.",
  "bad-targets": "היעדים אינם תקינים. כל יעד הוא אחוז בין 0 ל־100.",
  "bad-gp-window": "חלון ה־GP אינו תקין. מספר שלם של ימים בין 0 ל־365 לכל צד, ולפחות יום אחד בסך הכול.",
  "bad-tax-rates": "שיעורי המס אינם תקינים. כל שיעור הוא אחוז בין 0 ל־100.",
  "bad-fees": "העמלות אינן תקינות. סכום בדולרים, ועמלת הנאמן כאחוז בין 0 ל־100.",
  failed: "הפעולה נכשלה.",
};

const DONE_MESSAGES: Record<string, string> = {
  appreciation: "ההנחה נשמרה. כל מספר שמשתמש בה יאמר אותה במפורש.",
  targets: "היעדים נשמרו.",
  concentration: "המעקב נשמר.",
  "market-moving": "הסימון נשמר. פירוק השינוי ייקרא לפיו, ויאמר על מה הוא נשען.",
  "gp-window": "החלון נשמר. אומדנים שכבר חושבו שומרים את החלון שבו נלקחו, ויסומנו ככאלה.",
  "tax-rates": "השיעורים נשמרו. כל מכירה תתומחר לפיהם, ותאמר אותם.",
  fees: "העמלות נשמרו. הן יורדות מהנטו, ולא מהבסיס החייב במס.",
};

function isErrorCode(value: string | undefined): value is SettingsErrorCode {
  return value !== undefined && value in ERROR_MESSAGES;
}

function Notices({
  error,
  detail,
  done,
}: {
  error: string | undefined;
  detail: string | undefined;
  done: string | undefined;
}) {
  if (isErrorCode(error)) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4" role="alert">
        <p className="font-medium text-red-900">{ERROR_MESSAGES[error]}</p>
        {detail === undefined ? null : (
          <p className="mt-1 text-sm text-red-800">
            <bdi>{detail}</bdi>
          </p>
        )}
      </div>
    );
  }

  if (done === undefined || !(done in DONE_MESSAGES)) return null;

  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4" role="status">
      <p className="font-medium text-emerald-900">{DONE_MESSAGES[done]}</p>
    </div>
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את ההגדרות</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}
