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
  type               text        default 'Friend',
  email              text        default '',
  phone              text        default '',
  whatsapp           text        default '',
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
  set_edition           text         default '',
  condition             text         default '',
  quantity              int          default 1,

  -- Buying side
  source                text         default '',
  order_reference       text         default '',
  date_ordered          date,
  cost                  numeric(10,2) default 0,
  shipping_in_cost      numeric(10,2) default 0,
  carrier               text         default '',
  tracking_ref          text         default '',
  tracking_url          text         default '',
  acquisition_status    text         default 'pending',
  delivery_due_date     date,
  date_received         date,
  recipient_address_id  text         references public.addresses(id) on delete set null,

  -- Selling side
  sale_status           text         default 'holding',
  sold_via              text         default '',
  sold_to_address_id    text         references public.addresses(id) on delete set null,
  sale_price            numeric(10,2),
  fees                  numeric(10,2),
  shipping_out_cost     numeric(10,2),
  date_sold             date,

  notes                 text         default '',

  -- Operational (written by the checker)
  last_notified         text,
  last_checked          timestamptz,

  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists inventory_recipient_idx on public.inventory(recipient_address_id);
create index if not exists inventory_acq_status_idx on public.inventory(acquisition_status);

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

alter table public.addresses enable row level security;
alter table public.inventory enable row level security;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: current CardTrack data
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.addresses
  (id, full_name, type, phone, whatsapp, preferred_channel, line1, line2, line3,
   town_city, county, postcode, country, date_added)
values
  ('addr_001', 'Jamie Wilson', 'Friend', '+447700900123', '', 'sms',
   '14 Elm Grove', '', '', 'Brighton', 'East Sussex', 'BN1 4ET', 'UK', '2026-05-15'),
  ('addr_002', 'Sam Roberts',  'Friend', '+447700900456', '', 'sms',
   '8 Oakfield Road', '', '', 'Manchester', 'Greater Manchester', 'M14 6XR', 'UK', '2026-05-15'),
  ('addr_003', 'Lisa Chen',    'Friend', '+447700900789', '', 'sms',
   'Flat 2', '27 Park Lane', '', 'Leeds', 'West Yorkshire', 'LS1 2TW', 'UK', '2026-05-15')
on conflict (id) do nothing;

insert into public.inventory
  (id, item, category, set_edition, condition, quantity, source, date_ordered,
   cost, carrier, tracking_ref, tracking_url, acquisition_status, date_received,
   recipient_address_id, sale_status, last_notified, last_checked)
values
  ('inv_001', 'Charizard Holo 1st Ed.', 'Pokémon', 'Base Set 1st Edition', 'Raw', 1,
   'eBay', '2026-05-15', 240, 'royal_mail', 'RM12345678GB',
   'https://www.royalmail.com/track-your-item#/tracking-results/RM12345678GB',
   'delivered', '2026-05-22', 'addr_001', 'holding', 'delivered', '2026-05-22T09:00:00.000Z'),

  ('inv_002', 'Topps 2024 Prizm Box', 'Topps', '2024 Prizm', 'Sealed', 1,
   'Topps', '2026-05-18', 85, 'royal_mail', 'RM67890123GB',
   'https://www.royalmail.com/track-your-item#/tracking-results/RM67890123GB',
   'in_transit', null, 'addr_002', 'holding', 'in_transit', '2026-05-22T09:00:00.000Z'),

  ('inv_003', 'PSA 10 Pikachu', 'Pokémon', '', 'PSA 10', 1,
   'eBay', '2026-05-19', 420, 'evri', 'EV112233445566',
   'https://www.evri.com/track/EV112233445566',
   'in_transit', null, 'addr_003', 'holding', 'in_transit', '2026-05-22T09:00:00.000Z'),

  ('inv_004', 'Topps Chrome Mbappe', 'Topps', 'Topps Chrome', 'Raw', 1,
   'Topps', '2026-05-21', 55, 'royal_mail', '', '',
   'pending', null, 'addr_002', 'holding', null, null)
on conflict (id) do nothing;
