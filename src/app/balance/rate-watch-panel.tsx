import Link from "next/link";

import {
  type AnnualItems,
  type Renewal,
  annualItemsByName,
  renewalsOf,
} from "@/domain/ledger/annual-items";
import {
  type CurrentRate,
  type ItemRate,
  type RateWatch,
  type RateWatchChange,
  type RateWatchItemRow,
  type RateWatchItemYear,
  type RateWatchRow,
  type RateWatchYear,
} from "@/domain/ledger/rate-watch";
import { format, toDecimalString } from "@/domain/money/money";
import { dateKey, formatDate } from "@/domain/time/calendar-date";
import { type CalendarMonth } from "@/domain/time/calendar-month";

import { monthsPhrase } from "./denominator";
import { type GridLinks } from "./grid-links";
import { ReturnToFields } from "./grid-panels";
import { correctRenewal, createAnnualItem, recordRenewal, removeRenewal } from "./rate-actions";

/**
 * מעקב תעריפים on screen, directly beneath the year grid.
 *
 * It is **always rendered** and never behind a link. Both of the spreadsheet's
 * attempts at this died of being somewhere nobody went: a `שנתי` block that
 * exists on one tab and no later one, and a `ביטוחים` block filled in once and
 * copied forward unchanged for two years. At a dozen rows this is nothing like
 * the screenful of forms that justified hiding `?admin=1`.
 *
 * Two bands, and they are never added together. The **typed** one holds the
 * annual bills somebody types — `ביטוח רכב מקיף, 4,104, ספטמבר 2025` — and the
 * **derived** one reads the monthly charges straight off the ledger. One is a
 * detail of ledger rows and the other *is* ledger rows, so a total across them
 * would be a figure with no meaning; each prints its own subtotal and the page
 * prints no third.
 *
 * Nothing here computes anything. Every figure arrives from `rateWatch` already
 * decided — the rate, the two years, the change, and which rows are worth a
 * second look — so the panel cannot disagree with the reading it renders.
 *
 * Three things the markup has to keep, all inherited from the grid above:
 *
 * - **A blank is not a zero.** A year with nothing recorded for a watched line is
 *   a muted dash; a year an annual bill was not renewed in says `לא חודש`; a year
 *   before the item existed at all says so too, because they are three different
 *   facts and only one of them is worth a phone call.
 * - **The subtotal is a sum of rates and not of spending.** These amounts are
 *   already inside the grid's own rows; adding this panel to that table would
 *   count the same shekel twice.
 * - **The forms are closed by default.** `?rateEdit=1` opens them, in the same
 *   idiom as `?admin=1`, so the panel reads clean the rest of the time.
 */

/** The anchor the panel's own links land on, so opening the forms scrolls to them. */
export const RATE_PANEL_ID = "rates";

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

const FIELD = "mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5";
const BUTTON = "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50";

/** How a row that moved far enough is marked, and told. */
const RATE_MARK = {
  up: { glyph: "▲", tone: "text-rose-700", label: "עלייה בתעריף" },
  down: { glyph: "▼", tone: "text-emerald-700", label: "ירידה בתעריף" },
} as const;

export function RateWatchPanel({
  watch,
  items,
  links,
  editing,
  openItem,
}: {
  watch: RateWatch;
  /** The typed model itself, which the correction forms need a full history from. */
  items: AnnualItems;
  links: GridLinks;
  /** `?rateEdit=1` — whether the typed band's forms are open. */
  editing: boolean;
  /** `?rateItem=<id>` — whose price history is open for correction. */
  openItem: string | null;
}) {
  return (
    <section id={RATE_PANEL_ID} className="space-y-3 scroll-mt-4">
      <div>
        <h2 className="text-lg font-semibold">מעקב תעריפים</h2>
        <p className="mt-1 text-sm text-stone-600">
          מה עולה לנו כל חודש וכל שנה, וכמה זה זז מול השנה הקודמת — השאלה שלפניה מרימים טלפון ומתווכחים.
          הסכומים כאן הם פירוט של כסף שהטבלה שלמעלה כבר סופרת, ולא הוצאה נוספת: לכל להקה יש סכום משלה,
          ואין ולא יהיה סכום אחד לשתיהן. הפאנל מסכם תמיד את שני בני הבית, בכל לשונית.
        </p>
      </div>

      <AnnualBand watch={watch} items={items} links={links} editing={editing} openItem={openItem} />

      {watch.monthly.rows.length === 0 ? (
        <EmptyMonthlyBand links={links} />
      ) : (
        <MonthlyBand watch={watch} />
      )}
    </section>
  );
}

