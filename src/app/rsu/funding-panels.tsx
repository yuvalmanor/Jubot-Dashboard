import Link from "next/link";

import { type Money, format, parseMoneyInput } from "@/domain/money/money";
import {
  type ExcludedLot,
  type LotSelection,
  selectLots,
} from "@/domain/rsu/lot-selector";
import {
  type RsuPosition,
  type SharePrice,
  type VestSchedule,
  formatSharePrice,
  forwardSchedule,
  sharePriceToDecimalString,
} from "@/domain/rsu/rsu-position";
import {
  type FeeSchedule,
  type TaxRates,
  MissingGrantPriceError,
  TREATMENT_LABELS_HE,
  asPercent,
} from "@/domain/rsu/rsu-tax";
import { type CalendarDate, dateKey, formatDate } from "@/domain/time/calendar-date";

import { type KnownPrice } from "./known-price";
import { Field, Shares, SubmitButton } from "./panels";

/**
 * The two forward-looking halves of the RSU screen: which lots to sell to raise
 * money by a date, and what is still coming.
 *
 * The funding question is the only place in the system where the machine picks
 * something rather than reporting it, so the screen shows the whole of what it
 * picked — every lot, every share count, and the tax each one met — beside the
 * lots it was not allowed to consider and why. A selection whose reasoning is
 * invisible is a selection nobody can argue with.
 *
 * The schedule is deliberately dull. Every future vest is valued at one price,
 * the same price, with no growth between them: what it answers is what is already
 * promised, not what a share will be worth.
 */

/** A target amount off the query string. Unreadable reads as absent. */
export function readTarget(value: string | undefined): Money | null {
  if (value === undefined) return null;
  try {
    return parseMoneyInput(value, "USD");
  } catch {
    return null;
  }
}

// --- raising a target by a date ------------------------------------------------

export function FundingPanel({
  position,
  target,
  targetDate,
  salePrice,
  known,
  rates,
  fees,
}: {
  /** Read as of the target date, so a lot vesting before then is a candidate. */
  position: RsuPosition;
  target: Money | null;
  targetDate: CalendarDate;
  salePrice: SharePrice | null;
  known: KnownPrice | null;
  rates: TaxRates;
  fees: FeeSchedule;
}) {
  const used = salePrice ?? known?.price ?? null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">אילו מנות למכור</h2>
      <p className="mt-1 text-sm text-stone-600">
        כמה כסף צריך, ועד מתי. הבחירה היא של המנות שהמס עליהן הנמוך ביותר — לא הוותיקות ביותר, שזו
        מוסכמת המסך שלמעלה. היעד נמדד על <span className="font-medium">הנטו</span>: מכירה עד גובה
        היעד בברוטו הייתה משאירה את משק הבית חסר בדיוק את המס.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-4">
        <Field label="סכום דרוש" note="דולרים">
          <input
            name="target"
            inputMode="decimal"
            dir="ltr"
            defaultValue={target === null ? "" : String(target.minorUnits / 100)}
            className="tabular w-32 rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>
        <Field label="עד מתי" note="מנה שטרם הבשילה עד אז אינה נספרת">
          <input
            type="date"
            name="targetDate"
            defaultValue={dateKey(targetDate)}
            className="rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>
        <Field label="מחיר למניה" note="דולרים">
          <input
            name="sellPrice"
            inputMode="decimal"
            dir="ltr"
            defaultValue={used === null ? "" : sharePriceToDecimalString(used)}
            className="tabular w-32 rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>
        <SubmitButton label="בחירת מנות" subtle />
      </form>

      {used === null ? (
        <p className="mt-4 text-sm text-stone-600">
          אין מחיר להשתמש בו. המערכת אינה קוראת שערי שוק — יש להקליד מחיר.
        </p>
      ) : target === null ? (
        <p className="mt-4 text-sm text-stone-600">
          יש להזין סכום דרוש. בלי סכום אין מה לבחור — מכירה היא תשובה לשאלה ״כמה צריך״.
        </p>
      ) : (
        <Selected
          position={position}
          target={target}
          targetDate={targetDate}
          salePrice={used}
          rates={rates}
          fees={fees}
          priceNote={
            salePrice === null && known !== null
              ? `המחיר לא הוקלד — נלקח מ${known.from}. הוא אינו מחיר שוק.`
              : null
          }
        />
      )}
    </section>
  );
}

