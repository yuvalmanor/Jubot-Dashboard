-- Jubot schema.
--
-- Amounts are integer minor units with an explicit currency code. Never a float,
-- never a bare number. `numeric` is deliberately not used for money: the domain
-- owns the arithmetic (see src/domain/money), and the database's job is to hand
-- back exactly what was stored.

create table if not exists money_settings (
  key          text        primary key,
  label_he     text        not null,
  amount_minor bigint      not null,
  currency     text        not null check (char_length(currency) = 3),
  updated_at   timestamptz not null default now()
);

comment on column money_settings.amount_minor is
  'Integer minor units (agorot / cents). Meaningless without the currency column.';

-- The household's own dials: the appreciation assumption, the רצוי allocation
-- targets, and which accounts a concentration is watched on. Later phases add the
-- GP window, fee rates and tax rates here.
--
-- Every value is text and every one of them is parsed and validated by a domain
-- module before anything reads it (see src/db/settings.ts). A setting is a number
-- somebody chose, so it must be changeable without a deploy — a rate that can only
-- move by shipping code becomes a constant by accident, and then a fact.
create table if not exists settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

-- Rates are dated because a converted figure must always be reproducible. A
-- historical reading never re-converts at today's rate.
create table if not exists fx_rates (
  base       char(3)        not null,
  quote      char(3)        not null,
  rate       numeric(18, 6) not null check (rate > 0),
  as_of      date           not null,
  primary key (base, quote, as_of)
);

-- --------------------------------------------------------------------------
-- מאזן הכנסות-הוצאות
-- --------------------------------------------------------------------------

-- Exactly two rows, ever. `email` is what links a Google sign-in to a Person; it
-- must hold the two real addresses on a deployed instance (see README).
create table if not exists people (
  id           text primary key,
  display_name text not null,
  email        text not null unique
);

-- A Household Category has its own name, independent of the personal names
-- feeding it. It has no amounts: it is the sum of its Personal Categories.
create table if not exists household_categories (
  id   uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('income', 'expense')),
  unique (name, type),
  -- Referenced by category_assignments so an assignment cannot join a הכנסה to
  -- a הוצאה. The type is part of the key, not merely checked alongside it.
  unique (id, type)
);

-- Owned by exactly one Person, using that Person's own naming. Retirement is a
-- lifespan (active_until), never a delete — history must keep resolving.
create table if not exists personal_categories (
  id           uuid primary key default gen_random_uuid(),
  person_id    text not null references people (id),
  name         text not null,
  type         text not null check (type in ('income', 'expense')),
  active_from  date not null,
  active_until date,
  check (active_until is null or active_until >= active_from),
  unique (person_id, name),
  unique (id, type)
);

-- Many Personal Categories to one Household Category. The primary key is what
-- makes it "at most one"; the deferred trigger below is what makes it "exactly
-- one" — no personal category may be unassigned in any committed state.
create table if not exists category_assignments (
  personal_category_id  uuid not null primary key,
  household_category_id uuid not null,
  type                  text not null check (type in ('income', 'expense')),
  foreign key (personal_category_id, type)
    references personal_categories (id, type) on delete cascade,
  foreign key (household_category_id, type)
    references household_categories (id, type)
);

create index if not exists category_assignments_household_idx
  on category_assignments (household_category_id);

create or replace function jubot_personal_category_is_assigned() returns trigger as $fn$
begin
  if exists (select 1 from personal_categories where id = new.id)
     and not exists (select 1 from category_assignments where personal_category_id = new.id)
  then
    raise exception 'personal category % has no household category', new.id
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$fn$ language plpgsql;

create or replace function jubot_assignment_removal_leaves_none() returns trigger as $fn$
begin
  if exists (select 1 from personal_categories where id = old.personal_category_id)
     and not exists (select 1 from category_assignments where personal_category_id = old.personal_category_id)
  then
    raise exception 'personal category % was left with no household category', old.personal_category_id
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$fn$ language plpgsql;

-- Deferred to commit, so a category and its assignment can be written in either
-- order inside one transaction — but never land apart.
do $do$
begin
  if not exists (select 1 from pg_trigger where tgname = 'personal_category_must_be_assigned') then
    create constraint trigger personal_category_must_be_assigned
      after insert on personal_categories
      deferrable initially deferred
      for each row execute function jubot_personal_category_is_assigned();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'assignment_removal_must_reassign') then
    create constraint trigger assignment_removal_must_reassign
      after delete on category_assignments
      deferrable initially deferred
      for each row execute function jubot_assignment_removal_leaves_none();
  end if;
