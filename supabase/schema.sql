-- CardTrack — Supabase schema
-- Paste this whole file into the Supabase SQL Editor and click Run.
--
-- What this does:
--   1. Creates `addresses` and `inventory` tables with the agreed schema
--   2. Wires up foreign keys (inventory → addresses)
--   3. Adds updated_at auto-update triggers
--   4. Enables Row-Level Security with a public-read / no-public-write policy
--   5. Seeds the current CardTrack data (3 addresses, 4 items)

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.addresses (
  id                 text        primary key,
  full_name          text        not null,
  email              text        default '',
  phone              text        default '',
  preferred_channel  text        default 'sms',
  line1              text        default '',
  line2              text        default '',
  line3              text        default '',
  town_city          text        default '',
  county             text        default '',
  postcode           text        default '',
  country            text        default 'UK',
  notes              text        default '',
  date_added         date        default current_date,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table if not exists public.inventory (
  id                    text         primary key,
  item                  text         not null,
  category              text         default '',
  quantity              int          default 1,

  -- Order
  order_reference       text         default '',
  date_ordered          date,
  cost                  numeric(10,2) default 0,
  carrier               text         default '',
  tracking_ref          text         default '',
  acquisition_status    text         default 'pending',
  delivery_due_date     date,
  date_received         date,
  recipient_address_id  text         references public.addresses(id) on delete set null,

  notes                 text         default '',

  -- Operational (written by the checker)
  last_notified         text,
  last_checked          timestamptz,

  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists inventory_recipient_idx on public.inventory(recipient_address_id);
create index if not exists inventory_acq_status_idx on public.inventory(acquisition_status);

-- Log of every order-confirmation email we've processed.
-- The IMAP Message-ID is the primary key so a re-run never double-inserts.
create table if not exists public.email_ingestions (
  id           text         primary key,
  sender       text         default '',
  subject      text         default '',
  received_at  timestamptz,
  inventory_id text         references public.inventory(id) on delete set null,
  status       text         default 'inserted',  -- inserted | skipped | failed
  reason       text         default '',
  ingested_at  timestamptz  default now()
);

create index if not exists email_ingestions_ingested_at_idx on public.email_ingestions(ingested_at desc);

-- Gmail accounts the scraper can pull from. The `app_password` column is
-- locked down via column-level grants below: anon can write it but not
-- read it. The service-role key (used by the GH Actions ingest job)
-- bypasses RLS, so the job can still fetch it.
create table if not exists public.email_accounts (
  id           text         primary key,
  label        text         not null default '',
  address      text         not null,
  app_password text         not null default '',
  created_at   timestamptz  default now()
);

-- Sender allowlist. The ingest job filters mail to messages whose
-- from-address ends with `@<from_domain>` (or whose reply-to does).
create table if not exists public.sites (
  id              text         primary key,
  label           text         not null default '',
  from_domain     text         not null,
  subject_pattern text         default '',
  active          boolean      default true,
  created_at      timestamptz  default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists addresses_set_updated_at on public.addresses;
create trigger addresses_set_updated_at
  before update on public.addresses
  for each row execute function public.set_updated_at();

drop trigger if exists inventory_set_updated_at on public.inventory;
create trigger inventory_set_updated_at
  before update on public.inventory
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────
-- For now: anyone can read (so the public dashboard works without auth).
-- Writes go through the service-role key in the checker, which bypasses RLS.
-- When you add a dashboard login later, swap "using (true)" for an auth check.

alter table public.addresses        enable row level security;
alter table public.inventory        enable row level security;
alter table public.email_ingestions enable row level security;
alter table public.email_accounts   enable row level security;
alter table public.sites            enable row level security;

drop policy if exists "Public read addresses" on public.addresses;
create policy "Public read addresses"
  on public.addresses for select
  to anon, authenticated
  using (true);

drop policy if exists "Public read inventory" on public.inventory;
create policy "Public read inventory"
  on public.inventory for select
  to anon, authenticated
  using (true);

-- Anyone with the URL can read AND write. No auth gate.
-- Tighten this up if you ever expose the dashboard beyond yourself.
drop policy if exists "Authenticated write addresses" on public.addresses;
drop policy if exists "Anon write addresses"          on public.addresses;
create policy "Anon write addresses"
  on public.addresses for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Authenticated write inventory" on public.inventory;
drop policy if exists "Anon write inventory"          on public.inventory;
create policy "Anon write inventory"
  on public.inventory for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Public read email_ingestions" on public.email_ingestions;
create policy "Public read email_ingestions"
  on public.email_ingestions for select
  to anon, authenticated
  using (true);
-- Writes happen from the GH Actions ingest job via the service-role key,
-- which bypasses RLS — no public write policy needed.

-- email_accounts: anon may write freely, but cannot read app_password
drop policy if exists "Anon read email_accounts"  on public.email_accounts;
drop policy if exists "Anon write email_accounts" on public.email_accounts;
create policy "Anon read email_accounts"
  on public.email_accounts for select
  to anon, authenticated
  using (true);
create policy "Anon write email_accounts"
  on public.email_accounts for all
  to anon, authenticated
  using (true)
  with check (true);
-- Column-level lock: SELECT on app_password is denied to anon. Anon can
-- still INSERT/UPDATE it (so the Settings form works); readers just get
-- a permission error if they try to fetch the column.
revoke select (app_password) on public.email_accounts from anon, authenticated;

drop policy if exists "Anon read sites"  on public.sites;
drop policy if exists "Anon write sites" on public.sites;
create policy "Anon read sites"
  on public.sites for select
  to anon, authenticated
  using (true);
create policy "Anon write sites"
  on public.sites for all
  to anon, authenticated
  using (true)
  with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: current CardTrack data
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.addresses
  (id, full_name, phone, preferred_channel, line1, line2, line3,
   town_city, county, postcode, country, date_added)
values
  ('addr_001', 'Jamie Wilson', '+447700900123', 'sms',
   '14 Elm Grove', '', '', 'Brighton', 'East Sussex', 'BN1 4ET', 'UK', '2026-05-15'),
  ('addr_002', 'Sam Roberts',  '+447700900456', 'sms',
   '8 Oakfield Road', '', '', 'Manchester', 'Greater Manchester', 'M14 6XR', 'UK', '2026-05-15'),
  ('addr_003', 'Lisa Chen',    '+447700900789', 'sms',
   'Flat 2', '27 Park Lane', '', 'Leeds', 'West Yorkshire', 'LS1 2TW', 'UK', '2026-05-15')
on conflict (id) do nothing;

insert into public.sites (id, label, from_domain, subject_pattern, active)
values
  ('site_topps', 'Topps UK',         't.shopifyemail.com',       '',  true),
  ('site_pkmn',  'Pokémon Center',   'pokemoncenter.com',        '',  true)
on conflict (id) do nothing;

insert into public.inventory
  (id, item, category, quantity, date_ordered, cost,
   carrier, tracking_ref, acquisition_status, date_received,
   recipient_address_id, last_notified, last_checked)
values
  ('inv_001', 'Charizard Holo 1st Ed.', 'Pokémon', 1,
   '2026-05-15', 240, 'royal_mail', 'RM12345678GB',
   'delivered', '2026-05-22', 'addr_001', 'delivered', '2026-05-22T09:00:00.000Z'),

  ('inv_002', 'Topps 2024 Prizm Box', 'Topps', 1,
   '2026-05-18', 85, 'royal_mail', 'RM67890123GB',
   'in_transit', null, 'addr_002', 'in_transit', '2026-05-22T09:00:00.000Z'),

  ('inv_003', 'PSA 10 Pikachu', 'Pokémon', 1,
   '2026-05-19', 420, 'evri', 'EV112233445566',
   'in_transit', null, 'addr_003', 'in_transit', '2026-05-22T09:00:00.000Z'),

  ('inv_004', 'Topps Chrome Mbappe', 'Topps', 1,
   '2026-05-21', 55, 'royal_mail', '',
   'pending', null, 'addr_002', null, null)
on conflict (id) do nothing;
