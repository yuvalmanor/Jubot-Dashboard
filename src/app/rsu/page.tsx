import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type Person, findPersonByEmail, listPeople } from "@/db/people";
import { type RsuRecords, loadRsuRecords } from "@/db/rsu";
import { loadHouseholdSettings } from "@/db/settings";
import { format } from "@/domain/money/money";
import {
  type GpWindow,
  type GrantReading,
  type Lot,
  type RsuPosition,
  type Sale,
  formatSharePrice,
  nextQualificationDate,
  readPosition,
  salesOf,
  sharePriceToDecimalString,
} from "@/domain/rsu/rsu-position";
import { dateKey, dateOf, formatDate, tryParseDateKey } from "@/domain/time/calendar-date";
import { requireHouseholdEmail } from "@/session";

import {
  addVest,
  createGrant,
  estimateGrantPriceFromCloses,
  recordSale,
  removeGrant,
  removeSale,
  removeVest,
  stateGrantPrice,
} from "./actions";
import {
  Field,
  GrantPriceFigure,
  Notices,
  Select,
  Shares,
  SubmitButton,
  UnavailablePanel,
  windowInWords,
} from "./panels";

export const dynamic = "force-dynamic";

/**
 * מחשבון RSU — the position, its lots, and each lot's own סעיף 102 clock.
 *
 * Nothing on this screen is stored. Every share count, every qualification and
 * every total is derived from the grants, vests and sales beneath it on each read,
 * which is why the reading date is a control: the same rows read on two days give
 * two answers, and that is the correct behaviour for a boundary whose only input
 * is the passage of time. Moving the date is how the household asks what waiting
 * is worth — and how the 24-month boundary can be looked at from either side.
 */

interface SearchParams {
  error?: string | string[];
  detail?: string | string[];
  done?: string | string[];
  asOf?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RsuPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const email = await requireHouseholdEmail();
  const params = await searchParams;
  const today = dateOf(new Date());
  const asOf = tryParseDateKey(first(params.asOf)) ?? today;
  const loaded = await loadPage(email, asOf);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={loaded.kind === "ok" ? loaded.person : null}
        title="מחשבון RSU"
        subtitle="המצב, המנות, ושעון 24 החודשים של סעיף 102 — נגזר בכל קריאה, לא נשמר"
        back={{ href: "/", label: "חזרה ללוח המחוונים" }}
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <Notices error={first(params.error)} detail={first(params.detail)} done={first(params.done)} />