end;
$do$;

-- One amount for one Personal Category in one real calendar month. There are no
-- year boundaries: 2024-12 and 2025-01 are adjacent rows in one ledger.
--
-- ADR 0001: a category-month is either entered here or derived from dated
-- transactions, never both. Transactions have no producer yet; when they arrive
-- they get their own table and the accessor in src/domain/ledger hides which
-- applies. Nothing may write a row here for a month that has transactions.
create table if not exists entries (
  personal_category_id uuid        not null references personal_categories (id),
  year                 smallint    not null check (year between 2000 and 2100),
  month                smallint    not null check (month between 1 and 12),
  amount_minor         bigint      not null,
  currency             text        not null check (char_length(currency) = 3),
  updated_at           timestamptz not null default now(),
  primary key (personal_category_id, year, month)
);

comment on table entries is
  'The atomic record of the מאזן. A missing row is a month not recorded, which is '
  'not the same fact as a row holding zero.';

create index if not exists entries_month_idx on entries (year, month);

-- --------------------------------------------------------------------------
-- מיפוי
-- --------------------------------------------------------------------------

-- A single place value is held. Belongs to a Person, carries a native currency,
-- and must state how its value was arrived at — `value_basis` is `not null` with
-- no default, so an account whose provenance nobody chose cannot be written.
--
-- Closing is a lifespan (`closed_on`), never a delete: every snapshot the account
-- appears in must keep resolving.
create table if not exists accounts (
  id          uuid primary key default gen_random_uuid(),
  person_id   text not null references people (id),
  name        text not null,
  currency    text not null check (char_length(currency) = 3),
  value_basis text not null check (value_basis in ('market', 'cost', 'estimate')),
  category    text not null check (category in ('liquid', 'investments', 'pension', 'property')),
  asset_kind  text not null,
  opened_on   date not null,
  closed_on   date,
  check (closed_on is null or closed_on >= opened_on),
  unique (person_id, name),
  -- Referenced by earmarks, so a claim cannot be quoted in a currency the account
  -- is not held in. The currency is part of the key, not merely checked beside it.
  unique (id, currency)
);

-- For databases created before earmarks existed: the constraint above is what the
-- composite foreign key below needs, and `create table if not exists` will not add
-- it to a table that is already there.
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_id_currency_key') then
    alter table accounts add constraint accounts_id_currency_key unique (id, currency);
  end if;
end;
$do$;

comment on column accounts.category is
  'קטגוריה — the rollup bucket (נזילות / השקעות / פנסיה / נדל"ן). Closed, because a '
  'rollup over free text is one typo away from being wrong.';
comment on column accounts.asset_kind is
  'סוג נכס — the finer grouping, in the household''s own words.';

-- A complete dated restatement of every Account. `taken_on` is unique so "the
-- previous snapshot" is never ambiguous; there is no cadence beyond that.
--
-- `rsu_price_*` is the share price the reading was taken at, held here for exactly
-- the reason `snapshot_rates` holds the exchange rate: it is a dated fact about the
-- world, and the account it values must keep reading as it read on the day. The RSU
-- account's balance is derived from it and the position's own share count — never
-- typed — so the holding cannot be maintained in two places and drift, which is
-- what the sheet's hardcoded 3.602 did against מיפוי's live rate.
create table if not exists snapshots (
  id         uuid        primary key default gen_random_uuid(),
  taken_on   date        not null unique,
  note       text,
  rsu_price_ten_thousandths bigint check (rsu_price_ten_thousandths >= 0),
  rsu_price_currency        text   check (char_length(rsu_price_currency) = 3),
  created_at timestamptz not null default now(),
  -- The figure and its currency arrive together or not at all, as everywhere else.
  constraint snapshots_rsu_price_has_currency
    check ((rsu_price_ten_thousandths is null) = (rsu_price_currency is null))
);

-- The two columns above landed after the first snapshots were taken.
alter table snapshots add column if not exists rsu_price_ten_thousandths bigint;
alter table snapshots add column if not exists rsu_price_currency        text;

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'snapshots_rsu_price_has_currency'
  ) then
    alter table snapshots add constraint snapshots_rsu_price_has_currency
      check ((rsu_price_ten_thousandths is null) = (rsu_price_currency is null));
  end if;
