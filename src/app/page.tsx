import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { MoneyFigure } from "@/components/money-figure";
import { DatabaseNotConfiguredError } from "@/db/client";
import { type DatedRate, type StoredAmount, findLatestRate, findStoredAmount } from "@/db/money-settings";
import { findPersonByEmail } from "@/db/people";
import { requireHouseholdEmail } from "@/session";

// Reads a live database on every request; nothing here is prerendered at build.
export const dynamic = "force-dynamic";

/** The areas this shell will grow into. Listed so the shape is visible from day one. */
const AREAS = [
  { title: "מאזן הכנסות-הוצאות", note: "רישום חודשי, קטגוריות, מגמות", href: "/balance" },
  { title: "מיפוי", note: "צילום מלא של כל החשבונות", href: "/snapshots" },
  { title: "שווי נטו", note: "מסלול, חשיפה למט״ח, הקצאה", href: "/net-worth" },
  { title: "נכסים ופרוייקטים", note: "רגלי מימון, הוצאות, יתרה", href: null },
  { title: "מחשבון RSU", note: "מניות לפני ואחרי התקופה, מס", href: null },
  { title: "לוח תכנון", note: "תרחישים ותוכניות מימון", href: null },
  { title: "סיכום שנתי", note: "היכן הסתיימה השנה", href: null },
  { title: "הגדרות", note: "הנחות ויעדים של משק הבית", href: "/settings" },
] as const;

export default async function DashboardPage() {
  const email = await requireHouseholdEmail();
  const person = await findPersonByEmail(email).catch(() => null);

  const tracer = await readTracerAmount();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <AppHeader
        email={email}
        person={person}
        title="Jubot"
        subtitle="לוח מחוונים פיננסי של משק הבית"
      />

      <main className="mt-6 space-y-6 sm:mt-8">
        <section className="rounded-lg border border-stone-300 bg-white p-5 sm:p-6">
          <h2 className="text-sm font-semibold tracking-wide text-stone-500">סכום לדוגמה מהמסד</h2>

          {tracer.kind === "ok" ? (
            <div className="mt-3">
              <p className="text-base font-medium text-stone-700">{tracer.amount.labelHe}</p>
              <div className="mt-2">
                <MoneyFigure amount={tracer.amount.amount} rate={tracer.rate} />
              </div>
              <p className="mt-4 text-sm text-stone-500">
                נשמר כ־
                <bdi className="tabular">{tracer.amount.amount.minorUnits.toLocaleString("he-IL")}</bdi>{" "}
                יחידות מִשְׁנֶה שלמות עם קוד מטבע <bdi>{tracer.amount.amount.currency}</bdi>
              </p>
            </div>
          ) : (
            <UnavailablePanel reason={tracer.reason} />
          )}
        </section>

        <section aria-labelledby="areas-heading">
          <h2 id="areas-heading" className="text-sm font-semibold tracking-wide text-stone-500">
            אזורים
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {AREAS.map((area) =>
              area.href === null ? (
                <li
                  key={area.title}
                  className="rounded-lg border border-dashed border-stone-300 bg-white/60 p-4"
                >
                  <p className="font-medium text-stone-700">{area.title}</p>
                  <p className="mt-1 text-sm text-stone-500">{area.note}</p>
                  <p className="mt-2 text-xs font-medium tracking-wide text-stone-400">בקרוב</p>
                </li>
              ) : (
                <li key={area.title}>
                  <Link
                    href={area.href}
                    className="block h-full rounded-lg border border-stone-300 bg-white p-4 hover:bg-stone-50"
                  >
                    <p className="font-medium text-stone-900">{area.title}</p>
                    <p className="mt-1 text-sm text-stone-500">{area.note}</p>
                    <p className="mt-2 text-xs font-medium tracking-wide text-stone-600">פתיחה ←</p>
                  </Link>
                </li>
              ),
            )}
          </ul>
        </section>
      </main>
    </div>
  );
}

function UnavailablePanel({ reason }: { reason: string }) {
  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">לא ניתן לקרוא את הסכום מהמסד</p>
      <p className="mt-1 text-sm text-amber-800">{reason}</p>
    </div>
  );
}

type TracerRead =
  | { kind: "ok"; amount: StoredAmount; rate: DatedRate | null }
  | { kind: "unavailable"; reason: string };

async function readTracerAmount(): Promise<TracerRead> {
  try {
    const amount = await findStoredAmount("cgm1_usd_funding_leg");
    if (amount === null) {
      return { kind: "unavailable", reason: "המסד מחובר אך אין בו שורה בשם cgm1_usd_funding_leg. יש להריץ את db/seed.sql." };
    }
    const rate = amount.amount.currency === "ILS" ? null : await findLatestRate(amount.amount.currency, "ILS");
    return { kind: "ok", amount, rate };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "unavailable", reason: "משתנה הסביבה DATABASE_URL אינו מוגדר." };
    }
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
