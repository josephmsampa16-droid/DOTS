-- The wallet now holds kwacha, not tokens. Rides are paid in cash, so DOTS's
-- commission can only be collected from something the driver prepaid — and a
-- percentage of a fare is a kwacha amount, not a whole number of tokens.
--
-- "Tokens" survive as the thing a driver buys: one token is still token_price
-- worth of credit, the MoMo bundles are unchanged, and adjust_tokens keeps its
-- signature so driver-check-topup does not need to know any of this happened.
--
-- Every existing balance and ledger row is re-denominated at token_price, so
-- 63 tokens become K315.00 and the history still adds up.

-- 1. Wallet
alter table public.driver_wallets
  add column if not exists credit_balance numeric(12,2) not null default 0;

update public.driver_wallets
   set credit_balance = round(token_balance *
         (select token_price from public.pricing where tier = 'standard' and active), 2);

-- Loud failure rather than a silent zeroing if the pricing row were missing.
do $$
begin
  if exists (select 1 from public.driver_wallets where credit_balance is null) then
    raise exception 'wallet conversion produced nulls — standard pricing row missing?';
  end if;
end $$;

alter table public.driver_wallets drop column token_balance;

-- 2. Ledger
alter table public.token_ledger
  alter column delta type numeric(12,2),
  alter column balance_after type numeric(12,2);

update public.token_ledger
   set delta = round(delta *
         (select token_price from public.pricing where tier = 'standard' and active), 2),
       balance_after = round(balance_after *
         (select token_price from public.pricing where tier = 'standard' and active), 2);

alter table public.token_ledger drop constraint if exists token_ledger_reason_check;
alter table public.token_ledger add constraint token_ledger_reason_check
  check (reason = any (array['topup','ride','commission','refund','adjustment','signup_bonus']));

-- One debit per ride, whichever name the debit went under.
drop index if exists public.token_ledger_one_charge_per_ride;
create unique index token_ledger_one_charge_per_ride
  on public.token_ledger (ride_id) where reason in ('ride', 'commission');

-- 3. The one function that moves money. Service role only — a driver who
--    could call this could credit themselves, which is why adjust_tokens was
--    locked down in the first place.
create or replace function public.adjust_credit(
  p_driver_id uuid, p_delta numeric, p_reason text,
  p_ride_id uuid default null, p_momo_transaction_id bigint default null, p_note text default null
) returns numeric
language plpgsql security definer set search_path to 'public'
as $function$
declare
  new_balance numeric;
begin
  insert into driver_wallets (driver_id, credit_balance)
  values (p_driver_id, 0)
  on conflict (driver_id) do nothing;

  update driver_wallets
     set credit_balance = credit_balance + p_delta,
         updated_at = now()
   where driver_id = p_driver_id
  returning credit_balance into new_balance;

  insert into token_ledger (driver_id, delta, reason, ride_id, momo_transaction_id, balance_after, note)
  values (p_driver_id, p_delta, p_reason, p_ride_id, p_momo_transaction_id, new_balance, p_note);

  return new_balance;
end;
$function$;