end;
$do$;

comment on column snapshots.rsu_price_ten_thousandths is
  'The share price this reading was taken at, in integer ten-thousandths — the same '
  'scale a GP is held at, because cents cannot hold 149.4219. A dated fact, stored '
  'on the snapshot the way its exchange rate is, so re-reading it never re-prices.';

-- The snapshot's own rate. The primary key is what makes it exactly one per pair,
-- so every dollar figure inside one snapshot converts identically — and a
-- historical snapshot never re-converts at today's rate.
create table if not exists snapshot_rates (
  snapshot_id uuid           not null references snapshots (id) on delete cascade,
  base        char(3)        not null,
  quote       char(3)        not null,
  rate        numeric(18, 6) not null check (rate > 0),
  check (base <> quote),
  primary key (snapshot_id, base, quote)
);

-- One row per Account open on the snapshot's date. `source` says whether anyone
-- stated this figure at that date; `measured_on` says when it was last stated at
-- all, and is null for an account nobody has ever valued.
create table if not exists snapshot_lines (
  snapshot_id  uuid   not null references snapshots (id) on delete cascade,
  account_id   uuid   not null references accounts (id),
  amount_minor bigint not null,
  currency     text   not null check (char_length(currency) = 3),
  source       text   not null check (source in ('entered', 'carried')),
  measured_on  date,
  primary key (snapshot_id, account_id)
);

create index if not exists snapshot_lines_account_idx on snapshot_lines (account_id);

-- `source` and `measured_on` must agree, or a line could claim to be measured on
-- a day nobody measured it. The check needs the snapshot's own date, which a
-- column check cannot reach, so it is a trigger. The foreign key guarantees the
-- snapshot row already exists by the time this runs.
create or replace function jubot_snapshot_line_source_agrees() returns trigger as $fn$
declare
  snapshot_date date;
begin
  select taken_on into snapshot_date from snapshots where id = new.snapshot_id;

  if new.source = 'entered' and new.measured_on is distinct from snapshot_date then
    raise exception 'snapshot line % is entered but not measured on %', new.account_id, snapshot_date
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.source = 'carried' and new.measured_on is not null and new.measured_on >= snapshot_date then
    raise exception 'snapshot line % is carried but claims a measurement on %', new.account_id, new.measured_on
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$fn$ language plpgsql;

do $do$
begin
  if not exists (select 1 from pg_trigger where tgname = 'snapshot_line_source_must_agree') then
    create constraint trigger snapshot_line_source_must_agree
      after insert or update on snapshot_lines
      for each row execute function jubot_snapshot_line_source_agrees();
  end if;
end;
$do$;

-- --------------------------------------------------------------------------
-- החזקות וייעודים
-- --------------------------------------------------------------------------

-- החזקה — what an Account is invested in. There is deliberately no amount here:
-- how much an account holds is a fact with a date on it, and that is what a
-- snapshot line is. A figure stored beside one would drift from it exactly the
-- way the sheet's שקל table drifted from its דולר table.
create table if not exists positions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts (id),
  security_id text,
  name        text not null,
  unique (account_id, name)
);

comment on column positions.security_id is
  'The number the fund or exchange states — 1159235. Kept as written, in English.';

-- ייעוד — a claim on money inside an Account. The amount is fixed: spending does
-- not reduce a promise, it makes it underfunded, and that is the state worth
-- seeing. Releasing is a lifespan, never a delete, so a snapshot taken while the
-- claim stood keeps reading as it did.
--
-- The composite foreign key is what holds the claim in the account's own
-- currency. A claim needing a rate to compare against its backing would let a
-- rate move look like money being spent.
create table if not exists earmarks (
  id           uuid   primary key default gen_random_uuid(),
  account_id   uuid   not null,
  name         text   not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency     text   not null check (char_length(currency) = 3),
  declared_on  date   not null,
  released_on  date,
  check (released_on is null or released_on >= declared_on),
  unique (account_id, name),
  foreign key (account_id, currency) references accounts (id, currency)
);

create index if not exists earmarks_account_idx on earmarks (account_id);

-- --------------------------------------------------------------------------
-- נכסים ופרוייקטים
-- --------------------------------------------------------------------------

