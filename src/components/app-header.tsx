import type { Route } from "next";
import Link from "next/link";

import { signOut } from "@/auth";

/**
 * The signed-in shell. Every screen carries the same header, so which of the two
 * People is signed in is never a question.
 *
 * No rule under it: the gap to the first card is what separates them, and a line
 * drawn where space already says the same thing is ink for nothing.
 */

export interface HeaderPerson {
  readonly displayName: string;
}

export function AppHeader({
  email,
  person,
  title,
  subtitle,
  back,
}: {
  email: string | null | undefined;
  person: HeaderPerson | null;
  title: string;
  subtitle: string;
  back?: { href: Route; label: string };
}) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {back === undefined ? null : (
          <Link
            href={back.href}
            className="text-[13px] text-stone-500 transition-colors hover:text-stone-900"
          >
            <span aria-hidden="true">→ </span>
            {back.label}
          </Link>
        )}
        <h1 className="title mt-0.5 text-[26px] font-semibold sm:text-[32px]">{title}</h1>
        <p className="mt-0.5 text-sm text-stone-500">{subtitle}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-stone-500">
          {person === null ? <bdi className="break-all">{email}</bdi> : person.displayName}
        </span>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button
            type="submit"
            className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-stone-600 transition-colors hover:bg-stone-900/5 hover:text-stone-900"
          >
            התנתקות
          </button>
        </form>
      </div>
    </header>
  );
}
