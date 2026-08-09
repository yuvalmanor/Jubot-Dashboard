# Framework-free domain modules on a zero-cost stack

Jubot runs on Next.js and Postgres deployed to Vercel, authenticated with Google OAuth
restricted to two accounts. The binding constraint is cost: this serves two people and
should stay on free tiers indefinitely. That is why auth uses OAuth rather than magic links
— magic links would require a paid or rate-limited email service to do nothing that Google
already does for free.

The less obvious decision is that the domain modules — Money, Categories, Ledger,
LedgerAnalytics, Snapshot, NetWorthAnalytics, Projects, RsuPosition, RsuTax, LotSelector,
Scenarios, AnnualReview — import nothing from Next.js, React, or the database client. They
take plain data and return plain data. Persistence and rendering wrap them from outside.

This looks like indirection in a two-person app, and someone will eventually be tempted to
collapse it into server actions that query and compute in one place. The reason not to:
almost all the difficult logic here is arithmetic about money, tax and time, and it is worth
far more as something that can be tested exhaustively in milliseconds without a database, a
browser or a network. The RSU tax engine alone has two treatments, a date-driven
qualification boundary and an optimiser over it. Coupling that to a request lifecycle would
make it expensive to test and effectively impossible to verify against the household's
existing spreadsheet figures.

## Consequences

Data access happens at the edges. A module never fetches what it needs; it is handed
everything, which makes some call sites more verbose than a direct query would be. That
verbosity is the price of the test suite, and it is worth paying.

If the frontend choice turns out wrong, the domain layer moves without rewriting.