-- A closed pot of capital. `currency` is what the pot is denominated in — a pot
-- has one size, so it has one currency — and every leg and expense is read into
-- it. `account_id` names the מיפוי account that carries the project's value, so
-- the cost below can be read against what the snapshot actually records; per ADR
-- 0003 nothing here writes into that account.
create table if not exists projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  currency   text not null check (char_length(currency) = 3),
  account_id uuid references accounts (id),
  started_on date not null
);

-- רגל מימון — one source that funded the project, in the currency it was actually
-- paid in. The pot's cost is the sum of these rows, so adding money to a project
-- is inserting one and never editing a total.
--
-- `usd_ils_rate` is the rate that was actually used, quoted USD/ILS in both
-- directions so one number can never be read as two. It is null exactly when the
-- leg was already in the pot's currency and converted nothing; the trigger below
-- is what holds that, because a rate beside money that never changed currency is
-- a number nobody used.
create table if not exists funding_legs (
  id           uuid   primary key default gen_random_uuid(),
  project_id   uuid   not null references projects (id) on delete cascade,
  source       text   not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency     text   not null check (char_length(currency) = 3),
  usd_ils_rate numeric(18, 6) check (usd_ils_rate > 0),
  paid_on      date   not null
);

create index if not exists funding_legs_project_idx on funding_legs (project_id);

-- הוצאת פרוייקט — money drawn *out of* the pot. There is no shape in which one of
-- these adds to what is available: `יתרה = Σ(legs) − Σ(expenses)` is computed on
-- read and stored nowhere, and an expense that would overdraw the pot is refused
-- by the domain before it reaches here.
create table if not exists project_expenses (
  id           uuid   primary key default gen_random_uuid(),
  project_id   uuid   not null references projects (id) on delete cascade,
  description  text   not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency     text   not null check (char_length(currency) = 3),
  usd_ils_rate numeric(18, 6) check (usd_ils_rate > 0),
  paid_on      date   not null
);

create index if not exists project_expenses_project_idx on project_expenses (project_id);

-- A rate is recorded where a conversion happened and nowhere else. The rule needs
-- the project's own currency, which a column check cannot reach, so it is a
-- trigger — the same shape as the snapshot line's source check.
create or replace function jubot_pot_movement_rate_agrees() returns trigger as $fn$
declare
  pot_currency text;
begin
  select currency into pot_currency from projects where id = new.project_id;

  if new.currency = pot_currency and new.usd_ils_rate is not null then
    raise exception 'row % is already in the pot''s currency and converted nothing, yet records a rate', new.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.currency <> pot_currency and new.usd_ils_rate is null then
    raise exception 'row % is in % against a % pot and must record the rate that was used', new.id, new.currency, pot_currency
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$fn$ language plpgsql;

do $do$
begin
  if not exists (select 1 from pg_trigger where tgname = 'funding_leg_rate_must_agree') then
    create constraint trigger funding_leg_rate_must_agree
      after insert or update on funding_legs
      for each row execute function jubot_pot_movement_rate_agrees();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'project_expense_rate_must_agree') then
    create constraint trigger project_expense_rate_must_agree
      after insert or update on project_expenses
      for each row execute function jubot_pot_movement_rate_agrees();
  end if;
end;
$do$;

-- תנאי העסקה — what the sponsor's paperwork stated. At most one row per project:
-- it is a promise read off a document, not a series of measurements. Everything
-- but `recorded_on` is nullable, because a document that states only a hold period
-- states only a hold period.
create table if not exists deal_terms (
  project_id       uuid primary key references projects (id) on delete cascade,
  target_return_bp integer,
  hold_months      integer check (hold_months > 0),
  distribution     text,
  source           text,
  recorded_on      date not null
);

comment on column deal_terms.target_return_bp is
  'The stated target return in whole basis points — 1800 is 18%. A promise, never a measurement.';

-- --------------------------------------------------------------------------
-- מחשבון RSU
-- --------------------------------------------------------------------------

