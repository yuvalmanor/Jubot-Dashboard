-- One real figure to prove the pipe end to end: CGM 1's dollar Funding Leg.
-- $69,000 of Apple RSU, stored as 6,900,000 cents.

insert into money_settings (key, label_he, amount_minor, currency)
values ('cgm1_usd_funding_leg', 'רגל מימון דולרית — CGM 1', 6900000, 'USD')
on conflict (key) do update
  set label_he     = excluded.label_he,
      amount_minor = excluded.amount_minor,
      currency     = excluded.currency,
      updated_at   = now();

insert into fx_rates (base, quote, rate, as_of)
values ('USD', 'ILS', 3.650000, current_date)
on conflict (base, quote, as_of) do update
  set rate = excluded.rate;

-- The two People. `email` is the link from a Google sign-in to a Person, so on a
-- deployed instance these must be the two real addresses — the same two that are
-- in JUBOT_ALLOWED_EMAILS. The placeholders below match .env.example.
insert into people (id, display_name, email)
values ('yuval', 'יובל', 'yuval@example.com'),
       ('eden',  'עדן',  'eden@example.com')
on conflict (id) do update
  set display_name = excluded.display_name,
      email        = excluded.email;

-- No categories are seeded. Every Personal Category is named by the Person who
-- owns it, and creating one always creates or joins a Household Category.
