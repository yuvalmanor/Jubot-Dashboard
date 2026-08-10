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
