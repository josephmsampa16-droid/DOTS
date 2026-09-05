-- Phase 1 of the September roadmap.
--
--   §6  Lusaka only: a service_areas table (adding a town is a row) and a
--       BEFORE INSERT trigger that refuses rides outside it with a message the
--       app shows verbatim.
--   §3  "N drivers nearby": a SECURITY DEFINER count, because riders cannot
--       read other people's taxi rows and must never be able to.
--   §5  The driver's card on the rider's side, served by a function that only
--       answers for a driver assigned to one of the caller's own rides.

-- ---------------------------------------------------------------- §6
create table if not exists public.service_areas (
  id bigserial primary key,
  name text not null unique,
  centre_lat double precision not null,
  centre_lng double precision not null,
  radius_km numeric(6,2) not null check (radius_km > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.service_areas (name, centre_lat, centre_lng, radius_km) values
  ('Lusaka',   -15.4167, 28.2833, 30),   -- from Cairo Road
  ('Chongwe',  -15.3292, 28.6820, 10),
  ('Chilanga', -15.5586, 28.2745,  8)    -- inside the Lusaka circle; named on purpose
on conflict (name) do update
  set centre_lat = excluded.centre_lat, centre_lng = excluded.centre_lng,
      radius_km = excluded.radius_km, active = true;

alter table public.service_areas enable row level security;
drop policy if exists "Anyone can read active service areas" on public.service_areas;
create policy "Anyone can read active service areas" on public.service_areas
  for select to anon, authenticated using (active);

-- Name of the area a point falls in, or null. The nearest centre wins where
-- circles overlap, so Chilanga answers "Chilanga" rather than "Lusaka".
create or replace function public.service_area_for(p_lat numeric, p_lng numeric)
returns text
language sql stable security definer set search_path to 'public'
as $function$
  select name
  from service_areas
  where active
    and p_lat is not null and p_lng is not null
    and haversine_km(p_lat, p_lng, centre_lat, centre_lng) <= radius_km
  order by haversine_km(p_lat, p_lng, centre_lat, centre_lng)
  limit 1
$function$;

revoke all on function public.service_area_for(numeric, numeric) from public;
grant execute on function public.service_area_for(numeric, numeric) to anon, authenticated, service_role;

-- Both ends of the ride must be inside a service area. The messages are what
-- the rider reads, so they say what to do, not what failed.
create or replace function public.enforce_service_area()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  towns text;
begin
  if service_area_for(new.pickup_lat::numeric, new.pickup_lng::numeric) is null then
    raise exception 'DOTS is not yet available in your city. It is coming soon — you will be able to book here.'
      using errcode = 'check_violation';
  end if;
  if service_area_for(new.dest_lat::numeric, new.dest_lng::numeric) is null then
    select string_agg(name, ', ' order by radius_km desc) into towns from service_areas where active;
    raise exception 'DOTS does not go there yet. Drop-offs must be within % for now.', towns
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_enforce_service_area on public.rides;
create trigger trg_enforce_service_area
  before insert on public.rides
  for each row execute function public.enforce_service_area();

-- ---------------------------------------------------------------- §3
-- Free drivers within reach of a point: online, funded, not on a ride.
create or replace function public.available_drivers_near(
  p_lat numeric, p_lng numeric, p_radius_km numeric default 8
) returns integer
language sql stable security definer set search_path to 'public'
as $function$
  select count(*)::int
  from taxis t
  join driver_wallets w on w.driver_id = t.driver_user_id
  where t.status = 'Online'
    and t.current_lat is not null and t.current_lng is not null
    and w.credit_balance > 0
    and haversine_km(p_lat, p_lng, t.current_lat, t.current_lng) <= p_radius_km
    and not exists (
      select 1 from rides r
      where r.driver_id = t.driver_user_id
        and r.status in ('matched', 'accepted', 'arrived', 'in_progress')
    )
$function$;

revoke all on function public.available_drivers_near(numeric, numeric, numeric) from public;
grant execute on function public.available_drivers_near(numeric, numeric, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------- §5
-- What a rider may know about their driver. Answers only for a driver on one
-- of the caller's own rides, so it cannot be used to look people up.
-- rating / rating_count are placeholders until ride ratings exist (§7).
create or replace function public.driver_public_profile(p_driver_id uuid)
returns table (
  name text, phone text, rides_completed integer,
  rating numeric, rating_count integer,
  vehicle_model text, vehicle_color text, vehicle_plate text
)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from rides
    where rider_id = auth.uid() and driver_id = p_driver_id
      and status in ('matched', 'accepted', 'arrived', 'in_progress', 'completed')
  ) then
    raise exception 'That driver is not on one of your rides.' using errcode = 'insufficient_privilege';
  end if;

  return query
  select p.name, p.phone,
         (select count(*)::int from rides r where r.driver_id = p_driver_id and r.status = 'completed'),
         null::numeric, 0,
         t.model, t.color, t.plate
  from profiles p
  left join taxis t on t.driver_user_id = p.id
  where p.id = p_driver_id;
end;
$function$;

revoke all on function public.driver_public_profile(uuid) from public;
grant execute on function public.driver_public_profile(uuid) to authenticated, service_role;