-- What the paperwork awarded. `reference` is the ID the grant document states,
-- kept as written and left in English.
--
-- There is deliberately no qualification column: whether a lot has passed סעיף
-- 102's twenty-four months is derived from `granted_on` on every read (see
-- src/domain/rsu). A stored flag would need sweeping by something, and whatever
-- failed to run would price an early sale as though the clock had finished.
--
-- A price per share is *not* money in minor units: GP 149.4219 is a real figure
-- off a real statement and cents cannot hold it. Prices are integer
-- ten-thousandths with their own currency, the same way money is integer minor
-- units with its own — exact, and never a float.
create table if not exists rsu_grants (
  id                        uuid primary key default gen_random_uuid(),
  person_id                 text     not null references people (id),
  reference                 text     not null unique,
  granted_on                date     not null,
  total_shares              integer  not null check (total_shares > 0),
  grant_price_ten_thousandths bigint check (grant_price_ten_thousandths >= 0),
  grant_price_currency      text     check (char_length(grant_price_currency) = 3),
  grant_price_source        text     check (grant_price_source in ('stated', 'estimated')),
  grant_price_window        text,
  grant_price_samples       integer  check (grant_price_samples > 0),
  -- The figure and its currency arrive together or not at all.
  check ((grant_price_ten_thousandths is null) = (grant_price_currency is null)),
  check ((grant_price_ten_thousandths is null) = (grant_price_source is null)),
  -- An estimate states the window and the sample that produced it; a stated price
  -- was produced by no window, so it carries neither. The two must not read alike.
  check (grant_price_source is distinct from 'estimated'
         or (grant_price_window is not null and grant_price_samples is not null)),
  check (grant_price_source is distinct from 'stated'
         or (grant_price_window is null and grant_price_samples is null))
);

comment on column rsu_grants.grant_price_source is
  'stated — read off an ESOP document, a fact. estimated — averaged out of closes '
  'over a window, which is not. Every screen that shows an estimate says so.';

-- A slice of a grant becoming the household's. Recorded ahead of its date as
-- readily as after it: the position holds future vests out of itself by comparing
-- `vested_on` to the day it is read on, so nothing here needs a status.
create table if not exists rsu_vests (
  id                     uuid    primary key default gen_random_uuid(),
  grant_id               uuid    not null references rsu_grants (id) on delete cascade,
  vested_on              date    not null,
  shares                 integer not null check (shares > 0),
  price_ten_thousandths  bigint  not null check (price_ten_thousandths >= 0),
  price_currency         text    not null check (char_length(price_currency) = 3)
);

create index if not exists rsu_vests_grant_idx on rsu_vests (grant_id);

-- Shares leaving one named lot. The lot is not a detail: which one they left is
-- what decides how they are taxed. A sale larger than the lot holds is refused by
-- the domain before it reaches here, the same way an overdrawing project expense is.
create table if not exists rsu_sales (
  id                    uuid    primary key default gen_random_uuid(),
  vest_id               uuid    not null references rsu_vests (id) on delete cascade,
  sold_on               date    not null,
  shares                integer not null check (shares > 0),
  price_ten_thousandths bigint  not null check (price_ten_thousandths >= 0),
  price_currency        text    not null check (char_length(price_currency) = 3)
);

create index if not exists rsu_sales_vest_idx on rsu_sales (vest_id);

-- A vest cannot precede its grant, and a sale cannot precede its vest. Both need a
-- date from the parent row, which a column check cannot reach, so both are
-- triggers — the same shape as the snapshot line's source check.
create or replace function jubot_vest_follows_grant() returns trigger as $fn$
declare
  granted date;
begin
  select granted_on into granted from rsu_grants where id = new.grant_id;
  if new.vested_on < granted then
    raise exception 'vest % on % precedes its grant on %', new.id, new.vested_on, granted
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$fn$ language plpgsql;

create or replace function jubot_sale_follows_vest() returns trigger as $fn$
declare
  vested date;
begin
  select vested_on into vested from rsu_vests where id = new.vest_id;
  if new.sold_on < vested then
    raise exception 'sale % on % precedes the vest it sells, on %', new.id, new.sold_on, vested
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$fn$ language plpgsql;

do $do$
begin
  if not exists (select 1 from pg_trigger where tgname = 'vest_must_follow_grant') then
    create constraint trigger vest_must_follow_grant
      after insert or update on rsu_vests
      for each row execute function jubot_vest_follows_grant();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'sale_must_follow_vest') then
    create constraint trigger sale_must_follow_vest
      after insert or update on rsu_sales
      for each row execute function jubot_sale_follows_vest();
  end if;
end;
$do$;

-- --------------------------------------------------------------------------
-- לוח תכנון
-- --------------------------------------------------------------------------