        {loaded.kind === "ok" ? (
          <>
            <AsOfControl asOf={asOf} today={today} />
            <PositionPanel position={loaded.position} window={loaded.window} />

            {loaded.position.grants.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-5 text-stone-600">
                עוד לא נרשמה אף הקצאה. הקצאה נרשמת מהמסמך עצמו — מזהה, תאריך ומספר מניות — וההבשלות
                נרשמות תחתיה.
              </p>
            ) : (
              <ul className="space-y-4">
                {loaded.position.grants.map((reading) => (
                  <li key={reading.grant.id}>
                    <GrantCard
                      reading={reading}
                      position={loaded.position}
                      records={loaded.records}
                      window={loaded.window}
                      today={today}
                    />
                  </li>
                ))}
              </ul>
            )}

            <NewGrantPanel people={loaded.people} today={today} />
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
  | {
      kind: "ok";
      person: Person | null;
      people: readonly Person[];
      records: RsuRecords;
      position: RsuPosition;
      window: GpWindow;
    }
  | { kind: "unavailable"; reason: string };

async function loadPage(email: string, asOf: ReturnType<typeof dateOf>): Promise<Loaded> {
  try {
    const [person, people, records, settings] = await Promise.all([
      findPersonByEmail(email),
      listPeople(),
      loadRsuRecords(),
      loadHouseholdSettings(),
    ]);

    return {
      kind: "ok",
      person,
      people,
      records,
      position: readPosition({ ...records, asOf }),
      window: settings.gpWindow,
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the reading date --------------------------------------------------------

/**
 * The day the position is read as of. A control rather than a fixed "today"
 * because qualification is a fact about a date: the household asking "where will
 * this lot stand in March" is the same question the screen already answers, one
 * date over.
 */
function AsOfControl({ asOf, today }: { asOf: ReturnType<typeof dateOf>; today: ReturnType<typeof dateOf> }) {
  const isToday = dateKey(asOf) === dateKey(today);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5">
      <form method="get" className="flex flex-wrap items-end gap-4">
        <Field label="נקרא נכון לתאריך" note="שעון סעיף 102 נגזר מהתאריך הזה בכל קריאה">
          <input
            type="date"
            name="asOf"
            defaultValue={dateKey(asOf)}
            className="rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>
        <SubmitButton label="קריאה" subtle />
        {isToday ? null : (
          <p className="text-sm text-amber-800">
            המצב נקרא נכון ל־{formatDate(asOf)} ולא להיום.{" "}
            <Link href="/rsu" className="underline underline-offset-4">
              חזרה להיום
            </Link>
          </p>
        )}
      </form>
    </section>
  );
}

// --- the position ------------------------------------------------------------

function PositionPanel({ position, window }: { position: RsuPosition; window: GpWindow }) {
  const next = nextQualificationDate(position);

  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">המצב נכון ל־{formatDate(position.asOf)}</h2>

      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <Figure
          label="מניות אחרי התקופה"
          value={<Shares count={position.qualifiedShares} />}
          note={`עברו 24 חודשים · שווי בהבשלה ${format(position.qualifiedValueAtVest)}`}
        />
        <Figure
          label="מניות לפני התקופה"
          value={<Shares count={position.unqualifiedShares} />}
          note={`חשופות לשיעור של 62.17% · שווי בהבשלה ${format(position.unqualifiedValueAtVest)}`}
        />
        <Figure
          label="סך המוחזק"
          value={<Shares count={position.remainingShares} />}
          note={`${position.soldShares} מניות נמכרו`}
          emphasis
        />
      </dl>

      <p className="mt-4 text-sm text-stone-600">
        {position.futureShares === 0 ? (
          "אין הבשלות עתידיות רשומות."
        ) : (
          <>
            <Shares count={position.futureShares} /> מניות בהבשלות שתאריכן טרם הגיע — רשומות, ואינן
            נספרות באף אחד מהמספרים שלמעלה.
          </>
        )}{" "}
        {next === null
          ? "כל מה שמוחזק כבר עבר את התקופה."
          : `המנה הבאה עוברת את התקופה ב־${formatDate(next)}.`}
      </p>

      <p className="mt-2 text-xs text-stone-500">
        חלון ה־GP המוגדר כעת: {windowInWords(window)}.{" "}
        <Link href="/settings" className="underline underline-offset-4">
          שינוי בהגדרות
        </Link>
      </p>
    </section>
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

// --- one grant ---------------------------------------------------------------

function GrantCard({
  reading,
  position,
  records,
  window,
  today,
}: {
  reading: GrantReading;
  position: RsuPosition;
  records: RsuRecords;
  window: GpWindow;
  today: ReturnType<typeof dateOf>;
}) {
  const { grant } = reading;
  const lots = position.lots.filter((lot) => lot.grant.id === grant.id);
  const future = position.future.filter((entry) => entry.grant.id === grant.id);
  const qualifiedFrom = lots[0]?.qualifiedFrom ?? future[0]?.qualifiedFrom ?? null;

  return (
    <article className="rounded-lg border border-stone-300 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          <bdi>{grant.reference}</bdi>
        </h2>
        <p className="text-sm text-stone-500">
          הוקצתה ב־{formatDate(grant.grantedOn)} · <Shares count={grant.totalShares} /> מניות
          {qualifiedFrom === null ? null : <> · עוברת את התקופה ב־{formatDate(qualifiedFrom)}</>}
        </p>
      </div>

      <p className="mt-3 text-sm text-stone-600">
        <span className="text-stone-500">GP: </span>
        <GrantPriceFigure grantPrice={grant.grantPrice} window={window} />
      </p>

      {reading.unscheduledShares === 0 ? null : (
        <p className="mt-2 text-xs text-stone-500">
          <Shares count={reading.unscheduledShares} /> מניות מההקצאה עדיין ללא שורת הבשלה.
        </p>
      )}

      <LotsTable lots={lots} sales={records.sales} today={today} />

      {future.length === 0 ? null : (
        <div className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-stone-500">הבשלות עתידיות</h3>
          <ul className="mt-2 space-y-1 text-sm text-stone-600">
            {future.map((entry) => (
              <li key={entry.vest.id} className="flex flex-wrap items-baseline gap-x-3">
                <span>{formatDate(entry.vest.vestedOn)}</span>
                <span>
                  <Shares count={entry.vest.shares} /> מניות
                </span>
                <span className="text-stone-500">
                  <bdi>{formatSharePrice(entry.vest.priceAtVest)}</bdi> למניה
                </span>
                <span className="text-xs text-stone-500">אינה נספרת במצב</span>
                <form action={removeVest}>
                  <input type="hidden" name="vestId" value={entry.vest.id} />
                  <button type="submit" className="text-xs text-stone-500 underline underline-offset-4">
                    הסרה
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium text-stone-700">
          רישום הבשלה, מכירה או GP
        </summary>

        <div className="mt-4 space-y-5 border-t border-stone-200 pt-4">
          <form action={addVest} className="grid gap-3 sm:grid-cols-4">
            <input type="hidden" name="grantId" value={grant.id} />
            <Field label="תאריך הבשלה">
              <input
                type="date"
                name="vestedOn"
                defaultValue={dateKey(today)}
                required
                className="w-full rounded-md border border-stone-300 px-3 py-2"
              />
            </Field>
            <Field label="מניות">
              <input
                name="shares"
                inputMode="numeric"
                dir="ltr"
                required
                className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
              />
            </Field>
            <Field label="מחיר בהבשלה" note="דולרים למניה">
              <input
                name="price"
                inputMode="decimal"
                dir="ltr"
                required
                className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
              />
            </Field>
            <div className="flex items-end">
              <SubmitButton label="רישום הבשלה" subtle />
            </div>
          </form>

          <form action={stateGrantPrice} className="grid gap-3 sm:grid-cols-4">
            <input type="hidden" name="grantId" value={grant.id} />
            <Field label="GP מהמסמך" note="עובדה — נרשמת בלי חלון ובלי אומדן">
              <input
                name="grantPrice"
                inputMode="decimal"
                dir="ltr"
                defaultValue={
                  grant.grantPrice !== null && grant.grantPrice.source === "stated"
                    ? sharePriceToDecimalString(grant.grantPrice.price)
                    : ""
                }
                className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
              />
            </Field>
            <div className="flex items-end sm:col-span-3">
              <SubmitButton label="שמירת GP מהמסמך" subtle />
            </div>
          </form>

          <form action={estimateGrantPriceFromCloses} className="space-y-3">
            <input type="hidden" name="grantId" value={grant.id} />
            <Field
              label="אומדן GP מסגירות שוק"
              note={`שורה לכל יום: YYYY-MM-DD ומחיר. ייבחרו מתוכן ${windowInWords(window)}`}
            >
              <textarea
                name="closes"
                rows={4}
                dir="ltr"
                placeholder={"2026-06-08 212.50\n2026-06-09 213.75"}
                className="tabular w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-sm"
              />
            </Field>
            <SubmitButton label="חישוב אומדן" subtle />
          </form>

          <form action={removeGrant}>
            <input type="hidden" name="grantId" value={grant.id} />
            <button type="submit" className="text-sm text-red-800 underline underline-offset-4">
              הסרת ההקצאה על כל ההבשלות והמכירות שתחתיה
            </button>
          </form>
        </div>
      </details>
    </article>
  );
}

// --- the lots ----------------------------------------------------------------

function LotsTable({
  lots,
  sales,
  today,
}: {
  lots: readonly Lot[];
  sales: readonly Sale[];
  today: ReturnType<typeof dateOf>;
}) {
  if (lots.length === 0) {
    return <p className="mt-3 text-sm text-stone-500">אין עדיין מנות שהבשילו תחת ההקצאה הזאת.</p>;
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-stone-300 text-start text-xs text-stone-500">
            <th className="py-2 text-start font-medium">הבשלה</th>
            <th className="py-2 text-start font-medium">מניות</th>
            <th className="py-2 text-start font-medium">מחיר בהבשלה</th>
            <th className="py-2 text-start font-medium">מעמד</th>
            <th className="py-2 text-start font-medium">מכירה</th>
          </tr>
        </thead>
        <tbody>
          {lots.map((lot) => (
            <LotRow key={lot.vest.id} lot={lot} sales={salesOf(sales, lot.vest.id)} today={today} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LotRow({ lot, sales, today }: { lot: Lot; sales: readonly Sale[]; today: ReturnType<typeof dateOf> }) {
  return (
    <tr className="border-b border-stone-200 align-top">
      <td className="py-3">
        <bdi>{formatDate(lot.vest.vestedOn)}</bdi>
      </td>
      <td className="py-3">
        <Shares count={lot.remainingShares} />
        {lot.soldShares === 0 ? null : (
          <span className="block text-xs text-stone-500">
            מתוך <Shares count={lot.vest.shares} />, <Shares count={lot.soldShares} /> נמכרו
          </span>
        )}
      </td>
      <td className="tabular py-3">
        <bdi>{formatSharePrice(lot.vest.priceAtVest)}</bdi>
        <span className="block text-xs text-stone-500">
          <bdi>{format(lot.remainingValueAtVest)}</bdi>
        </span>
      </td>
      <td className="py-3">
        {lot.qualified ? (
          <span className="rounded-sm border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-900">
            אחרי התקופה
          </span>
        ) : (
          <span className="rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900">
            לפני התקופה
          </span>
        )}
        <span className="mt-1 block text-xs text-stone-500">
          {lot.qualified ? "עברה ב־" : "תעבור ב־"}
          {formatDate(lot.qualifiedFrom)}
        </span>
      </td>
      <td className="py-3">
        {lot.remainingShares === 0 ? (
          <span className="text-xs text-stone-500">המנה נמכרה כולה</span>
        ) : (
          <form action={recordSale} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="vestId" value={lot.vest.id} />
            <input
              type="date"
              name="soldOn"
              defaultValue={dateKey(today)}
              required
              className="rounded-md border border-stone-300 px-2 py-1 text-xs"
            />
            <input
              name="shares"
              inputMode="numeric"
              dir="ltr"
              required
              placeholder="מניות"
              className="tabular w-20 rounded-md border border-stone-300 px-2 py-1 text-end text-xs"
            />
            <input
              name="price"
              inputMode="decimal"
              dir="ltr"
              required
              placeholder="מחיר"
              className="tabular w-24 rounded-md border border-stone-300 px-2 py-1 text-end text-xs"
            />
            <button
              type="submit"
              className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium hover:bg-stone-50"
            >
              מכירה
            </button>
          </form>
        )}

        {sales.length === 0 ? null : (
          <ul className="mt-2 space-y-1 text-xs text-stone-500">
            {sales.map((sale) => (
              <li key={sale.id} className="flex flex-wrap items-baseline gap-x-2">
                <bdi>{formatDate(sale.soldOn)}</bdi>
                <span>
                  <Shares count={sale.shares} /> @ <bdi>{formatSharePrice(sale.price)}</bdi>
                </span>
                <form action={removeSale}>
                  <input type="hidden" name="saleId" value={sale.id} />
                  <button type="submit" className="underline underline-offset-4">
                    ביטול
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

// --- a new grant -------------------------------------------------------------

function NewGrantPanel({
  people,
  today,
}: {
  people: readonly Person[];
  today: ReturnType<typeof dateOf>;
}) {
  return (
    <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
      <h2 className="text-sm font-semibold tracking-wide text-stone-500">הקצאה חדשה</h2>
      <p className="mt-1 text-sm text-stone-600">
        נרשמת מהמסמך עצמו. מזהה ההקצאה נשמר כפי שהוא כתוב, באנגלית. אם המסמך נוקב ב־GP, זו עובדה
        וניתן לרשום אותה כאן; אחרת היא נאמדת מסגירות שוק ומסומנת כאומדן.
      </p>

      <form action={createGrant} className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="מזהה ההקצאה" note="כפי שכתוב במסמך">
          <input
            name="reference"
            required
            maxLength={40}
            dir="ltr"
            placeholder="RSU-2026-001"
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="למי">
          <Select name="personId" defaultValue={people[0]?.id ?? ""}>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="תאריך ההקצאה" note="ממנו נמדדות 24 החודשים של סעיף 102">
          <input
            type="date"
            name="grantedOn"
            defaultValue={dateKey(today)}
            required
            className="w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </Field>

        <Field label="סך המניות">
          <input
            name="totalShares"
            inputMode="numeric"
            dir="ltr"
            required
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>

        <Field label="GP מהמסמך" note="אופציונלי — ריק פירושו שאיש לא נקב בו">
          <input
            name="grantPrice"
            inputMode="decimal"
            dir="ltr"
            className="tabular w-full rounded-md border border-stone-300 px-3 py-2 text-end"
          />
        </Field>

        <div className="flex items-end sm:col-span-2">
          <SubmitButton label="יצירת הקצאה" />
        </div>
      </form>
    </section>
  );
}
