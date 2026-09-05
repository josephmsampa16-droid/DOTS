-- §7: after a completed ride the rider rates the driver, 1–5, and picks the
-- things that were true of the trip. The point is the brand: DOTS drivers are
-- professional, and this is how that is measured and kept.

create table if not exists public.rating_tags (
  key text primary key,
  label text not null,
  sort integer not null
);
insert into public.rating_tags (key, label, sort) values
  ('polite',            'Polite',            1),
  ('clean_car',         'Clean car',         2),
  ('quiet',             'No loud music',     3),
  ('offered_water',     'Offered water',     4),
  ('good_conversation', 'Good conversation', 5),
  ('good_music',        'Good music',        6)
on conflict (key) do update set label = excluded.label, sort = excluded.sort;
alter table public.rating_tags enable row level security;
drop policy if exists "Anyone signed in can read rating tags" on public.rating_tags;
create policy "Anyone signed in can read rating tags" on public.rating_tags
  for select to authenticated using (true);

create table if not exists public.ride_ratings (
  ride_id uuid primary key references public.rides(id) on delete cascade,
  rider_id uuid not null references public.profiles(id),
  driver_id uuid not null references public.profiles(id),
  stars smallint not null check (stars between 1 and 5),
  tags text[] not null default '{}',
  comment text,
  created_at timestamptz not null default now()
);
create index if not exists ride_ratings_driver_idx on public.ride_ratings (driver_id, created_at desc);
alter table public.ride_ratings enable row level security;
drop policy if exists "Riders read their own ratings" on public.ride_ratings;
create policy "Riders read their own ratings" on public.ride_ratings
  for select to authenticated using (rider_id = auth.uid());
drop policy if exists "Staff read all ratings" on public.ride_ratings;
create policy "Staff read all ratings" on public.ride_ratings
  for select to authenticated using (
    exists (select 1 from profiles where id = auth.uid() and role = 'Staff')
  );

create table if not exists public.driver_rating_summary (
  driver_id uuid primary key references public.profiles(id),
  rating_count integer not null default 0,
  stars_sum integer not null default 0,
  tag_counts jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.driver_rating_summary enable row level security;
drop policy if exists "Drivers read their own summary" on public.driver_rating_summary;
create policy "Drivers read their own summary" on public.driver_rating_summary
  for select to authenticated using (driver_id = auth.uid());
drop policy if exists "Staff read all summaries" on public.driver_rating_summary;
create policy "Staff read all summaries" on public.driver_rating_summary
  for select to authenticated using (
    exists (select 1 from profiles where id = auth.uid() and role = 'Staff')
  );

create or replace function public.apply_ride_rating()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  counts jsonb;
  t text;
begin
  insert into driver_rating_summary (driver_id) values (new.driver_id)
  on conflict (driver_id) do nothing;
  select tag_counts into counts from driver_rating_summary where driver_id = new.driver_id for update;
  foreach t in array new.tags loop
    counts := jsonb_set(counts, array[t], to_jsonb(coalesce((counts ->> t)::int, 0) + 1), true);
  end loop;
  update driver_rating_summary
     set rating_count = rating_count + 1, stars_sum = stars_sum + new.stars,
         tag_counts = counts, updated_at = now()
   where driver_id = new.driver_id;
  return new;
end;
$function$;
drop trigger if exists trg_apply_ride_rating on public.ride_ratings;
create trigger trg_apply_ride_rating
  after insert on public.ride_ratings
  for each row execute function public.apply_ride_rating();

create or replace function public.submit_ride_rating(
  p_ride_id uuid, p_stars integer, p_tags text[] default '{}', p_comment text default null
) returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  r record;
begin
  select rider_id, driver_id, status into r from rides where id = p_ride_id;
  if not found or r.rider_id is distinct from auth.uid() then
    raise exception 'That is not one of your rides.' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'completed' then
    raise exception 'Only a completed ride can be rated.' using errcode = 'check_violation';
  end if;
  if r.driver_id is null then
    raise exception 'This ride had no driver to rate.' using errcode = 'check_violation';
  end if;
  if p_stars is null or p_stars < 1 or p_stars > 5 then
    raise exception 'Pick between 1 and 5 stars.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(coalesce(p_tags, '{}')) u(k) where k not in (select key from rating_tags)) then
    raise exception 'Unknown rating tag.' using errcode = 'check_violation';
  end if;
  begin
    insert into ride_ratings (ride_id, rider_id, driver_id, stars, tags, comment)
    values (p_ride_id, r.rider_id, r.driver_id, p_stars,
            (select coalesce(array_agg(distinct k), '{}') from unnest(coalesce(p_tags, '{}')) u(k)),
            nullif(trim(p_comment), ''));
  exception when unique_violation then
    raise exception 'You have already rated this ride.' using errcode = 'unique_violation';
  end;
end;
$function$;
revoke all on function public.submit_ride_rating(uuid, integer, text[], text) from public;
grant execute on function public.submit_ride_rating(uuid, integer, text[], text) to authenticated, service_role;

drop function if exists public.driver_public_profile(uuid);
create function public.driver_public_profile(p_driver_id uuid)
returns table (
  name text, phone text, rides_completed integer,
  rating numeric, rating_count integer, tag_counts jsonb,
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
         case when s.rating_count > 0 then round(s.stars_sum::numeric / s.rating_count, 2) end,
         coalesce(s.rating_count, 0),
         coalesce(s.tag_counts, '{}'::jsonb),
         t.model, t.color, t.plate
  from profiles p
  left join taxis t on t.driver_user_id = p.id
  left join driver_rating_summary s on s.driver_id = p.id
  where p.id = p_driver_id;
end;
$function$;
revoke all on function public.driver_public_profile(uuid) from public;
grant execute on function public.driver_public_profile(uuid) to authenticated, service_role;
