-- ═══════════════════════════════════════════════════════════════════════════════
-- StoreKeeper360 — Supabase Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── PROFILES ─────────────────────────────────────────────────────────────────
-- Extends Supabase's built-in auth.users with store-specific info.
-- A row is created automatically whenever someone signs up (see trigger below).
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  store_name  text not null default 'My Store',
  currency    text not null default '₦',
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create a profile row whenever a new user signs up.
-- Reads name/store_name/currency from the signup metadata passed by the frontend.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, store_name, currency)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'store_name', 'My Store'),
    coalesce(new.raw_user_meta_data->>'currency', '₦')
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── CATEGORIES ───────────────────────────────────────────────────────────────
create table if not exists public.categories (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null,
  unique (user_id, name)
);

alter table public.categories enable row level security;
drop policy if exists "Users manage their own categories" on public.categories;
create policy "Users manage their own categories"
  on public.categories for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── PRODUCTS ─────────────────────────────────────────────────────────────────
create table if not exists public.products (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  sku             text,
  barcode         text,
  name            text not null,
  category_id     bigint references public.categories(id) on delete set null,
  purchase_price  numeric not null default 0,
  selling_price   numeric not null default 0,
  quantity        integer not null default 0,
  restock_level   integer not null default 5,
  unit            text not null default 'pcs',
  description     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.products enable row level security;
-- Safe to re-run: adds barcode if this table already existed from an earlier version.
alter table public.products add column if not exists barcode text;
create unique index if not exists idx_products_barcode_unique on public.products(user_id, barcode) where barcode is not null;
drop policy if exists "Users manage their own products" on public.products;
create policy "Users manage their own products"
  on public.products for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_products_updated on public.products;
create trigger trg_products_updated
  before update on public.products
  for each row execute procedure public.set_updated_at();

-- ── BANK ACCOUNTS ────────────────────────────────────────────────────────────
create table if not exists public.bank_accounts (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  bank_name       text not null,
  account_number  text not null,
  account_name    text not null,
  created_at      timestamptz not null default now()
);

alter table public.bank_accounts enable row level security;
drop policy if exists "Users manage their own bank accounts" on public.bank_accounts;
create policy "Users manage their own bank accounts"
  on public.bank_accounts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── POS TERMINALS ─────────────────────────────────────────────────────────────
create table if not exists public.pos_terminals (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  terminal_name  text not null,
  provider       text,
  terminal_id    text,
  created_at     timestamptz not null default now()
);

alter table public.pos_terminals enable row level security;
drop policy if exists "Users manage their own POS terminals" on public.pos_terminals;
create policy "Users manage their own POS terminals"
  on public.pos_terminals for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── CUSTOMERS ──────────────────────────────────────────────────────────────────
create table if not exists public.customers (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  phone       text,
  email       text,
  notes       text,
  created_at  timestamptz not null default now()
);

alter table public.customers enable row level security;
drop policy if exists "Users manage their own customers" on public.customers;
create policy "Users manage their own customers"
  on public.customers for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_customers_name on public.customers(user_id, name);

-- ── SALES ─────────────────────────────────────────────────────────────────────
create table if not exists public.sales (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  product_id        bigint not null references public.products(id) on delete restrict,
  quantity_sold     integer not null default 1,
  unit_price        numeric not null,
  purchase_price    numeric not null,
  total_revenue     numeric not null,
  total_cost        numeric not null,
  profit            numeric not null,
  note              text,
  sale_date         date not null default current_date,
  payment_method    text not null default 'cash',
  bank_account_id   bigint references public.bank_accounts(id) on delete set null,
  pos_terminal_id   bigint references public.pos_terminals(id) on delete set null,
  transaction_group uuid,
  customer_id       bigint references public.customers(id) on delete set null,
  discount_amount   numeric not null default 0,
  created_at        timestamptz not null default now()
);

alter table public.sales enable row level security;

-- Safe to re-run: adds these columns if this table already existed from an
-- earlier version of this schema (before payment methods / receipts existed).
alter table public.sales add column if not exists payment_method text not null default 'cash';
alter table public.sales add column if not exists bank_account_id bigint references public.bank_accounts(id) on delete set null;
alter table public.sales add column if not exists pos_terminal_id bigint references public.pos_terminals(id) on delete set null;
alter table public.sales add column if not exists transaction_group uuid;
alter table public.sales add column if not exists customer_id bigint references public.customers(id) on delete set null;
alter table public.sales add column if not exists discount_amount numeric not null default 0;

drop policy if exists "Users manage their own sales" on public.sales;
create policy "Users manage their own sales"
  on public.sales for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-reduce product stock whenever a sale is recorded
create or replace function public.reduce_stock_on_sale()
returns trigger as $$
begin
  update public.products
  set quantity = quantity - new.quantity_sold
  where id = new.product_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_reduce_stock on public.sales;
create trigger trg_reduce_stock
  after insert on public.sales
  for each row execute procedure public.reduce_stock_on_sale();

-- Auto-restore stock if a sale is voided/deleted
create or replace function public.restore_stock_on_sale_delete()
returns trigger as $$
begin
  update public.products
  set quantity = quantity + old.quantity_sold
  where id = old.product_id;
  return old;
end;
$$ language plpgsql;

drop trigger if exists trg_restore_stock on public.sales;
create trigger trg_restore_stock
  after delete on public.sales
  for each row execute procedure public.restore_stock_on_sale_delete();

-- ── STOCK ADJUSTMENTS (restocks, manual corrections) ──────────────────────────
create table if not exists public.stock_adjustments (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  bigint not null references public.products(id) on delete cascade,
  delta       integer not null,
  reason      text not null default 'restock',
  note        text,
  created_at  timestamptz not null default now()
);

alter table public.stock_adjustments enable row level security;
drop policy if exists "Users manage their own stock adjustments" on public.stock_adjustments;
create policy "Users manage their own stock adjustments"
  on public.stock_adjustments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.apply_stock_adjustment()
returns trigger as $$
begin
  update public.products
  set quantity = quantity + new.delta
  where id = new.product_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_apply_stock_adj on public.stock_adjustments;
create trigger trg_apply_stock_adj
  after insert on public.stock_adjustments
  for each row execute procedure public.apply_stock_adjustment();

-- ── DEFAULT CATEGORIES ON SIGNUP ───────────────────────────────────────────────
-- Seeds 5 starter categories for every new user, same as the original app.
create or replace function public.seed_default_categories()
returns trigger as $$
begin
  insert into public.categories (user_id, name) values
    (new.id, 'Electronics'),
    (new.id, 'Food & Beverages'),
    (new.id, 'Clothing'),
    (new.id, 'Household'),
    (new.id, 'Others')
  on conflict (user_id, name) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created_categories on auth.users;
create trigger on_auth_user_created_categories
  after insert on auth.users
  for each row execute procedure public.seed_default_categories();

-- ═══════════════════════════════════════════════════════════════════════════════
-- Done! Your database is fully set up.
-- Next: get your Project URL, anon key, and service_role key from
-- Project Settings → API, and add them to your .env / Vercel environment variables.
-- ═══════════════════════════════════════════════════════════════════════════════
