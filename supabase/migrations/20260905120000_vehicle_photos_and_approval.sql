-- §8: a vehicle is registered with photos and goes on the road only once
-- staff have approved it. Existing vehicles are grandfathered as approved so
-- nobody on the road today is knocked offline by this change.

alter table public.taxis
  add column if not exists approval_status text not null default 'pending',
  add column if not exists declined_reason text,
  add column if not exists photo_paths text[] not null default '{}',
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id);

alter table public.taxis drop constraint if exists taxis_approval_status_check;
alter table public.taxis add constraint taxis_approval_status_check
  check (approval_status = any (array['pending', 'approved', 'declined']));

update public.taxis set approval_status = 'approved', reviewed_at = now()
 where approval_status = 'pending' and created_at < now();

create or replace function public.is_staff(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public'
as $function$ select exists (select 1 from profiles where id = p_user and role = 'Staff') $function$;
revoke all on function public.is_staff(uuid) from public;
grant execute on function public.is_staff(uuid) to authenticated, service_role;

-- The gate, and the only two moves a driver may make on approval: none, or
-- back to pending after a decline (a resubmission). Approving is staff's.
create or replace function public.guard_taxi_approval()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.approval_status is distinct from old.approval_status
     and auth.uid() is not null and not is_staff(auth.uid()) then
    if not (old.approval_status = 'declined' and new.approval_status = 'pending') then
      raise exception 'Only DOTS staff can change a vehicle''s approval.' using errcode = 'insufficient_privilege';
    end if;
    new.declined_reason := null;
    new.reviewed_at := null;
    new.reviewed_by := null;
    new.submitted_at := now();
  end if;

  if new.status = 'Online' and new.approval_status <> 'approved' then
    if new.approval_status = 'declined' then
      raise exception 'Your vehicle was not approved%. Submit new photos to try again.',
        case when new.declined_reason is not null
             then ': ' || rtrim(new.declined_reason, '. ') else '' end
        using errcode = 'check_violation';
    end if;
    raise exception 'Your vehicle is still being reviewed. You can go online as soon as DOTS approves it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
drop trigger if exists trg_guard_taxi_approval on public.taxis;
create trigger trg_guard_taxi_approval
  before update on public.taxis
  for each row execute function public.guard_taxi_approval();

create or replace function public.review_vehicle(p_taxi_id bigint, p_decision text, p_reason text default null)
returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not is_staff(auth.uid()) then
    raise exception 'Staff only.' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'declined') then
    raise exception 'Decision must be approved or declined.' using errcode = 'check_violation';
  end if;
  if p_decision = 'declined' and nullif(trim(p_reason), '') is null then
    raise exception 'Give the driver a reason when declining.' using errcode = 'check_violation';
  end if;
  update taxis
     set approval_status = p_decision,
         declined_reason = case when p_decision = 'declined' then trim(p_reason) else null end,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         status = case when p_decision = 'declined' then 'Offline' else status end
   where id = p_taxi_id;
  if not found then
    raise exception 'No such vehicle.' using errcode = 'no_data_found';
  end if;
end;
$function$;
revoke all on function public.review_vehicle(bigint, text, text) from public;
grant execute on function public.review_vehicle(bigint, text, text) to authenticated, service_role;

-- Dispatch and the nearby count only consider approved vehicles.
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
    and t.approval_status = 'approved'
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

create or replace function public.available_drivers_near(
  p_lat numeric, p_lng numeric, p_radius_km numeric default 8
) returns integer
language sql stable security definer set search_path to 'public'
as $function$
  select count(*)::int
  from taxis t
  join driver_wallets w on w.driver_id = t.driver_user_id
  where t.status = 'Online'
    and t.approval_status = 'approved'
    and t.current_lat is not null and t.current_lng is not null
    and w.credit_balance > 0
    and haversine_km(p_lat, p_lng, t.current_lat, t.current_lng) <= p_radius_km
    and not exists (
      select 1 from rides r
      where r.driver_id = t.driver_user_id
        and r.status in ('matched', 'accepted', 'arrived', 'in_progress')
    )
$function$;

insert into storage.buckets (id, name, public) values ('vehicle-photos', 'vehicle-photos', false)
on conflict (id) do nothing;
drop policy if exists "Drivers manage their own vehicle photos" on storage.objects;
create policy "Drivers manage their own vehicle photos" on storage.objects
  for all to authenticated
  using (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Staff read all vehicle photos" on storage.objects;
create policy "Staff read all vehicle photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'vehicle-photos' and is_staff(auth.uid()));
