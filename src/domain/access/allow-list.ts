/**
 * Access — the two-account allow-list.
 *
 * Framework-free per ADR 0004. There are no roles and no permissions: an address
 * is either one of the household's two, or it gets nothing. The list is data, so
 * the decision is testable without an OAuth round trip.
 */

/** Parse a configured list, e.g. "yuval@example.com, eden@example.com". */
export function parseAllowList(configured: string | undefined | null): readonly string[] {
  if (!configured) return [];
  return configured
    .split(",")
    .map(normaliseEmail)
    .filter((entry) => entry.length > 0);
}

/**
 * Fails closed: an unset list admits nobody, a missing address is refused, and
 * matching is exact apart from case and surrounding whitespace. No wildcards, no
 * domain matching — the household is two named addresses.
 */
export function isAllowed(email: string | undefined | null, allowList: readonly string[]): boolean {
  if (!email) return false;
  const candidate = normaliseEmail(email);
  if (candidate.length === 0) return false;
  return allowList.some((entry) => normaliseEmail(entry) === candidate);
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
