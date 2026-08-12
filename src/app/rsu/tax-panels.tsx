import Link from "next/link";

import { type DatedRate } from "@/db/money-settings";
import { type Money, convert, format, isNegative, isZero } from "@/domain/money/money";
import {
  type RsuPosition,
  type SharePrice,
  formatSharePrice,
  sharePriceToDecimalString,
} from "@/domain/rsu/rsu-position";
import {
  type FeeSchedule,
  type LotSaleTax,
  type SaleProceeds,
  type TaxRates,
  type Treatment,
  type WaitingValue,
  MissingGrantPriceError,
  TREATMENT_LABELS_HE,
  asPercent,
  hasFees,
  sellFromPosition,
  waitingValues,
} from "@/domain/rsu/rsu-tax";
import { dateKey, dateOf, formatDate } from "@/domain/time/calendar-date";

import { type KnownPrice } from "./known-price";
import { Field, Shares, SubmitButton } from "./panels";

/**
 * The two questions the tax half of the screen answers: what arrives if a number
 * of shares is sold, and what waiting is worth.
 *
 * Neither figure is stored and neither picks its own treatment — every line says
 * which of סעיף 102's two treatments its lot met, and the reading date decides
 * that rather than anybody's memory. The rates and the fees are named on the
 * screen beside the figures they produced, because a net figure whose
 * assumptions are elsewhere is a number nobody can check.
 */

type Priced =
  | { readonly kind: "ok"; readonly sale: SaleProceeds }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * A sale is priced or it is refused, never approximated. A Qualified lot out of a
 * grant with no GP recorded cannot be priced at all, and inventing one would put
 * a number on the screen that rests on nothing.
 */
