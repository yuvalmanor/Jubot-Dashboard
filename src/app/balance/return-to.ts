import { redirect } from "next/navigation";

/**
 * Where a write on `/balance` comes back to.
 *
 * Everything the reader has chosen about the screen — the year, whose money, the
 * row order, whether the household rows are opened, whether the category panel is
 * open — is a query parameter, so a write can carry it through and land on the
 * exact view it was made from. Both the grid's writes and the category panel's go
 * through here, because a rename that dropped the reader back on this year's
 * משותף grid with the panel shut would look like the screen had been reset.
 */

export interface ReturnTo {
  readonly year: string;
  readonly view: string;
  readonly sort: string;
  readonly expand: string;
  /** `"1"` while the category panel below the grid is open. */
  readonly admin: string;
}

const FIELDS: readonly (keyof ReturnTo)[] = ["year", "view", "sort", "expand", "admin"];

export function returnToFrom(form: FormData): ReturnTo {
  const read = (field: string) => {
    const value = form.get(field);
    return typeof value === "string" ? value : "";
  };
  return { year: read("year"), view: read("view"), sort: read("sort"), expand: read("expand"), admin: read("admin") };
}

/**
 * Back to the grid, carrying the view and whatever the write has to say about
 * itself. Notices are query parameters too: the page is a server component with
 * no state to hold a message in, and a message in the URL is one a person can
 * send to the other.
 */
export function backToGrid(returnTo: ReturnTo, notices: Readonly<Record<string, string>>): never {
  const params = new URLSearchParams();
  for (const field of FIELDS) {
    const value = returnTo[field];
    if (value.length > 0) params.set(field, value);
  }
  for (const [key, value] of Object.entries(notices)) {
    if (value.length > 0) params.set(key, value);
  }
  const query = params.toString();
  redirect(query.length === 0 ? "/balance" : `/balance?${query}`);
}
