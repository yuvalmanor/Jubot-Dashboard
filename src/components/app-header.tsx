import type { Route } from "next";
import Link from "next/link";

import { signOut } from "@/auth";

/**
 * The signed-in shell. Every screen carries the same header, so which of the two
 * People is signed in is never a question.
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
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-stone-300 pb-5">
      <div>
        {back === undefined ? null : (
          <Link href={back.href} className="text-sm text-stone-500 underline-offset-4 hover:underline">
            <span aria-hidden="true">→ </span>
            {back.label}
          </Link>
        )}
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        <p className="text-sm text-stone-600">{subtitle}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-stone-600">
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
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          >
            התנתקות
          </button>
        </form>
      </div>
    </header>
  );
}