-- תרחיש — a named what-if. These three tables are the only ones the planning
-- screens write, and they write nothing else: a scenario exists so that "CGM 3 in
-- 2027" can be thought about without disturbing anything recorded.
create table if not exists scenarios (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  note       text,
  created_on date not null
);

-- תוכנית מימון — what a future investment needs, and by when. At most one row per
-- scenario: a scenario is one what-if about one investment, and two requirements
-- inside it would be two scenarios. A scenario with no row here is a legitimate
-- state — a name and a thought, before anybody has priced it.
create table if not exists funding_plans (
  scenario_id        uuid   primary key references scenarios (id) on delete cascade,
  needs_amount_minor bigint not null check (needs_amount_minor > 0),
  needs_currency     text   not null check (char_length(needs_currency) = 3),
  needed_by          date   not null
);

-- One source that would cover part of a plan — the *before* of a funding leg.
--
-- There is deliberately no rate column and no date. A future conversion has no rate
-- yet, and a rate written down before the money moved would be a number nobody
-- used; the day it moves is not knowable either. Both arrive when the plan is
-- executed and its lines become real legs.
--
-- `origin` says where the amount came from. `stated` is a figure somebody typed;
-- `seeded` is one the system read out of recorded data, and then it must say which
-- figure and on which day — so a seeded amount can always be held against the
-- reading it came from rather than quietly ageing into a number of unknown vintage.
create table if not exists funding_plan_sources (
  id           uuid   primary key default gen_random_uuid(),
  scenario_id  uuid   not null references scenarios (id) on delete cascade,
  source       text   not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency     text   not null check (char_length(currency) = 3),
  origin       text   not null check (origin in ('stated', 'seeded')),
  seed_figure  text   check (seed_figure in ('free-liquid')),
  seeded_as_of date,
  unique (scenario_id, source),
  -- A seeded figure states its provenance and a stated one has none to state, so
  -- the two can never read alike — the same rule an estimated GP holds against a
  -- price read off a document.
  check ((origin = 'seeded') = (seed_figure is not null)),
  check ((seed_figure is null) = (seeded_as_of is null))
);

create index if not exists funding_plan_sources_scenario_idx
  on funding_plan_sources (scenario_id);

-- הקצאת חיסכון — how much of a month's saving goes to which goal. 5,000 to the
-- emergency fund and 10,000 to real estate: an intention about future money, so
-- it is typed and never derived. Whether the household actually saves the sum of
-- these is a question for the מאזן, and the projection answers it rather than
-- assuming it.
--
-- `target_minor` is what the goal is aiming at, and is optional: "10,000 a month
-- to real estate" is a complete intention with no finish line on it.
create table if not exists scenario_allocations (
  id                   uuid   primary key default gen_random_uuid(),
  scenario_id          uuid   not null references scenarios (id) on delete cascade,
  goal                 text   not null,
  monthly_amount_minor bigint not null check (monthly_amount_minor > 0),
  target_minor         bigint check (target_minor > 0),
  currency             text   not null check (char_length(currency) = 3),
  unique (scenario_id, goal)
);

create index if not exists scenario_allocations_scenario_idx
  on scenario_allocations (scenario_id);

-- דפוס חוזר — "a CGM every year for ten years". One row per scenario, because a
-- pattern is the shape of one strategy and two of them are two scenarios.
--
-- `modelled_on` names the project whose Deal Terms the projection reads: what
-- comes back, and after how long. It is a promise off a sponsor's paperwork and
-- not a measurement, which is why the scenario may override it below — and why
-- naming no project at all is legitimate, under which nothing ever comes back and
-- the projection says so.
create table if not exists scenario_patterns (
  scenario_id  uuid    primary key references scenarios (id) on delete cascade,
  amount_minor bigint  not null check (amount_minor > 0),
  currency     text    not null check (char_length(currency) = 3),
  every_months integer not null check (every_months > 0),
  occurrences  integer not null check (occurrences > 0),
  first_on     date    not null,
  modelled_on  uuid    references projects (id) on delete set null
);

