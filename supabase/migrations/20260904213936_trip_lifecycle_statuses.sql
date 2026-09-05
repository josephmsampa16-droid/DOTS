-- A trip has stages, and collapsing them into "accepted -> completed" left both
-- sides blind: the rider could not tell whether the driver was still driving to
-- them or already carrying them, and the driver had no way to say "I am here".
--
--   accepted     driver is on the way to the pickup
--   arrived      driver is at the pickup, waiting for the rider
--   in_progress  rider is aboard, trip underway
--   completed    trip finished, fare payable

alter table public.rides drop constraint if exists rides_status_check;
alter table public.rides add constraint rides_status_check check (
  status = any (array[
    'requested','matched','accepted','arrived','in_progress',
    'declined','no_drivers','cancelled','completed'
  ])
);

-- Timestamps for the new stages, so a dispute has something to point at.
alter table public.rides
  add column if not exists arrived_at timestamptz,
  add column if not exists started_at timestamptz;

-- A driver part-way through a trip is busy. Without arrived/in_progress in this
-- list, dispatch would hand them a second ride while they are carrying someone.
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
    and w.token_balance > 0
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

-- The rider watches the driver approach on a map. That has to keep working
-- once the trip is underway, not cut out the moment they get in the car.
drop policy if exists "Riders see taxi of their matched driver" on public.taxis;
create policy "Riders see taxi of their matched driver" on public.taxis
  for select using (
    exists (
      select 1 from rides
      where rides.driver_id = taxis.driver_user_id
        and rides.rider_id = auth.uid()
        and rides.status = any (array['matched','accepted','arrived','in_progress'])
    )
  );

-- "Your driver has arrived" is the most useful notification in the whole flow —
-- it is the one the rider is actually waiting for.
create or replace function public.notify_rider_on_ride_status()
returns trigger language plpgsql security definer set search_path to ''
as $function$
declare
  v_url text;
  v_key text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status not in ('matched','accepted','arrived','in_progress','no_drivers','completed') then
    return new;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'ride_push_function_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ride_push_anon_key';

  if v_url is null or v_key is null then
    raise warning 'send-ride-push is not configured (vault secrets missing); skipping push for ride %', new.id;
    return new;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_build_object('ride_id', new.id),
    timeout_milliseconds := 5000
  );

  return new;
end;
$function$;
