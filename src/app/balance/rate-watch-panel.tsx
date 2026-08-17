import Link from "next/link";

import {
  type CurrentRate,
  type RateWatch,
  type RateWatchChange,
  type RateWatchRow,
  type RateWatchYear,
} from "@/domain/ledger/rate-watch";
import { format } from "@/domain/money/money";
import { type CalendarMonth } from "@/domain/time/calendar-month";

import { monthsPhrase } from "./denominator";
import { type GridLinks } from "./grid-links";

/**
 * מעקב תעריפים on screen, directly beneath the year grid.
 *
 * It is **always rendered** and never behind a link. Both of the spreadsheet's
 * attempts at this died of being somewhere nobody went: a `שנתי` block that
 * exists on one tab and no later one, and a `ביטוחים` block filled in once and
 * copied forward unchanged for two years. At a dozen rows this is nothing like
 * the screenful of forms that justified hiding `?admin=1`.
 *
 * Nothing here computes anything. Every figure arrives from `rateWatch` already
 * decided — the rate, the two years, the change, and which rows are worth a
 * second look — so the panel cannot disagree with the reading it renders.
 *
 * Two things the markup has to keep, both inherited from the grid above:
 *
 * - **A blank is not a zero.** A year with nothing recorded for a watched line is
 *   a muted dash that says so to a screen reader too.
 * - **The subtotal is a sum of rates and not of spending.** These amounts are
 *   already inside the grid's own rows; adding this panel to that table would
 *   count the same shekel twice.
 */

/**
 * The panel's own columns, in the same idiom as the grid's: declared once as
 * custom properties, narrower on a phone, and read through a window that scrolls
 * inside itself so the page never scrolls sideways.
 */
const COLUMN_WIDTHS = [
  "[--rate-name:7rem] [--rate-figure:5.5rem]",
  "sm:[--rate-name:14rem] sm:[--rate-figure:8rem]",
].join(" ");

const NAME_WIDTH = "var(--rate-name)";
const FIGURE_WIDTH = "var(--rate-figure)";
const TABLE_WIDTH = `calc(${NAME_WIDTH} + 4 * ${FIGURE_WIDTH})`;

const NAME_PADDING = "px-2 sm:px-3";
const FIGURE_PADDING = "px-1.5 sm:px-3";

/** The start edge stays put while the four figures scroll past it. */
const PINNED_START = "sticky start-0 z-20";
const PINNED_TOP = "sticky top-0 z-30";
const PINNED_TOP_START = "sticky start-0 top-0 z-40";

/** How a row that moved far enough is marked, and told. */
const RATE_MARK = {
  up: { glyph: "▲", tone: "text-rose-700", label: "עלייה בתעריף" },
  down: { glyph: "▼", tone: "text-emerald-700", label: "ירידה בתעריף" },
} as const;

export function RateWatchPanel({ watch, links }: { watch: RateWatch; links: GridLinks }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">מעקב תעריפים</h2>
        <p className="mt-1 text-sm text-stone-600">
          מה עולה לנו כל חודש, וכמה זה זז מול השנה הקודמת — השאלה שלפניה מרימים טלפון ומתווכחים.
          הסכומים כאן הם פירוט של כסף שהטבלה שלמעלה כבר סופרת, ולא הוצאה נוספת: הסכום בתחתית הפאנל הוא
          סכום התעריפים ואינו מתחבר לשום סכום במאזן. הפאנל מסכם תמיד את שני בני הבית, בכל לשונית.
        </p>
      </div>

      {watch.monthly.rows.length === 0 ? (
        <EmptyPanel links={links} />
      ) : (
        <MonthlyBand watch={watch} />
      )}
    </section>
  );
}

/**
 * The panel renders even with nothing in it — that is the whole point of it being
 * always on screen — and says what would put something there.
 */
function EmptyPanel({ links }: { links: GridLinks }) {
  return (
    <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-sm text-stone-600">
      אף קטגוריה משותפת אינה מסומנת במעקב.{" "}
      <Link href={links.openAdmin} className="underline underline-offset-4">
        בניהול הקטגוריות
      </Link>{" "}
      אפשר לסמן כל שורה משותפת, והיא תופיע כאן עם התעריף שלה ועם ההשוואה לשנה שקדמה.
    </p>
  );
}

