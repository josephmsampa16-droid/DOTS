-- The hybrid fare: base + distance + time, adjusted by demand inside a hard
-- cap, floored at a minimum, split by a commission the driver can read.
--
--   fare = max(minimum, (base + per_km*km + per_minute*minutes) * demand)
--
-- Three service tiers price independently while sharing that shape, so
-- Comfort and XL are configuration rather than new code.

alter table public.pricing
  add column if not exists tier text not null default 'standard',
  add column if not exists per_minute numeric(10,2) not null default 0.50,
  -- No routing API yet, so duration is derived from distance at an assumed
  -- city speed. Replace this with real routing and the formula is unchanged.
  add column if not exists avg_speed_kmh numeric(5,1) not null default 25.0,
  add column if not exists commission_rate numeric(5,4) not null default 0.1500,
  add column if not exists surge_enabled boolean not null default true,
  add column if not exists surge_min numeric(4,2) not null default 0.90,
  add column if not exists surge_max numeric(4,2) not null default 1.30;

alter table public.pricing drop constraint if exists pricing_tier_check;
alter table public.pricing add constraint pricing_tier_check
  check (tier = any (array['standard','comfort','xl']));

-- Surge that can run away is the thing riders hate. The cap is a schema rule,
-- not a habit, so no future edit can quietly raise it past 1.3.
alter table public.pricing drop constraint if exists pricing_surge_bounds_check;
alter table public.pricing add constraint pricing_surge_bounds_check
  check (surge_min > 0 and surge_min <= 1.00 and surge_max >= 1.00 and surge_max <= 1.30);

alter table public.pricing drop constraint if exists pricing_commission_check;
alter table public.pricing add constraint pricing_commission_check
  check (commission_rate >= 0 and commission_rate <= 0.30);

-- Was "one active row" full stop; each tier now needs its own active row.
drop index if exists public.pricing_single_active;
create unique index if not exists pricing_one_active_per_tier
  on public.pricing (tier) where active;

-- Standard: the rates you specified.
update public.pricing
   set tier = 'standard', base_fare = 15.00, per_km = 7.00, per_minute = 0.50,
       minimum_fare = 35.00, commission_rate = 0.1500
 where id = 1;

-- Comfort and XL. These rates are placeholders, as the Standard ones were:
-- they need calibrating against real vehicle costs before launch.
insert into public.pricing (tier, active, currency, base_fare, per_km, per_minute,
                            minimum_fare, road_factor, max_trip_km, token_price,
                            avg_speed_kmh, commission_rate)
select 'comfort', true, 'ZMW', 25.00, 10.00, 0.75, 50.00, 1.40, 500.00, 5.00, 25.0, 0.1500
where not exists (select 1 from public.pricing where tier = 'comfort');

insert into public.pricing (tier, active, currency, base_fare, per_km, per_minute,
                            minimum_fare, road_factor, max_trip_km, token_price,
                            avg_speed_kmh, commission_rate)
select 'xl', true, 'ZMW', 30.00, 12.00, 0.90, 60.00, 1.40, 500.00, 5.00, 25.0, 0.1500
where not exists (select 1 from public.pricing where tier = 'xl');

-- Driver commission levels. Fleet is "negotiated", which is a per-driver
-- number rather than a band, so it lives as an override on the profile.
alter table public.profiles
  add column if not exists driver_level text not null default 'new',
  add column if not exists commission_rate_override numeric(5,4);

alter table public.profiles drop constraint if exists profiles_driver_level_check;
alter table public.profiles add constraint profiles_driver_level_check
  check (driver_level = any (array['new','standard','high_performing','fleet']));

alter table public.profiles drop constraint if exists profiles_commission_override_check;
alter table public.profiles add constraint profiles_commission_override_check
  check (commission_rate_override is null
         or (commission_rate_override >= 0 and commission_rate_override <= 0.30));

create table if not exists public.commission_levels (
  level text primary key,
  rate numeric(5,4) not null check (rate >= 0 and rate <= 0.30),
  label text not null
);

insert into public.commission_levels (level, rate, label) values
  ('new',             0.1000, 'New driver'),
  ('standard',        0.1500, 'Standard'),
  ('high_performing', 0.1200, 'High performing'),
  ('fleet',           0.1500, 'Fleet / corporate')
on conflict (level) do update set rate = excluded.rate, label = excluded.label;

alter table public.commission_levels enable row level security;
drop policy if exists "Anyone signed in can read commission levels" on public.commission_levels;
create policy "Anyone signed in can read commission levels" on public.commission_levels
  for select to authenticated using (true);

-- What the ride was quoted at and what it settled to. commission_* and
-- driver_payout stay null until completion, because the rate depends on which
-- driver took it and no driver is known when the ride is created.
alter table public.rides
  add column if not exists service_tier text not null default 'standard',
  add column if not exists duration_min numeric(8,2),
  add column if not exists demand_multiplier numeric(4,2),
  add column if not exists commission_rate numeric(5,4),
  add column if not exists commission_amount numeric(10,2),
  add column if not exists driver_payout numeric(10,2);

