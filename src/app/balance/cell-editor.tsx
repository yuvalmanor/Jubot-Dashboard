"use client";

import { useState, useTransition } from "react";

import { saveCell } from "./actions";

/**
 * One cell of the grid, opened where it sits.
 *
 * Filling a hole used to cost two round trips: a click navigated to the same
 * screen with `?cell=…` on it so the server could render an input, and only then
 * could a figure be typed. On a year of three hundred cells that is a page load
 * to put a cursor in a box — and it dropped a `#open-cell` fragment in the URL,
 * which meant the address of the screen changed every time somebody looked at a
 * number without changing it.
 *
 * The cell is its own editor now. A click opens the field, Escape closes it
 * untouched, and Enter writes — one trip, through the very same server action
 * the typed form always used. Nothing about the write changed: a blank still
 * clears the figure back to *not recorded*, which is not a zero.
 *
 * The anchor underneath is the whole no-script path, kept rather than described:
 * with no JavaScript the click is not intercepted, the link opens the cell on the
 * server exactly as before, and the form rendered there still saves. This
 * component is an enhancement over a screen that works without it.
 */

export function CellEditor({
  href,
  fields,
  label,
  defaultValue,
  children,
}: {
  /** The server-rendered open-this-cell URL — the path taken when scripts do not run. */
  href: string;
  /** Everything `saveCell` needs, including the view to come back to. */
  fields: Readonly<Record<string, string>>;
  /** The row and the month, so an opened field says what it is a figure for. */
  label: string;
  /** The recorded figure as a decimal, or empty for a month never recorded. */
  defaultValue: string;
  /** The figure as the table draws it, deviation mark and all. */
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, startSaving] = useTransition();

  if (!editing) {
    return (
      <a
        href={href}
        onClick={(event) => {
          // A modified click is somebody opening the year in another tab, and
          // that has to keep working.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setEditing(true);
        }}
        className="block cursor-text rounded-sm hover:bg-stone-900/5"
      >
        {children}
      </a>
    );
  }

  return (
    <form
      action={saveCell}
      onSubmit={(event) => {
        // The write still goes through the very same server action; running it
        // inside a transition is only what lets the button say it is working.
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startSaving(async () => {
          try {
            await saveCell(data);
          } finally {
            // The action comes back to this very view, so the cell is still
            // mounted and would otherwise sit there as an open field with the
            // figure it just wrote hidden behind it.
            setEditing(false);
          }
        });
      }}
      className="flex flex-col items-stretch gap-1"
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <input
        name="amount"
        type="text"
        inputMode="decimal"
        dir="ltr"
        autoComplete="off"
        autoFocus
        aria-label={label}
        placeholder="—"
        defaultValue={defaultValue}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
        }}
        className="tabular w-full rounded bg-sunken px-1 py-0.5 text-left text-xs outline-offset-1"
      />

      <div className="flex items-center justify-between gap-1">
        {/* Says it is writing. A grid of cells that all look idle during a save
            is a grid people press twice. */}
        <button
          type="submit"
          disabled={saving}
          className="rounded-sm bg-stone-900 px-1.5 py-0.5 text-[0.65rem] font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-50"
        >
          {saving ? "שומר…" : "שמירה"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="text-[0.65rem] text-stone-500 hover:underline"
        >
          ביטול
        </button>
      </div>
    </form>
  );
}
