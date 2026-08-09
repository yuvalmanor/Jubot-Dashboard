# Monthly category amounts are the stored unit, with optional transaction backing

The household currently enters income and expenses by hand as ~20 monthly category totals
per person, copied from RiseUp. Whether to keep doing that, harvest RiseUp automatically,
or connect directly to banks and cards is an open question we deliberately have not
answered yet.

So the stored unit is `(month, personal category, amount)` — the thing that exists today —
but a month may optionally be backed by a set of dated transactions, and when those exist
the monthly amount is derived from them rather than entered. This lets automated import
arrive later, one month or one category at a time, without a schema migration or a rewrite,
and without blocking the project on an import decision we are not ready to make.

## Consequences

There are two code paths for "what is this month's amount for this category" — entered and
derived. Any code reading amounts must go through a single accessor that hides which one
applies, or the two will diverge.

A month must not be partially backed: either a category-month's amount is entered, or it is
derived from transactions. Mixing both within one category-month is not supported, because
there is no non-arbitrary way to reconcile them.
