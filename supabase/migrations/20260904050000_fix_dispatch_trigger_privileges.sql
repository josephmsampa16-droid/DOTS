-- Locking down match_nearest_driver broke ride requests.
--
-- trigger_match_on_ride_request was the one SECURITY INVOKER function in the
-- dispatch path, so it ran as the rider who inserted the ride — and riders no
-- longer hold EXECUTE on match_nearest_driver. Every rider saw
-- "permission denied for function match_nearest_driver" and could not book.
--
-- The regression was missed because the check was run from the SQL editor,
-- which connects as a superuser: the trigger succeeded there while failing for
-- every real user. Privilege changes have to be tested as the role that will
-- actually hit them.
--
-- SECURITY DEFINER makes it run as its owner, like every other trigger in this
-- schema already does, so dispatch works while direct calls from a client stay
-- blocked. search_path is pinned because a SECURITY DEFINER function resolving
-- names through the caller's search_path can be tricked into running the
-- caller's objects with the owner's rights.
create or replace function public.trigger_match_on_ride_request()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'requested' then
    perform match_nearest_driver(new.id);
  end if;
  return new;
end;
$function$;
