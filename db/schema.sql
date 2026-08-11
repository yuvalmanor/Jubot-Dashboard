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
create table if not exists snapshots (
  id         uuid        primary key default gen_random_uuid(),
  taken_on   date        not null unique,
  note       text,
  created_at timestamptz not null default now()
);

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
