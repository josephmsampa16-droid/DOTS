-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- exposes every public function over PostgREST. The anon key is published in
-- index.html, so "callable by anon" means callable by anyone on the internet.
--
-- Found by trying it: an unauthenticated caller holding only the public anon
-- key could run adjust_tokens and mint 500 tokens for any driver. Left alone,
-- anyone could give themselves unlimited tokens or drain a competitor to
-- negative — the entire prepaid model, gone.
--
-- The triggers that spend tokens and the edge functions that credit them run
-- with elevated rights and never needed this grant.

revoke all on function public.adjust_tokens(uuid, integer, text, uuid, bigint, text) from public;
revoke all on function public.adjust_tokens(uuid, integer, text, uuid, bigint, text) from anon;
revoke all on function public.adjust_tokens(uuid, integer, text, uuid, bigint, text) from authenticated;
grant execute on function public.adjust_tokens(uuid, integer, text, uuid, bigint, text) to service_role;

-- Dispatch. Open, anyone could force a ride onto any driver or reassign one
-- away from the driver already doing it. Only the triggers call it.
revoke all on function public.match_nearest_driver(uuid, uuid[]) from public;
revoke all on function public.match_nearest_driver(uuid, uuid[]) from anon;
revoke all on function public.match_nearest_driver(uuid, uuid[]) from authenticated;
grant execute on function public.match_nearest_driver(uuid, uuid[]) to service_role;

-- decline_ride must stay callable by drivers — the app calls it directly — but
-- it never checked who was calling, so any signed-in user could decline
-- anybody else's ride. Now it refuses unless the caller is the assigned driver.
create or replace function public.decline_ride(ride_id_in uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  declining_driver uuid;
  new_driver uuid;
begin
  select driver_id into declining_driver from rides where id = ride_id_in;
  if declining_driver is null then
    return null;
  end if;

  if auth.uid() is distinct from declining_driver then
    raise exception 'Only the assigned driver may decline this ride';
  end if;

  update rides set status = 'declined' where id = ride_id_in;
  new_driver := match_nearest_driver(ride_id_in, array[declining_driver]);
  return new_driver;
end;
$function$;

revoke all on function public.decline_ride(uuid) from public;
revoke all on function public.decline_ride(uuid) from anon;
grant execute on function public.decline_ride(uuid) to authenticated;

-- quote_fare only computes a price from values the caller already supplies. It
-- reads nothing private and changes nothing, but there is no reason for anon.
revoke all on function public.quote_fare(double precision, double precision, double precision, double precision) from public;
revoke all on function public.quote_fare(double precision, double precision, double precision, double precision) from anon;
grant execute on function public.quote_fare(double precision, double precision, double precision, double precision) to authenticated;