function Selected({
  position,
  target,
  targetDate,
  salePrice,
  rates,
  fees,
  priceNote,
}: {
  position: RsuPosition;
  target: Money;
  targetDate: CalendarDate;
  salePrice: SharePrice;
  rates: TaxRates;
  fees: FeeSchedule;
  priceNote: string | null;
}) {
  let selection: LotSelection;
  try {
    selection = selectLots({ position, target, targetDate, salePrice, rates, fees });
  } catch (error) {
    if (error instanceof MissingGrantPriceError) {
      return (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          אחת המנות עברה את התקופה ולא נרשם GP להקצאה שלה, ולכן אין לתמחר אותה.
        </p>
      );
    }
    return (
      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }

  const { sale } = selection;

  return (
    <div className="mt-5">
      {priceNote === null ? null : <p className="text-xs text-stone-500">{priceNote}</p>}

      <dl className="mt-3 grid gap-4 sm:grid-cols-4">
        <Figure label="מניות למכירה" value={<Shares count={sale.shares} />} note={`מתוך ${position.remainingShares} מוחזקות`} />
        <Figure
          label="מס"
          value={<bdi className="tabular">{format(sale.totalTax)}</bdi>}
          note={`${asPercent(rates.ordinaryBasisPoints)}% שולי · ${asPercent(rates.capitalGainsBasisPoints)}% רווח הון`}
        />
        <Figure
          label="עמלות"
          value={<bdi className="tabular">{format(sale.fees.total)}</bdi>}
          note="יורדות מהנטו, לא מהבסיס החייב"
        />
        <Figure
          label="נטו — מה שיגיע"
          value={<bdi className="tabular">{format(sale.netProceeds)}</bdi>}
          note={`היעד: ${format(target)}`}
          emphasis
        />
      </dl>

      {selection.reachesTarget ? (
        <p className="mt-3 text-sm text-emerald-800">
          זו הבחירה הזולה ביותר במס מבין אלה שמגיעות ליעד. אין צירוף אחר של מנות שמגיע ליעד ועולה
          פחות.
        </p>
      ) : (
        <p className="mt-3 text-sm text-amber-800">
          גם מכירת כל מה שאפשר עד {formatDate(targetDate)} אינה מגיעה ליעד: חסרים{" "}
          <bdi className="tabular font-medium">
            {selection.shortfall === null ? "—" : format(selection.shortfall)}
          </bdi>
          .
        </p>
      )}

      <SelectionLines selection={selection} />
      <ExcludedLots excluded={selection.excluded} targetDate={targetDate} />

      <p className="mt-3 text-xs text-stone-500">
        השיעורים והעמלות הם של משק הבית.{" "}
        <Link href="/settings" className="underline underline-offset-4">
          שינוי בהגדרות
        </Link>
      </p>
    </div>
  );
}

function SelectionLines({ selection }: { selection: LotSelection }) {
  if (selection.sale.lines.length === 0) {
    return <p className="mt-4 text-sm text-stone-500">אין מנות למכור.</p>;
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-stone-300 text-xs text-stone-500">
            <th className="py-2 text-start font-medium">מנה</th>
            <th className="py-2 text-start font-medium">מניות</th>
            <th className="py-2 text-start font-medium">מעמד</th>
            <th className="py-2 text-start font-medium">ברוטו</th>
            <th className="py-2 text-start font-medium">מס</th>
          </tr>
        </thead>
        <tbody>
          {selection.sale.lines.map((line) => (
            <tr key={line.lot.vest.id} className="border-b border-stone-200 align-top">
              <td className="py-3">
                <bdi>{formatDate(line.lot.vest.vestedOn)}</bdi>
                <span className="block text-xs text-stone-500">
                  <bdi>{line.lot.grant.reference}</bdi>
                </span>
              </td>
              <td className="py-3">
                <Shares count={line.shares} />
                <span className="block text-xs text-stone-500">
                  מתוך <Shares count={line.lot.remainingShares} />
                </span>
              </td>
              <td className="py-3">
                <span
                  className={
                    line.treatment === "qualified"
                      ? "rounded-sm border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-900"
                      : "rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900"
                  }
                >
                  {TREATMENT_LABELS_HE[line.treatment]}
                </span>
              </td>
              <td className="tabular py-3">
                <bdi>{format(line.grossProceeds)}</bdi>
              </td>
              <td className="tabular py-3 font-medium">
                <bdi>{format(line.totalTax)}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EXCLUSION_WORDS = {
  "not-vested": "טרם הבשילה עד התאריך",
  "no-grant-price": "עברה את התקופה ולא נרשם GP להקצאה שלה",
} as const;

/**
 * The lots the selection was not allowed to draw on. Reported rather than left
 * out: "we are short until November" is the answer, and a selection that silently
 * ignored a lot would look like a smaller position.
 */
function ExcludedLots({
  excluded,
  targetDate,
}: {
  excluded: readonly ExcludedLot[];
  targetDate: CalendarDate;
}) {
  if (excluded.length === 0) return null;

  return (
    <div className="mt-4 rounded-md border border-stone-200 bg-stone-50/60 p-4">
      <p className="text-xs font-semibold tracking-wide text-stone-500">
        מנות שלא נשקלו לתאריך {formatDate(targetDate)}
      </p>
      <ul className="mt-2 space-y-1 text-sm text-stone-600">
        {excluded.map((entry) => (
          <li key={entry.lot.vest.id} className="flex flex-wrap items-baseline gap-x-3">
            <bdi>{formatDate(entry.lot.vest.vestedOn)}</bdi>
            <span>
              <Shares count={entry.lot.remainingShares} /> מניות
            </span>
            <span className="text-xs text-stone-500">
              <bdi>{entry.lot.grant.reference}</bdi> — {EXCLUSION_WORDS[entry.reason]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- what is still coming ------------------------------------------------------

export function SchedulePanel({
  position,
  salePrice,
  known,
}: {
  position: RsuPosition;
  salePrice: SharePrice | null;
  known: KnownPrice | null;
}) {
  const used = salePrice ?? known?.price ?? null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הבשלות עתידיות</h2>
      <p className="mt-1 text-sm text-stone-600">
        מה שכבר מובטח, ומתי. כל שורה מוערכת ב<span className="font-medium">אותו מחיר</span> — המחיר
        של היום — ובלי שום הנחת צמיחה בין השורות. תחזית שמניחה עלייה עונה על שאלה אחרת: כמה תהיה
        המניה שווה. זו עונה על מה שכבר קיים.
      </p>

      {used === null ? (
        <p className="mt-4 text-sm text-stone-600">אין מחיר להשתמש בו — יש להקליד אחד למעלה.</p>
      ) : (
        <ScheduleTable schedule={forwardSchedule(position, used)} />
      )}
    </section>
  );
}

function ScheduleTable({ schedule }: { schedule: VestSchedule }) {
  if (schedule.rows.length === 0) {
    return (
      <p className="mt-4 text-sm text-stone-500">
        אין הבשלות שתאריכן טרם הגיע. הבשלה עתידית נרשמת מהמסמך, תחת ההקצאה שלה.
      </p>
    );
  }

  return (
    <>
      <p className="mt-4 text-sm text-stone-600">
        <bdi className="tabular font-medium">{schedule.totalShares}</bdi> מניות בסך הכול, ששוות{" "}
        <bdi className="tabular font-medium">{format(schedule.totalValue)}</bdi> במחיר{" "}
        <bdi className="tabular">{formatSharePrice(schedule.price)}</bdi>.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-stone-300 text-xs text-stone-500">
              <th className="py-2 text-start font-medium">תאריך</th>
              <th className="py-2 text-start font-medium">הקצאה</th>
              <th className="py-2 text-start font-medium">מניות</th>
              <th className="py-2 text-start font-medium">שווי במחיר של היום</th>
              <th className="py-2 text-start font-medium">מצטבר</th>
            </tr>
          </thead>
          <tbody>
            {schedule.rows.map((row) => (
              <tr key={row.vest.id} className="border-b border-stone-200 align-top">
                <td className="py-3">
                  <bdi>{formatDate(row.vest.vestedOn)}</bdi>
                  <span className="block text-xs text-stone-500">
                    עוברת את התקופה ב־{formatDate(row.qualifiedFrom)}
                  </span>
                </td>
                <td className="py-3">
                  <bdi>{row.grant.reference}</bdi>
                </td>
                <td className="py-3">
                  <Shares count={row.vest.shares} />
                </td>
                <td className="tabular py-3">
                  <bdi>{format(row.value)}</bdi>
                </td>
                <td className="tabular py-3 text-stone-500">
                  <bdi>{format(row.cumulativeValue)}</bdi>
                  <span className="block text-xs">
                    <Shares count={row.cumulativeShares} /> מניות
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Figure({
  label,
  value,
  note,
  emphasis = false,
}: {
  label: string;
  value: React.ReactNode;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className={`mt-1 ${emphasis ? "text-2xl font-semibold" : "text-xl"}`}>{value}</dd>
      <p className="text-xs text-stone-500">
        <bdi>{note}</bdi>
      </p>
    </div>
  );
}