function MonthlyBand({ watch }: { watch: RateWatch }) {
  const { monthly: band, year, previousYear } = watch;

  return (
    <section className="overflow-hidden rounded-lg border border-stone-300 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <h3 className="text-base font-semibold">חיובים חודשיים</h3>
        <p className="text-xs text-stone-500">
          התעריף נקבע לפי שלושת החודשים האחרונים שנרשמו. שנה היא סכום מה שנרשם בפועל, ולא תעריף כפול
          שתים־עשרה.
        </p>
      </div>

      <div className="overflow-auto">
        <table
          className={`w-full table-fixed border-separate border-spacing-0 text-xs sm:text-sm ${COLUMN_WIDTHS}`}
          style={{ minWidth: TABLE_WIDTH }}
        >
          <colgroup>
            <col style={{ width: NAME_WIDTH }} />
            <col style={{ width: FIGURE_WIDTH }} />
            <col style={{ width: FIGURE_WIDTH }} />
            <col style={{ width: FIGURE_WIDTH }} />
            <col style={{ width: FIGURE_WIDTH }} />
          </colgroup>

          <thead>
            <tr>
              <th
                scope="col"
                className={`${PINNED_TOP_START} ${NAME_PADDING} border-y border-stone-300 bg-white py-2 text-start font-semibold`}
              >
                קטגוריה
              </th>
              <HeadCell>תעריף נוכחי</HeadCell>
              <HeadCell>
                <bdi className="tabular">{year}</bdi>
                <SpanNote months={watch.currentMonths} />
              </HeadCell>
              <HeadCell>
                <bdi className="tabular">{previousYear}</bdi>
                <SpanNote months={watch.previousMonths} />
              </HeadCell>
              <HeadCell>שינוי</HeadCell>
            </tr>
          </thead>

          <tbody>
            {band.rows.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </tbody>

          <tfoot>
            <tr>
              <th
                scope="row"
                className={`${PINNED_START} ${NAME_PADDING} border-t-2 border-stone-300 bg-stone-50 py-2 text-start font-semibold`}
              >
                סכום התעריפים
              </th>
              <td
                className={`${FIGURE_PADDING} border-t-2 border-stone-300 bg-stone-50 py-2 text-end font-semibold`}
              >
                <bdi className="tabular">{format(band.subtotal, { withSymbol: false })}</bdi>
              </td>
              {/* No total across the years: a sum of two years' spending is not a
                  rate, and this column is a column of rates. */}
              <td
                colSpan={3}
                className="border-t-2 border-stone-300 bg-stone-50 px-2 py-2 text-start text-xs text-stone-500"
              >
                {band.variableRows === 0 ? (
                  <>סכום התעריפים החודשיים של השורות שבמעקב.</>
                ) : (
                  <>
                    סכום <bdi className="tabular">{band.ratedRows}</bdi> התעריפים הקבועים.{" "}
                    <bdi className="tabular">{band.variableRows}</bdi> שורות משתנות אינן נכללות — אין
                    להן תעריף לחבר.
                  </>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/**
 * Which months a year column actually counted. In August 2026 the `2026` column
 * is ינואר–יולי and the `2025` column is the same seven months a year earlier —
 * the two are matched, and a heading that named only the years would be inviting
 * a comparison of seven months against twelve.
 */
function SpanNote({ months }: { months: readonly CalendarMonth[] }) {
  const span = monthsPhrase(months);
  if (span === null) return null;
  return (
    <span className="block text-[0.65rem] font-normal text-stone-500">
      <bdi>{span}</bdi>
    </span>
  );
}

function HeadCell({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className={`${PINNED_TOP} ${FIGURE_PADDING} border-y border-stone-300 bg-white py-2 text-end font-semibold`}
    >
      {children}
    </th>
  );
}

function Row({ row }: { row: RateWatchRow }) {
  return (
    <tr>
      <th
        scope="row"
        className={`${PINNED_START} ${NAME_PADDING} border-t border-stone-100 bg-white py-2 text-start font-normal`}
      >
        <bdi>{row.name}</bdi>
        {row.type === "income" ? (
          <span className="mt-0.5 block w-fit rounded-sm bg-stone-100 px-1.5 py-0.5 text-[0.65rem] text-stone-500">
            הכנסה
          </span>
        ) : null}
      </th>

      <td className={`${FIGURE_PADDING} border-t border-stone-100 py-2 text-end`}>
        <Rate rate={row.rate} />
      </td>

      <YearCell reading={row.current} />
      <YearCell reading={row.previous} />

      <td className={`${FIGURE_PADDING} border-t border-stone-100 py-2 text-end`}>
        <Change change={row.change} />
      </td>
    </tr>
  );
}

/**
 * The rate, or the statement that there is not one.
 *
 * A `משתנה` row is not a failure to measure: the household may watch a variable
 * line, and the honest thing to print for it is the year's own monthly average
 * with the word that says it is an average.
 */
function Rate({ rate }: { rate: CurrentRate }) {
  if (rate.kind === "fixed") {
    const span = monthsPhrase(rate.months);
    return (
      <>
        <bdi className="tabular font-medium">
          עכשיו {format(rate.amount, { withSymbol: false })}/חודש
        </bdi>
        {span === null ? null : (
          <span className="block text-[0.65rem] font-normal text-stone-400">
            <bdi>{span}</bdi>
          </span>
        )}
      </>
    );
  }

  return (
    <>
      <span className="text-stone-600">משתנה</span>
      <span className="block text-[0.65rem] text-stone-400">
        {rate.average === null ? (
          "אין ממוצע"
        ) : (
          <bdi className="tabular">
            ממוצע {format(rate.average, { withSymbol: false, withMinorUnits: false })}/חודש
          </bdi>
        )}
      </span>
    </>
  );
}

/**
 * One year's actual sum. A year nobody recorded anything in is a muted dash and
 * never a zero — the ledger's own rule, applied to a year instead of a month.
 */
function YearCell({ reading }: { reading: RateWatchYear }) {
  return (
    <td className={`${FIGURE_PADDING} border-t border-stone-100 py-2 text-end`}>
      {reading.total === null ? (
        <span className="text-stone-300" aria-label="לא נרשם">
          —
        </span>
      ) : (
        <bdi className="tabular">{format(reading.total, { withSymbol: false })}</bdi>
      )}
    </td>
  );
}

/**
 * The move in both ₪ and %, marked when it cleared both bars — or which of three
 * things stopped it being a comparison. Each of those is printed as itself: a row
 * that cannot be compared is a fact, and a dash alone would leave "nothing moved"
 * and "nothing to compare" looking identical.
 */
function Change({ change }: { change: RateWatchChange }) {
  if (change.kind === "not-recorded") {
    return <span className="text-stone-400 text-[0.7rem]">לא נרשם השנה</span>;
  }
  if (change.kind === "first-year") {
    return <span className="text-stone-500 text-[0.7rem]">שנה ראשונה</span>;
  }
  if (change.kind === "uneven") {
    return (
      <span className="text-stone-500 text-[0.7rem]">
        אין השוואה
        <span className="block text-stone-400">
          נרשמו <bdi className="tabular">{change.current}</bdi> מול{" "}
          <bdi className="tabular">{change.previous}</bdi> חודשים
        </span>
      </span>
    );
  }

  const mark = change.mark === null ? null : RATE_MARK[change.mark];
  const sign = change.amount.minorUnits > 0 ? "+" : "";

  return (
    <>
      {mark === null ? null : (
        <span className={`me-1 text-[0.6rem] ${mark.tone}`} role="img" aria-label={mark.label}>
          {mark.glyph}
        </span>
      )}
      <bdi className={`tabular ${mark === null ? "" : "font-semibold"}`}>
        {sign}
        {format(change.amount, { withSymbol: false })}
      </bdi>
      <span className="block text-[0.65rem] text-stone-500">
        {change.ratio === null ? (
          "אין אחוז מול אפס"
        ) : (
          <bdi className="tabular">
            {sign}
            {(change.ratio * 100).toFixed(1)}%
          </bdi>
        )}
      </span>
    </>
  );
}
