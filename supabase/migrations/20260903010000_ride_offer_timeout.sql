-- Ride offer timeout.
--
-- Problem: a ride matched to a driver who never answers sits in 'matched'
-- forever. match_nearest_driver() treats any driver holding a matched/accepted
-- ride as busy, so one ignored request also takes that driver out of dispatch
-- indefinitely. The rider waits on nothing.
--
-- Fix: give each offer a deadline. A ride still sitting in 'matched' after
-- `timeout_seconds` is re-matched to the next-nearest driver, or falls to
-- 'no_drivers' when there is nobody else — which at least tells the rider to
-- try again instead of leaving them staring at a spinner.

-- Which drivers have already been offered this ride. Without this, a re-match
-- can hand the ride straight back to the driver who just ignored (or declined)
-- it, and it ping-pongs. decline_ride() previously excluded only the immediate
-- decliner, so A-declines -> B-declines -> back to A was already possible; this
-- closes that too.
alter table public.rides
  add column if not exists offered_driver_ids uuid[] not null default '{}';

-- Now excludes every previously-offered driver, not just the ones the caller
-- remembers to pass in, and records each driver it offers the ride to.
create or replace function public.match_nearest_driver(
  ride_id_in uuid,
  exclude_driver_ids uuid[] default '{}'::uuid[]
)
returns uuid
language plpgsql
security definer
as $function$
declare
  chosen_driver_id uuid;
  ride_row rides%rowtype;
  excluded uuid[];
begin
  select * into ride_row from rides where id = ride_id_in;
  if not found then
    return null;
  end if;

  -- Anyone already offered this ride is out, however they left it: declined,
  -- timed out, or still holding an offer we are about to replace.
  excluded := coalesce(ride_row.offered_driver_ids, '{}') || coalesce(exclude_driver_ids, '{}');

  select t.driver_user_id into chosen_driver_id
  from taxis t
  where t.status = 'Online'
    and t.current_lat is not null
    and t.current_lng is not null
    and t.driver_user_id != all(excluded)
    and not exists (
      -- driver isn't already on an active ride (other than this one, which we
      -- are in the middle of reassigning away from them)
      select 1 from rides r
      where r.driver_id = t.driver_user_id
        and r.status in ('matched', 'accepted')
        and r.id <> ride_id_in
    )
  order by haversine_km(ride_row.pickup_lat, ride_row.pickup_lng, t.current_lat, t.current_lng) asc
  limit 1;

  if chosen_driver_id is not null then
    update rides
    set driver_id = chosen_driver_id,
        status = 'matched',
        matched_at = now(),
        offered_driver_ids = coalesce(offered_driver_ids, '{}') || chosen_driver_id
    where id = ride_id_in;
  else
    update rides
    set status = 'no_drivers',
        driver_id = null
    where id = ride_id_in;
  end if;

  return chosen_driver_id;
end;
$function$;

-- Re-matches every ride whose offer has gone stale. Returns how many it moved.
create or replace function public.expire_stale_ride_offers(timeout_seconds integer default 45)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  moved integer := 0;
begin
  for r in
    select id, driver_id
    from rides
    where status = 'matched'
      and matched_at is not null
      and matched_at < now() - make_interval(secs => timeout_seconds)
    order by matched_at
    -- skip locked so an overlapping run never processes the same ride twice
    for update skip locked
  loop
    -- driver_id passed explicitly as well, to cover rides matched before
    -- offered_driver_ids existed.
    perform match_nearest_driver(r.id, array_remove(array[r.driver_id], null));
    moved := moved + 1;
  end loop;

  return moved;
end;
$function$;

-- Sweep. pg_cron 1.5+ accepts sub-minute intervals; every 15s bounds the
-- actual timeout to roughly 45-60s. To retune, change the argument here and
-- OFFER_TIMEOUT_SECONDS in dots-taxi-driver/screens/DriverHomeScreen.js.
create extension if not exists pg_cron;

select cron.unschedule('expire-stale-ride-offers')
where exists (select 1 from cron.job where jobname = 'expire-stale-ride-offers');

select cron.schedule(
  'expire-stale-ride-offers',
  '15 seconds',
  $$select public.expire_stale_ride_offers(45)$$
);