-- תנאי עסקה בתוך תרחיש — the sponsor's promise, stress-tested. A row here
-- overrides what `deal_terms` records, *for this scenario only*: the recorded
-- terms are what the paperwork said and nothing in a what-if may edit them.
--
-- A null column is not an override. It means "this scenario says nothing about
-- that term", and the recorded one still stands — so overriding the return
-- without touching the hold period is one row, not a copy of the document.
create table if not exists scenario_deal_terms (
  scenario_id      uuid not null references scenarios (id) on delete cascade,
  project_id       uuid not null references projects (id) on delete cascade,
  target_return_bp integer,
  hold_months      integer check (hold_months > 0),
  primary key (scenario_id, project_id)
);

-- The one scenario the household says it is actually following. The dashboard
-- measures against this one, so there must never be two: the partial unique index
-- indexes only the rows that are marked, and uniqueness over them permits exactly
-- one. Marking none is a legitimate state — "we are not following a plan".
alter table scenarios add column if not exists is_active boolean not null default false;

create unique index if not exists scenarios_one_active_plan
  on scenarios ((is_active)) where is_active;

-- ביצוע תוכנית מימון — the moment a plan stopped being a what-if.
--
-- This is the only table in לוח תכנון whose writing also writes something
-- recorded: executing a plan inserts a Funding Leg per planned source, at the
-- rate actually used, into the project named here. Everything else the planning
-- board does writes nothing but its own three tables.
--
-- The reference to `scenarios` deliberately does *not* cascade. A scenario that
-- was executed is no longer only a thought — it is how a project came to be
-- funded — so the database refuses to delete it, and the legs it created keep
-- their provenance. Its `project_id` does not cascade either: a project cannot be
-- deleted out from under the record of how it was funded.
create table if not exists funding_plan_executions (
  scenario_id  uuid    primary key references scenarios (id),
  project_id   uuid    not null references projects (id),
  executed_on  date    not null,
  usd_ils_rate numeric(18, 6) check (usd_ils_rate > 0),
  leg_count    integer not null check (leg_count > 0)
);

comment on column funding_plan_executions.usd_ils_rate is
  'The rate the sources were actually converted at, or null where none of them '
  'changed currency. The same rule a funding leg holds: a rate beside money that '
  'was never converted is a number nobody used.';

-- --------------------------------------------------------------------------
-- סיכום שנתי
-- --------------------------------------------------------------------------

-- Where a year ended, across every feature at once.
--
-- ADR 0002: this table holds *only* what cannot be recomputed. There is no
-- הכנסות column, no הוצאות column and no חיסכון column, because all three are a
-- pure function of the ledger and a copy of them here would go stale the moment a
-- typo from that year is corrected. What is here is the state of the world on the
-- closing day — the rate, the share price, and which reading the household says
-- the year closed on — none of which anything can reconstruct afterwards.
--
-- `closing_snapshot_id` does not cascade: a reading a year was closed on is not a
-- snapshot anybody may quietly remove.
create table if not exists annual_reviews (
  year                                smallint primary key check (year between 2000 and 2100),
  note                                text,
  recorded_on                         date not null,
  closing_snapshot_id                 uuid references snapshots (id),
  closing_usd_ils_rate                numeric(18, 6) check (closing_usd_ils_rate > 0),
  closing_share_price_ten_thousandths bigint check (closing_share_price_ten_thousandths >= 0),
  closing_share_price_currency        text check (char_length(closing_share_price_currency) = 3),
  -- The figure and its currency arrive together or not at all, as everywhere else.
  constraint annual_reviews_share_price_has_currency
    check ((closing_share_price_ten_thousandths is null) = (closing_share_price_currency is null))
);

comment on column annual_reviews.closing_usd_ils_rate is
  'The rate the year closed at, quoted USD/ILS in both directions. Frozen because '
  'nothing can reconstruct it later — and never applied to a snapshot, which keeps '
  'converting at its own.';

-- What somebody judged a project to be worth at the close. A project''s *cost* is
-- recomputable from its funding legs forever, so it is not here; what a person
-- thought it was worth on 31 December is not recomputable at all, so it is.
--
-- Per ADR 0003 this never becomes the project's מיפוי value. It sits beside the
-- cost and the difference is stated; an illiquid asset is still held at cost.
create table if not exists annual_review_valuations (
  year         smallint not null references annual_reviews (year) on delete cascade,
  project_id   uuid     not null references projects (id),
  amount_minor bigint   not null check (amount_minor >= 0),
  currency     text     not null check (char_length(currency) = 3),
  primary key (year, project_id)
);
