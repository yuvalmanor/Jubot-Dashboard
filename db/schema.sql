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
