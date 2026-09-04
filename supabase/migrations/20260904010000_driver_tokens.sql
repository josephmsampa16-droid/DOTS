-- Prepaid ride tokens. See supabase/TOKENS.md for the model.
--
-- Riders pay drivers in cash, so the platform cannot take a cut of the fare.
-- A driver buys tokens up front and one is spent per completed ride.
--
-- Balance and history are separate on purpose: driver_wallets is read by
-- dispatch on every match so it must be cheap, while token_ledger is the
-- append-only record of how the balance got there. Without the ledger a driver
-- asking "why am I on 3?" has no answer, which is not acceptable for anything
-- touching their money.

create table if not exists public.driver_wallets (
  driver_id uuid primary key references public.profiles(id) on delete cascade,
  -- Allowed to go negative on purpose. A ride already driven must always be
  -- recorded; refusing the deduction to hold a floor of zero would lose the
  -- record of real work. Dispatch gates on > 0, so a negative driver simply
  -- stops receiving offers until they top up.
  token_balance integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.token_ledger (
  id bigint generated always as identity primary key,
  driver_id uuid not null references public.profiles(id) on delete cascade,
  delta integer not null,
  reason text not null check (reason in ('topup','ride','refund','adjustment','signup_bonus')),
  ride_id uuid references public.rides(id) on delete set null,
  momo_transaction_id bigint references public.momo_transactions(id) on delete set null,
  balance_after integer not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists token_ledger_driver_idx
  on public.token_ledger (driver_id, created_at desc);

-- One charge per ride whatever happens upstream. Without this a status set to
-- 'completed' twice bills the driver twice.
create unique index if not exists token_ledger_one_charge_per_ride
  on public.token_ledger (ride_id) where reason = 'ride';

create or replace function public.adjust_tokens(
  p_driver_id uuid, p_delta integer, p_reason text,
  p_ride_id uuid default null, p_momo_transaction_id bigint default null,
  p_note text default null
) returns integer
language plpgsql security definer set search_path to 'public'
as $function$
declare new_balance integer;
begin
  insert into driver_wallets (driver_id, token_balance) values (p_driver_id, 0)
  on conflict (driver_id) do nothing;

  update driver_wallets
  set token_balance = token_balance + p_delta, updated_at = now()
  where driver_id = p_driver_id
  returning token_balance into new_balance;

  insert into token_ledger (driver_id, delta, reason, ride_id, momo_transaction_id, balance_after, note)
  values (p_driver_id, p_delta, p_reason, p_ride_id, p_momo_transaction_id, new_balance, p_note);

  return new_balance;
end;
$function$;

-- Charged on completion, not on accept: a ride that is cancelled or falls
-- through costs the driver nothing. A token burnt on a ride that never happened
-- is the fastest way to lose drivers.
create or replace function public.charge_ride_token()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.status = 'completed' and old.status is distinct from 'completed'
     and new.driver_id is not null then
    begin
      perform adjust_tokens(new.driver_id, -1, 'ride', new.id, null, 'Completed ride');
    exception when unique_violation then
      null; -- already charged for this ride
    end;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_charge_ride_token on public.rides;
create trigger trg_charge_ride_token
  after update of status on public.rides
  for each row execute function public.charge_ride_token();

alter table public.driver_wallets enable row level security;
alter table public.token_ledger enable row level security;

-- Read-only to clients. Tokens only ever move through adjust_tokens.
drop policy if exists "Drivers read own wallet" on public.driver_wallets;
create policy "Drivers read own wallet" on public.driver_wallets
  for select to authenticated using (driver_id = auth.uid());

drop policy if exists "Staff read all wallets" on public.driver_wallets;
create policy "Staff read all wallets" on public.driver_wallets
  for select to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'Staff'));

drop policy if exists "Drivers read own ledger" on public.token_ledger;
create policy "Drivers read own ledger" on public.token_ledger
  for select to authenticated using (driver_id = auth.uid());

drop policy if exists "Staff read all ledger" on public.token_ledger;
create policy "Staff read all ledger" on public.token_ledger
  for select to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'Staff'));

grant select on public.driver_wallets to authenticated;
grant select on public.token_ledger to authenticated;

alter table public.pricing
  add column if not exists token_price numeric(10,2) not null default 5.00;

comment on column public.pricing.token_price is
  'Kwacha a driver pays for one ride token. Placeholder - set from real unit economics.';
