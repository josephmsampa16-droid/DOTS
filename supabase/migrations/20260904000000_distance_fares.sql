-- Distance-based fares.
--
-- Fares are computed in the database, never sent up by the client: a rider app
-- that could name its own price would be trivial to cheat. The rider sees an
-- estimate from quote_fare() before requesting; the trigger recomputes the same
-- number on insert and that is the one that counts.
--
-- Rates live in a table rather than in code so pricing can be changed without a
-- deploy — which matters if you are competing on price.

create table if not exists public.pricing (
  id bigint generated always as identity primary key,
  currency text not null default 'ZMW',
  base_fare numeric(10,2) not null,      -- charged on every trip
  per_km numeric(10,2) not null,         -- charged per km of estimated road distance
  minimum_fare numeric(10,2) not null,   -- floor, so very short trips still pay
  -- haversine_km is straight-line. Real roads wander, so multiply to approximate
  -- driving distance. 1.4 is a starting guess for Lusaka and should be
  -- calibrated against real trips — see the README notes.
  road_factor numeric(4,2) not null default 1.40,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);

-- Exactly one active price list at a time. Changing prices = insert a new row
-- and deactivate the old one, so historical fares stay explainable.
create unique index if not exists pricing_single_active
  on public.pricing ((active)) where active;

alter table public.rides
  add column if not exists distance_km numeric(10,2),
  add column if not exists fare numeric(10,2),
  add column if not exists currency text,
  add column if not exists pricing_id bigint references public.pricing(id);

-- Returns null distance/fare when the destination has no coordinates, which is
-- common: the OS geocoder often cannot place informal Zambian addresses. The
-- ride is still valid, it just has no quote until a destination is pinned.
create or replace function public.quote_fare(
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_dest_lat double precision,
  p_dest_lng double precision
)
returns table (distance_km numeric, fare numeric, currency text, pricing_id bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  pr pricing%rowtype;
  straight_km numeric;
  road_km numeric;
begin
  select * into pr from pricing where active limit 1;
  if not found then
    raise exception 'no active pricing row';
  end if;

  if p_dest_lat is null or p_dest_lng is null
     or p_pickup_lat is null or p_pickup_lng is null then
    return query select null::numeric, null::numeric, pr.currency, pr.id;
    return;
  end if;

  straight_km := haversine_km(p_pickup_lat, p_pickup_lng, p_dest_lat, p_dest_lng);
  road_km := round((straight_km * pr.road_factor)::numeric, 2);

  return query select
    road_km,
    greatest(pr.minimum_fare, round((pr.base_fare + pr.per_km * road_km)::numeric, 2)),
    pr.currency,
    pr.id;
end;
$function$;

grant execute on function public.quote_fare(double precision, double precision, double precision, double precision) to authenticated;

-- Server-authoritative pricing: whatever the client sends for distance_km/fare
-- is overwritten here.
create or replace function public.set_ride_fare()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare q record;
begin
  select * into q from quote_fare(new.pickup_lat, new.pickup_lng, new.dest_lat, new.dest_lng);
  new.distance_km := q.distance_km;
  new.fare        := q.fare;
  new.currency    := q.currency;
  new.pricing_id  := q.pricing_id;
  return new;
end;
$function$;

drop trigger if exists trg_set_ride_fare on public.rides;
create trigger trg_set_ride_fare
  before insert on public.rides
  for each row execute function public.set_ride_fare();

-- Anyone signed in may read the current price list; only staff may change it.
alter table public.pricing enable row level security;

drop policy if exists "Anyone signed in can read pricing" on public.pricing;
create policy "Anyone signed in can read pricing"
  on public.pricing for select to authenticated using (true);

drop policy if exists "Staff manage pricing" on public.pricing;
create policy "Staff manage pricing"
  on public.pricing for all to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'Staff'))
  with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'Staff'));

grant select on public.pricing to authenticated;