revoke all on function public.adjust_credit(uuid, numeric, text, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.adjust_credit(uuid, numeric, text, uuid, bigint, text) to service_role;

-- adjust_tokens keeps its shape and becomes a unit conversion: N tokens in,
-- N × token_price of credit out. Return type changes, so it must be dropped.
drop function if exists public.adjust_tokens(uuid, integer, text, uuid, bigint, text);
create function public.adjust_tokens(
  p_driver_id uuid, p_delta integer, p_reason text,
  p_ride_id uuid, p_momo_transaction_id bigint, p_note text
) returns numeric
language plpgsql security definer set search_path to 'public'
as $function$
declare
  price numeric;
begin
  select token_price into price from pricing where tier = 'standard' and active;
  if price is null then
    raise exception 'no active standard pricing row to read token_price from';
  end if;
  return adjust_credit(p_driver_id, round(p_delta * price, 2), p_reason,
                       p_ride_id, p_momo_transaction_id, p_note);
end;
$function$;

revoke all on function public.adjust_tokens(uuid, integer, text, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.adjust_tokens(uuid, integer, text, uuid, bigint, text) to service_role;

-- 4. Settlement moves to BEFORE UPDATE and writes onto NEW directly. The AFTER
--    version issued a nested UPDATE, and Postgres runs same-event triggers
--    alphabetically — so the charge trigger would have read a null commission.
drop trigger if exists trg_settle_ride_commission on public.rides;

create or replace function public.settle_ride_commission()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  rate numeric;
  comm numeric;
begin
  if new.status = 'completed'
     and old.status is distinct from 'completed'
     and new.driver_id is not null
     and new.fare is not null
     and new.commission_amount is null then
    rate := driver_commission_rate(new.driver_id);
    comm := round((new.fare * rate)::numeric, 2);
    new.commission_rate   := rate;
    new.commission_amount := comm;
    new.driver_payout     := round((new.fare - comm)::numeric, 2);
  end if;
  return new;
end;
$function$;

create trigger trg_settle_ride_commission
  before update of status on public.rides
  for each row execute function public.settle_ride_commission();

-- 5. The debit. Replaces the flat one-token charge. Allowed to take the wallet
--    negative: a ride the driver already carried must be completable, and the
--    dispatch gate below stops them taking another until they top up.
drop trigger if exists trg_charge_ride_token on public.rides;
drop function if exists public.charge_ride_token();

create or replace function public.charge_ride_commission()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.status = 'completed'
     and old.status is distinct from 'completed'
     and new.driver_id is not null
     and new.commission_amount is not null
     and new.commission_amount > 0 then
    begin
      perform adjust_credit(
        new.driver_id, -new.commission_amount, 'commission', new.id, null,
        format('DOTS %s%% of %s %s', round(new.commission_rate * 100), new.currency, new.fare)
      );
    exception when unique_violation then
      -- Already charged for this ride; leave the ledger alone.
      null;
    end;
  end if;
  return new;
end;
$function$;

create trigger trg_charge_ride_commission
  after update of status on public.rides
  for each row execute function public.charge_ride_commission();

-- 6. Dispatch and demand gate on the new column.
create or replace function public.match_nearest_driver(
  ride_id_in uuid, exclude_driver_ids uuid[] default '{}'::uuid[]
) returns uuid
language plpgsql security definer
as $function$
declare
  chosen_driver_id uuid;
  ride_row rides%rowtype;
  excluded uuid[];
begin
  select * into ride_row from rides where id = ride_id_in;
  if not found then return null; end if;

  excluded := coalesce(ride_row.offered_driver_ids, '{}') || coalesce(exclude_driver_ids, '{}');

  select t.driver_user_id into chosen_driver_id
  from taxis t
  join driver_wallets w on w.driver_id = t.driver_user_id
  where t.status = 'Online'
    and t.current_lat is not null
    and t.current_lng is not null
    and w.credit_balance > 0
    and t.driver_user_id != all(excluded)
    and not exists (
      select 1 from rides r
      where r.driver_id = t.driver_user_id
        and r.status in ('matched','accepted','arrived','in_progress')
        and r.id <> ride_id_in
    )
  order by haversine_km(ride_row.pickup_lat, ride_row.pickup_lng, t.current_lat, t.current_lng) asc
  limit 1;

  if chosen_driver_id is not null then
    update rides set driver_id = chosen_driver_id, status = 'matched', matched_at = now(),
        offered_driver_ids = coalesce(offered_driver_ids, '{}') || chosen_driver_id
    where id = ride_id_in;
  else
    update rides set status = 'no_drivers', driver_id = null where id = ride_id_in;
  end if;

  return chosen_driver_id;
end;
$function$;

create or replace function public.demand_multiplier(p_tier text default 'standard')
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  pr pricing%rowtype;
  open_requests int;
  free_drivers int;
  ratio numeric;
begin
  select * into pr from pricing where active and tier = p_tier limit 1;
  if not found or not pr.surge_enabled then
    return 1.00;
  end if;

  select count(*) into open_requests
  from rides
  where status in ('requested', 'matched')
    and requested_at > now() - interval '10 minutes';

  select count(*) into free_drivers
  from taxis t
  join driver_wallets w on w.driver_id = t.driver_user_id
  where t.status = 'Online'
    and t.current_lat is not null
    and w.credit_balance > 0
    and not exists (
      select 1 from rides r
      where r.driver_id = t.driver_user_id
        and r.status in ('matched', 'accepted', 'arrived', 'in_progress')
    );

  if free_drivers = 0 then
    return 1.00;
  end if;

  ratio := open_requests::numeric / free_drivers;

  return case
    when ratio < 0.5 then pr.surge_min
    when ratio < 1.0 then 1.00
    when ratio < 1.5 then least(1.10, pr.surge_max)
    when ratio < 2.0 then least(1.20, pr.surge_max)
    else pr.surge_max
  end;
end;
$function$;