// --- the typed band ------------------------------------------------------------

/**
 * פריטים שנתיים — the half the ledger cannot supply.
 *
 * A year here is a whole calendar year, and never a rate times twelve: an annual
 * bill is one dated event, so there is no partial year of it to match against the
 * derived band's ינואר–יולי.
 */
function AnnualBand({
  watch,
  items,
  links,
  editing,
  openItem,
}: {
  watch: RateWatch;
  items: AnnualItems;
  links: GridLinks;
  editing: boolean;
  openItem: string | null;
}) {
  const { annual: band, year, previousYear } = watch;

  return (
    <section className="overflow-hidden rounded-lg border border-stone-300 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <h3 className="text-base font-semibold">פריטים שנתיים</h3>
        <p className="text-xs text-stone-500">
          הסכום הוא מחיר הפוליסה כולה, בכמה תשלומים שלא חויבה — זה המספר שמתווכחים עליו. השנה נגזרת
          מתאריך החידוש ואינה נשמרת בשום מקום.
        </p>
      </div>

      {band.rows.length === 0 ? (
        <p className="border-t border-stone-200 px-4 py-5 text-sm text-stone-600">
          עוד לא נרשם אף פריט שנתי — ביטוח רכב, רו״ח, רישוי. אלה החיובים שהמאזן סופר אבל אינו יודע
          לפרט, וכאן נרשם מה כל אחד מהם עלה בכל חידוש.
        </p>
      ) : (
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
                  פריט
                </th>
                <HeadCell>תעריף נוכחי</HeadCell>
                <HeadCell>
                  <bdi className="tabular">{year}</bdi>
                  <YearNote />
                </HeadCell>
                <HeadCell>
                  <bdi className="tabular">{previousYear}</bdi>
                  <YearNote />
                </HeadCell>
                <HeadCell>שינוי</HeadCell>
              </tr>
            </thead>

            <tbody>
              {band.rows.map((row) => (
                <ItemRow key={row.key} row={row} />
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
                {/* The band's own subtotal and nothing else. No figure on this page
                    adds this line to the one at the foot of the band below it. */}
                <td
                  colSpan={3}
                  className="border-t-2 border-stone-300 bg-stone-50 px-2 py-2 text-start text-xs text-stone-500"
                >
                  {band.unratedRows === 0 ? (
                    <>סכום החידושים האחרונים לחודש. שייך ללהקה הזו בלבד.</>
                  ) : (
                    <>
                      סכום <bdi className="tabular">{band.ratedRows}</bdi> התעריפים החודשיים.{" "}
                      <bdi className="tabular">{band.unratedRows}</bdi> פריטים בלי חידוש רשום אינם
                      נכללים.
                    </>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="border-t border-stone-200 px-4 py-3">
        {editing ? (
          <AnnualForms items={items} links={links} openItem={openItem} />
        ) : (
          <p className="text-sm text-stone-600">
            <Link href={links.openRates} className="underline underline-offset-4">
              רישום ותיקון של פריטים שנתיים
            </Link>{" "}
            — הוספת פריט, רישום חידוש ותיקון של מה שכבר נרשם. שום דבר כאן אינו נכתב למאזן.
          </p>
        )}
      </div>
    </section>
  );
}

/** A typed year is a whole one. Said once per column so the two cannot read alike. */
function YearNote() {
  return <span className="block text-[0.65rem] font-normal text-stone-500">שנה מלאה</span>;
}

function ItemRow({ row }: { row: RateWatchItemRow }) {
  return (
    <tr>
      <th
        scope="row"
        className={`${PINNED_START} ${NAME_PADDING} border-t border-stone-100 bg-white py-2 text-start font-normal`}
      >
        <bdi>{row.name}</bdi>
      </th>

      <td className={`${FIGURE_PADDING} border-t border-stone-100 py-2 text-end`}>
        <ItemRateCell rate={row.rate} />
      </td>

      <ItemYearCell reading={row.current} />
      <ItemYearCell reading={row.previous} />

      <td className={`${FIGURE_PADDING} border-t border-stone-100 py-2 text-end`}>
        <Change change={row.change} missing="לא חודש השנה" records="חידושים" />
      </td>
    </tr>
  );
}

/**
 * The policy total over twelve, and the renewal it rests on. The division is the
 * reading's, not this component's — every figure here arrives decided.
 */
function ItemRateCell({ rate }: { rate: ItemRate }) {
  if (rate.kind === "never") {
    return (
      <>
        <span className="text-stone-600">אין חידוש</span>
        <span className="block text-[0.65rem] text-stone-400">לא נרשם מחיר</span>
      </>
    );
  }

  return (
    <>
      <bdi className="tabular font-medium">
        עכשיו {format(rate.monthly, { withSymbol: false })}/חודש
      </bdi>
      <span className="block text-[0.65rem] font-normal text-stone-400">
        <bdi className="tabular">{format(rate.total, { withSymbol: false })}</bdi> ב־
        <bdi>{formatDate(rate.renewedOn)}</bdi>
      </span>
    </>
  );
}

/**
 * One year of one item, in three states that must not read alike: what it cost, a
 * year it was not renewed in, and a year before it existed at all. Only the middle
 * one is a hole somebody might want to fill.
 */
function ItemYearCell({ reading }: { reading: RateWatchItemYear }) {
  const { reading: year } = reading;

  return (
    <td className={`${FIGURE_PADDING} border-t border-stone-100 py-2 text-end`}>
      {year.kind === "renewed" ? (
        <>
          <bdi className="tabular">{format(year.total, { withSymbol: false })}</bdi>
          {year.renewals > 1 ? (
            <span className="block text-[0.65rem] text-stone-500">
              <bdi className="tabular">{year.renewals}</bdi> חידושים
            </span>
          ) : null}
        </>
      ) : year.kind === "not-renewed" ? (
        <span className="text-[0.7rem] text-stone-500">לא חודש</span>
      ) : (
        <span className="text-stone-300" aria-label="לפני שהפריט קיים">
          —
        </span>
      )}
    </td>
  );
}

// --- the typed band's forms -----------------------------------------------------

/**
 * Entry and correction, behind `?rateEdit=1`.
 *
 * Correction ships with entry rather than after it. This is a form used about six
 * times a year: by the time a typo is noticed, nobody remembers making it, so a
 * form that can produce one and cannot fix it is a trap.
 */
function AnnualForms({
  items,
  links,
  openItem,
}: {
  items: AnnualItems;
  links: GridLinks;
  openItem: string | null;
}) {
  const known = annualItemsByName(items);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">רישום ותיקון</h4>
        <Link href={links.closeRates} className="text-sm text-stone-600 underline-offset-4 hover:underline">
          סגירת הטפסים
        </Link>
      </div>

      <form action={createAnnualItem} className="grid gap-3 sm:grid-cols-4">
        <ReturnToFields links={links} />
        <div className="sm:col-span-2">
          <label htmlFor="rate-new-name" className="block text-sm font-medium">
            פריט שנתי חדש
          </label>
          <input
            id="rate-new-name"
            name="name"
            type="text"
            autoComplete="off"
            maxLength={60}
            placeholder="ביטוח רכב מקיף"
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="rate-new-amount" className="block text-sm font-medium">
            סכום הפוליסה
          </label>
          <input
            id="rate-new-amount"
            name="amount"
            type="text"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            className={`${FIELD} tabular text-left`}
          />
        </div>
        <div>
          <label htmlFor="rate-new-date" className="block text-sm font-medium">
            תאריך החידוש
          </label>
          <input id="rate-new-date" name="renewedOn" type="date" className={FIELD} />
        </div>
        <p className="text-xs text-stone-500 sm:col-span-3">
          פריט נולד עם החידוש הראשון שלו, ומשם מתחילה ההיסטוריה שלו. השנה נגזרת מהתאריך.
        </p>
        <button type="submit" className={`${BUTTON} h-fit`}>
          הוספת פריט
        </button>
      </form>

      {known.length === 0 ? null : (
        <ul className="space-y-4">
          {known.map((item) => (
            <li key={item.id}>
              <ItemEditor
                name={item.name}
                itemId={item.id}
                history={renewalsOf(items, item.id)}
                links={links}
                open={openItem === item.id}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One item: a new renewal, and — when opened — its whole price history to correct. */
function ItemEditor({
  name,
  itemId,
  history,
  links,
  open,
}: {
  name: string;
  itemId: string;
  history: readonly Renewal[];
  links: GridLinks;
  open: boolean;
}) {
  return (
    <article className="rounded-lg border border-stone-200 bg-stone-50/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="text-sm font-semibold">
          <bdi>{name}</bdi>
        </h5>
        <Link
          href={open ? links.closeRateItem : links.openRateItem(itemId)}
          className="text-xs text-stone-600 underline-offset-4 hover:underline"
        >
          {open ? "סגירת ההיסטוריה" : `היסטוריית המחירים (${history.length})`}
        </Link>
      </div>

      <form action={recordRenewal} className="mt-3 flex flex-wrap items-end gap-2">
        <ReturnToFields links={links} />
        <input type="hidden" name="itemId" value={itemId} />
        <div className="w-32">
          <label htmlFor={`renew-amount-${itemId}`} className="block text-xs font-medium">
            חידוש חדש
          </label>
          <input
            id={`renew-amount-${itemId}`}
            name="amount"
            type="text"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            className={`${FIELD} tabular text-left`}
          />
        </div>
        <div className="w-44">
          <label htmlFor={`renew-date-${itemId}`} className="block text-xs font-medium">
            בתאריך
          </label>
          <input id={`renew-date-${itemId}`} name="renewedOn" type="date" className={FIELD} />
        </div>
        <button type="submit" className={BUTTON}>
          רישום חידוש
        </button>
      </form>

      {open ? <RenewalHistory itemId={itemId} history={history} links={links} /> : null}
    </article>
  );
}

/**
 * Every price ever recorded for one item, each correctable and removable in
 * place. The date is an ordinary field: a renewal filed under the wrong year is
 * corrected by moving its date, because the year is derived from it and there is
 * no year anywhere to edit.
 */
function RenewalHistory({
  itemId,
  history,
  links,
}: {
  itemId: string;
  history: readonly Renewal[];
  links: GridLinks;
}) {
  if (history.length === 0) {
    return (
      <p className="mt-3 border-t border-stone-200 pt-3 text-xs text-stone-500">
        לא נותר אף מחיר רשום לפריט הזה. הפריט עצמו נשאר — אין כאן מחיקה של פריטים.
      </p>
    );
  }

  return (
    <ul className="mt-3 space-y-2 border-t border-stone-200 pt-3">
      {history.map((renewal) => {
        const key = dateKey(renewal.renewedOn);
        return (
          <li key={key} className="flex flex-wrap items-end gap-2">
            <form action={correctRenewal} className="flex flex-wrap items-end gap-2">
              <ReturnToFields links={links} />
              <input type="hidden" name="itemId" value={itemId} />
              <input type="hidden" name="originalOn" value={key} />
              <div className="w-32">
                <label htmlFor={`fix-amount-${itemId}-${key}`} className="block text-xs font-medium">
                  סכום
                </label>
                <input
                  id={`fix-amount-${itemId}-${key}`}
                  name="amount"
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  autoComplete="off"
                  defaultValue={toDecimalString(renewal.amount)}
                  className={`${FIELD} tabular text-left`}
                />
              </div>
              <div className="w-44">
                <label htmlFor={`fix-date-${itemId}-${key}`} className="block text-xs font-medium">
                  תאריך
                </label>
                <input
                  id={`fix-date-${itemId}-${key}`}
                  name="renewedOn"
                  type="date"
                  defaultValue={key}
                  className={FIELD}
                />
              </div>
              <button type="submit" className={BUTTON}>
                תיקון
              </button>
            </form>

            <form action={removeRenewal}>
              <ReturnToFields links={links} />
              <input type="hidden" name="itemId" value={itemId} />
              <input type="hidden" name="renewedOn" value={key} />
              <button
                type="submit"
                className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
              >
                הסרה
              </button>
            </form>
          </li>
        );
      })}
    </ul>
  );
}

// --- the derived band ------------------------------------------------------------

/**
 * The panel renders even with nothing watched — that is the whole point of it
 * being always on screen — and says what would put something there.
 */
function EmptyMonthlyBand({ links }: { links: GridLinks }) {
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
                {band.unratedRows === 0 ? (
                  <>סכום התעריפים החודשיים של השורות שבמעקב.</>
                ) : (
                  <>
                    סכום <bdi className="tabular">{band.ratedRows}</bdi> התעריפים הקבועים.{" "}
                    <bdi className="tabular">{band.unratedRows}</bdi> שורות משתנות אינן נכללות — אין
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
        <Change change={row.change} missing="לא נרשם השנה" records="חודשים" />
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
 *
 * One component for both bands, because it is one comparison: only the wording of
 * *the selected year holds nothing* differs, and it differs because `לא נרשם` and
 * `לא חודש` are two different absences.
 */
function Change({
  change,
  missing,
  records,
}: {
  change: RateWatchChange;
  missing: string;
  /** What the two sides are counted in — months below, renewals above. */
  records: string;
}) {
  if (change.kind === "not-recorded") {
    return <span className="text-stone-400 text-[0.7rem]">{missing}</span>;
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
          <bdi className="tabular">{change.previous}</bdi> {records}
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