function price(work: () => SaleProceeds): Priced {
  try {
    return { kind: "ok", sale: work() };
  } catch (error) {
    if (error instanceof MissingGrantPriceError) {
      return {
        kind: "blocked",
        reason:
          "אחת המנות עברה את התקופה ולא נרשם GP להקצאה שלה. בלי GP אין לחלק בין הכנסת עבודה לרווח הון, ולכן אין מה לחשב.",
      };
    }
    return { kind: "blocked", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- selling a number of shares ------------------------------------------------

export function SalePricingPanel({
  position,
  rates,
  fees,
  todayRate,
  shares,
  salePrice,
  known,
}: {
  position: RsuPosition;
  rates: TaxRates;
  fees: FeeSchedule;
  todayRate: DatedRate | null;
  shares: number | null;
  salePrice: SharePrice | null;
  known: KnownPrice | null;
}) {
  const asked = shares ?? position.remainingShares;
  const used = salePrice ?? known?.price ?? null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">מה יגיע לבנק אם אמכור</h2>
      <p className="mt-1 text-sm text-stone-600">
        המניות נמשכות מהמנה הוותיקה ביותר קודם. זו מוסכמה מוצהרת ולא אופטימיזציה — אילו מנות זולות
        יותר למכור היא שאלה נפרדת. כל מנה משלמת לפי השעון שלה, והמכירה נקראת נכון ל־
        {formatDate(position.asOf)}.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-4">
        <input type="hidden" name="asOf" value={dateKey(position.asOf)} />
        <Field label="מניות למכירה">
          <input
            name="sellShares"
            inputMode="numeric"
            dir="ltr"
            defaultValue={String(asked)}
            className="tabular w-28 rounded-md border border-stone-300 px-3 py-2 text-end"
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
        <SubmitButton label="חישוב" subtle />
      </form>

      {used === null ? (
        <p className="mt-4 text-sm text-stone-600">
          אין מחיר להשתמש בו. המערכת אינה קוראת שערי שוק — יש להקליד מחיר, או לרשום הבשלה שמחירה
          ידוע.
        </p>
      ) : (
        <PricedSale
          priced={price(() =>
            sellFromPosition({ position, shares: asked, salePrice: used, soldOn: position.asOf, rates, fees }),
          )}
          rates={rates}
          fees={fees}
          todayRate={todayRate}
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

function PricedSale({
  priced,
  rates,
  fees,
  todayRate,
  priceNote,
}: {
  priced: Priced;
  rates: TaxRates;
  fees: FeeSchedule;
  todayRate: DatedRate | null;
  priceNote: string | null;
}) {
  if (priced.kind === "blocked") {
    return (
      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        {priced.reason}
      </p>
    );
  }

  const { sale } = priced;

  if (sale.shares === 0) {
    return (
      <p className="mt-4 text-sm text-stone-600">
        אין מניות מוחזקות למכור נכון לתאריך הזה.
      </p>
    );
  }

  return (
    <div className="mt-5">
      {priceNote === null ? null : <p className="text-xs text-stone-500">{priceNote}</p>}

      <dl className="mt-3 grid gap-4 sm:grid-cols-4">
        <Figure label="תמורה ברוטו" amount={sale.grossProceeds} note={`${sale.shares} מניות במחיר ${formatSharePrice(sale.salePrice)}`} />
        <Figure
          label="מס"
          amount={sale.totalTax}
          note={`${asPercent(rates.ordinaryBasisPoints)}% שולי · ${asPercent(rates.capitalGainsBasisPoints)}% רווח הון`}
        />
        <Figure
          label="עמלות"
          amount={sale.fees.total}
          note={hasFees(fees) ? "יורדות מהנטו, לא מהבסיס החייב" : "לא הוגדרו עמלות"}
        />
        <Figure label="נטו — מה שיגיע" amount={sale.netProceeds} note="ברוטו פחות מס ופחות עמלות" emphasis />
      </dl>

      <p className="mt-3 text-sm text-stone-600">
        <span className="text-stone-500">בשקלים: </span>
        {todayRate === null ? (
          <span>אין שער שמור להיום, ולכן אין להמיר לפיו. הנטו נשאר בדולרים.</span>
        ) : (
          <>
            <bdi className="tabular font-medium">{format(convert(sale.netProceeds, todayRate))}</bdi>{" "}
            <span className="text-stone-500">
              לפי שער {todayRate.rate} מ־{formatDate(dateOf(todayRate.asOf))}
            </span>
          </>
        )}
      </p>

      {sale.shortfallShares === 0 ? null : (
        <p className="mt-2 text-sm text-amber-800">
          התבקשו <Shares count={sale.requestedShares} /> מניות ויש רק <Shares count={sale.shares} /> —
          החישוב הוא על מה שקיים, וחסרות <Shares count={sale.shortfallShares} />.
        </p>
      )}

      {sale.restsOnEstimate ? (
        <p className="mt-2 text-sm text-amber-800">
          חלק מהמספר הזה נשען על GP שנאמד ולא נמדד. המס על מנה שעברה את התקופה נגזר מה־GP, ולכן
          האומדן עובר אל תוך הנטו.
        </p>
      ) : null}

      <SaleLines lines={sale.lines} />

      <p className="mt-3 text-xs text-stone-500">
        השיעורים והעמלות הם של משק הבית.{" "}
        <Link href="/settings" className="underline underline-offset-4">
          שינוי בהגדרות
        </Link>
      </p>
    </div>
  );
}

function SaleLines({ lines }: { lines: readonly LotSaleTax[] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[42rem] text-sm">
        <thead>
          <tr className="border-b border-stone-300 text-xs text-stone-500">
            <th className="py-2 text-start font-medium">מנה</th>
            <th className="py-2 text-start font-medium">מניות</th>
            <th className="py-2 text-start font-medium">מעמד</th>
            <th className="py-2 text-start font-medium">הכנסת עבודה</th>
            <th className="py-2 text-start font-medium">רווח הון</th>
            <th className="py-2 text-start font-medium">מס</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.lot.vest.id} className="border-b border-stone-200 align-top">
              <td className="py-3">
                <bdi>{formatDate(line.lot.vest.vestedOn)}</bdi>
                <span className="block text-xs text-stone-500">
                  <bdi>{line.lot.grant.reference}</bdi>
                </span>
              </td>
              <td className="py-3">
                <Shares count={line.shares} />
              </td>
              <td className="py-3">
                <TreatmentBadge treatment={line.treatment} />
              </td>
              <td className="tabular py-3">
                <bdi>{format(line.ordinaryIncome)}</bdi>
                <span className="block text-xs text-stone-500">
                  מס <bdi>{format(line.ordinaryTax)}</bdi>
                </span>
                {line.belowGrantPrice ? (
                  <span className="block text-xs text-amber-800">המחיר מתחת ל־GP — הכול הכנסת עבודה</span>
                ) : null}
              </td>
              <td className="tabular py-3">
                <bdi>{format(line.capitalGain)}</bdi>
                <span className="block text-xs text-stone-500">
                  מס <bdi>{format(line.capitalGainsTax)}</bdi>
                </span>
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

// --- what waiting is worth -------------------------------------------------------

export function WaitingPanel({
  position,
  rates,
  fees,
  salePrice,
  known,
}: {
  position: RsuPosition;
  rates: TaxRates;
  fees: FeeSchedule;
  salePrice: SharePrice | null;
  known: KnownPrice | null;
}) {
  const used = salePrice ?? known?.price ?? null;

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">מה שווה להמתין</h2>
      <p className="mt-1 text-sm text-stone-600">
        כל מנה מתומחרת פעמיים באותו מחיר: נמכרת היום, ונמכרת ביום שבו היא עוברת את התקופה. המחיר
        מוחזק קבוע בין שתי הקריאות בכוונה — כך ההפרש הוא מה שהשעון שווה, ולא ניחוש על מחיר המניה.
      </p>

      {used === null ? (
        <p className="mt-4 text-sm text-stone-600">אין מחיר להשתמש בו — יש להקליד אחד למעלה.</p>
      ) : (
        <WaitingTable rows={waitingValues({ position, salePrice: used, rates, fees })} />
      )}
    </section>
  );
}

function WaitingTable({ rows }: { rows: readonly WaitingValue[] }) {
  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-stone-500">אין מנות מוחזקות.</p>;
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-stone-300 text-xs text-stone-500">
            <th className="py-2 text-start font-medium">מנה</th>
            <th className="py-2 text-start font-medium">מניות</th>
            <th className="py-2 text-start font-medium">נטו היום</th>
            <th className="py-2 text-start font-medium">נטו אחרי התקופה</th>
            <th className="py-2 text-start font-medium">ההפרש</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.lot.vest.id} className="border-b border-stone-200 align-top">
              <td className="py-3">
                <bdi>{formatDate(row.lot.vest.vestedOn)}</bdi>
                <span className="block text-xs text-stone-500">
                  <bdi>{row.lot.grant.reference}</bdi>
                </span>
              </td>
              <td className="py-3">
                <Shares count={row.shares} />
              </td>
              <td className="tabular py-3">
                <bdi>{format(row.today.netProceeds)}</bdi>
                <span className="block text-xs text-stone-500">
                  <TreatmentLabel treatment={row.today.lines[0]?.treatment ?? "qualified"} />
                </span>
              </td>
              <td className="tabular py-3">
                {row.alreadyQualified ? (
                  <span className="text-xs text-stone-500">אין מה להמתין — עברה ב־{formatDate(row.qualifiedFrom)}</span>
                ) : (
                  <>
                    <bdi>{format(row.onceQualified.netProceeds)}</bdi>
                    <span className="block text-xs text-stone-500">מ־{formatDate(row.qualifiedFrom)}</span>
                  </>
                )}
              </td>
              <td className="tabular py-3 font-medium">
                <Difference amount={row.difference} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A difference of nothing is not a saving. It reads as nothing rather than as ₪0. */
function Difference({ amount }: { amount: Money }) {
  if (isZero(amount)) return <span className="text-xs font-normal text-stone-500">—</span>;
  return (
    <bdi className={isNegative(amount) ? "text-red-800" : "text-emerald-800"}>{format(amount)}</bdi>
  );
}

function TreatmentBadge({ treatment }: { treatment: Treatment }) {
  return treatment === "qualified" ? (
    <span className="rounded-sm border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-900">
      {TREATMENT_LABELS_HE.qualified}
    </span>
  ) : (
    <span className="rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900">
      {TREATMENT_LABELS_HE.unqualified}
    </span>
  );
}

function TreatmentLabel({ treatment }: { treatment: Treatment }) {
  return <>{TREATMENT_LABELS_HE[treatment]}</>;
}

function Figure({
  label,
  amount,
  note,
  emphasis = false,
}: {
  label: string;
  amount: Money;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className={`tabular mt-1 ${emphasis ? "text-2xl font-semibold" : "text-xl"}`}>
        <bdi>{format(amount)}</bdi>
      </dd>
      <p className="text-xs text-stone-500">
        <bdi>{note}</bdi>
      </p>
    </div>
  );
}
