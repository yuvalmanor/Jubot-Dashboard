import type { Person } from "@/db/people";
import { type HouseholdCategoryLine, type MonthSummary } from "@/domain/ledger/ledger";
import { type Money, format } from "@/domain/money/money";

/**
 * Reading a month: the summary that heads every view, and the משותף reading, which
 * is the one view of the three with nothing writable in it.
 *
 * The household panel takes `HouseholdCategoryLine`s straight from the domain,
 * where each line already carries the personal categories that produced it. The
 * screen never adds anything up itself, so a household figure and its drill-down
 * cannot disagree — and there is no input anywhere on it, because there is no
 * household ledger to write to.
 */

export function SummaryPanel({ summary, note }: { summary: MonthSummary; note: string }) {
  return (
    <section className="rounded-card bg-surface shadow-card p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label="הכנסות" value={format(summary.income)} />
        <Figure label="הוצאות" value={format(summary.expenses)} />
        <Figure label="חיסכון" value={format(summary.saving)} emphasis />
      </div>

      <p className="mt-4 text-sm text-stone-500">{note}</p>
    </section>
  );
}

function Figure({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <p className="text-[13px] font-medium text-stone-500">{label}</p>
      <bdi className={`tabular block ${emphasis ? "text-3xl font-semibold" : "text-2xl"}`}>{value}</bdi>
    </div>
  );
}

/**
 * The household's month. Every line opens onto the personal categories beneath
 * it, with each person's own name for the spend and each person's own figure.
 */
export function HouseholdReadingTable({
  title,
  lines,
  total,
  people,
}: {
  title: string;
  lines: readonly HouseholdCategoryLine[];
  total: Money;
  people: readonly Person[];
}) {
  if (lines.length === 0) return null;

  const nameOf = (personId: string) =>
    people.find((person) => person.id === personId)?.displayName ?? personId;

  return (
    <section className="rounded-card bg-surface shadow-card">
      <h3 className="border-b border-line px-5 py-3 text-[13px] font-medium text-stone-500">
        {title}
      </h3>

      <ul className="divide-y divide-line">
        {lines.map((line) => (
          <li key={line.household.id}>
            <details className="group">
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className="min-w-0 flex-1 font-medium">
                  <span aria-hidden="true" className="text-stone-400 group-open:hidden">
                    ▸{" "}
                  </span>
                  <span aria-hidden="true" className="hidden text-stone-400 group-open:inline">
                    ▾{" "}
                  </span>
                  <bdi>{line.household.name}</bdi>
                </span>
                <bdi className="tabular font-medium">{format(line.amount)}</bdi>
                <span className="w-full text-xs text-stone-500 sm:w-auto sm:min-w-24 sm:text-end">
                  <bdi className="tabular">{line.recordedCount}</bdi>/
                  <bdi className="tabular">{line.categoryCount}</bdi> נרשמו
                </span>
              </summary>

              <ul className="divide-y divide-line border-t border-stone-100 bg-sunken/70">
                {line.contributions.map((contribution) => (
                  <li
                    key={contribution.category.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 ps-9"
                  >
                    <span className="min-w-0 flex-1 text-sm">
                      <bdi>{contribution.category.name}</bdi>
                      <span className="text-stone-500"> · {nameOf(contribution.category.personId)}</span>
                    </span>
                    <bdi className="tabular text-sm">
                      {contribution.reading === null ? (
                        <span className="text-stone-400">לא נרשם</span>
                      ) : (
                        format(contribution.reading.amount)
                      )}
                    </bdi>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>

      <p className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
        <span className="font-semibold text-stone-500">סה״כ</span>
        <bdi className="tabular font-semibold">{format(total)}</bdi>
      </p>
    </section>
  );
}