alter table public.rides drop constraint if exists rides_service_tier_check;
alter table public.rides add constraint rides_service_tier_check
  check (service_tier = any (array['standard','comfort','xl']));

-- Demand is measured, never asserted by a caller: open requests against
-- drivers actually free to take them. Bounded by the pricing row's own cap.
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
    and w.token_balance > 0
    and not exists (
      select 1 from rides r
      where r.driver_id = t.driver_user_id
        and r.status in ('matched', 'accepted', 'arrived', 'in_progress')
    );

  -- Nobody free to send: raising the price would take money for a scarcity it
  -- cannot fix. The ride will find no driver either way.
  if free_drivers = 0 then
    return 1.00;
  end if;

  ratio := open_requests::numeric / free_drivers;

  return case
    when ratio < 0.5 then pr.surge_min   -- quiet: riders pay less
    when ratio < 1.0 then 1.00
    when ratio < 1.5 then least(1.10, pr.surge_max)
    when ratio < 2.0 then least(1.20, pr.surge_max)
    else pr.surge_max
  end;
end;
$function$;

revoke all on function public.demand_multiplier(text) from public;
grant execute on function public.demand_multiplier(text) to authenticated, anon, service_role;

-- The quote. Same function the insert trigger runs, so what a rider is shown
-- is produced by the code that will charge them.
drop function if exists public.quote_fare(numeric, numeric, numeric, numeric);
create or replace function public.quote_fare(
  p_pickup_lat numeric, p_pickup_lng numeric,
  p_dest_lat numeric, p_dest_lng numeric,
  p_service_tier text default 'standard'
) returns table (
  distance_km numeric, duration_min numeric, fare numeric, currency text,
  pricing_id bigint, service_tier text, demand_multiplier numeric,
  base_fare numeric, distance_charge numeric, time_charge numeric,
  commission_rate numeric, commission_amount numeric, driver_payout numeric
)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  pr pricing%rowtype;
  straight_km numeric;
  road_km numeric;
  mins numeric;
  dist_charge numeric;
  time_charge_v numeric;
  subtotal numeric;
  mult numeric;
  final_fare numeric;
  comm numeric;
begin
  select * into pr from pricing where active and tier = p_service_tier limit 1;
  if not found then
    raise exception 'no active pricing for tier %', p_service_tier;
  end if;

  if p_dest_lat is null or p_dest_lng is null
     or p_pickup_lat is null or p_pickup_lng is null then
    return query select null::numeric, null::numeric, null::numeric, pr.currency,
                        pr.id, pr.tier, null::numeric, null::numeric, null::numeric,
                        null::numeric, pr.commission_rate, null::numeric, null::numeric;
    return;
  end if;

  straight_km := haversine_km(p_pickup_lat, p_pickup_lng, p_dest_lat, p_dest_lng);
  road_km := round((straight_km * pr.road_factor)::numeric, 2);
  mins := round((road_km / pr.avg_speed_kmh * 60)::numeric, 2);

  -- Distance still reported past the cap so the bad value is visible rather
  -- than hidden; only the fare is withheld.
  if road_km > pr.max_trip_km then
    return query select road_km, mins, null::numeric, pr.currency,
                        pr.id, pr.tier, null::numeric, null::numeric, null::numeric,
                        null::numeric, pr.commission_rate, null::numeric, null::numeric;
    return;
  end if;

  dist_charge   := round((pr.per_km * road_km)::numeric, 2);
  time_charge_v := round((pr.per_minute * mins)::numeric, 2);
  subtotal      := pr.base_fare + dist_charge + time_charge_v;
  mult          := demand_multiplier(p_service_tier);
  final_fare    := greatest(pr.minimum_fare, round((subtotal * mult)::numeric, 2));
  comm          := round((final_fare * pr.commission_rate)::numeric, 2);

  return query select
    road_km, mins, final_fare, pr.currency, pr.id, pr.tier, mult,
    pr.base_fare, dist_charge, time_charge_v,
    pr.commission_rate, comm, round((final_fare - comm)::numeric, 2);
end;
$function$;

revoke all on function public.quote_fare(numeric, numeric, numeric, numeric, text) from public;
grant execute on function public.quote_fare(numeric, numeric, numeric, numeric, text) to authenticated, anon, service_role;

-- Server-authoritative: whatever a client sends for fare or distance is
-- overwritten by the same calculation the quote used. (The numeric casts this
-- needs arrive in 20260904235846_fix_set_ride_fare_numeric_cast.sql.)
create or replace function public.set_ride_fare()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare q record;
begin
  select * into q from quote_fare(new.pickup_lat, new.pickup_lng,
                                  new.dest_lat, new.dest_lng,
                                  coalesce(new.service_tier, 'standard'));
  new.distance_km       := q.distance_km;
  new.duration_min      := q.duration_min;
  new.fare              := q.fare;
  new.currency          := q.currency;
  new.pricing_id        := q.pricing_id;
  new.demand_multiplier := q.demand_multiplier;
  return new;
end;
$function$;
