-- Dispatch requires tokens.
--
-- Every driver who already existed gets a starting balance first. Without it,
-- adding the gate would instantly stop matching every current driver, and the
-- app would look broken with no error to explain it.

insert into public.driver_wallets (driver_id, token_balance)
select p.id, 20 from public.profiles p where p.role = 'Driver'
on conflict (driver_id) do nothing;

insert into public.token_ledger (driver_id, delta, reason, balance_after, note)
select w.driver_id, 20, 'signup_bonus', 20, 'Starting balance when tokens were introduced'
from public.driver_wallets w
where not exists (select 1 from public.token_ledger l where l.driver_id = w.driver_id);

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
        and r.status in ('matched', 'accepted')
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
