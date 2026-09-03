-- Ride push pipeline.
--
-- This file documents what is already live in the dots-bookings project; it
-- was reconstructed from the database because these objects predate any
-- migration history in this repo. Every statement is idempotent, so applying
-- it to the live project is a no-op beyond refreshing the function body.
--
-- Flow:
--   rides.status changes
--     -> notify_ride_participants (AFTER UPDATE OF status)
--       -> net.http_post to the send-ride-push edge function
--         -> Expo push to the rider and, on 'matched', the driver
--
-- The function URL and anon key live in Vault rather than being inlined, so
-- rotating them doesn't require a migration:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/send-ride-push', 'ride_push_function_url');
--   select vault.create_secret('<anon key>', 'ride_push_anon_key');

create extension if not exists pg_net;

create or replace function public.notify_rider_on_ride_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_url text;
  v_key text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- 'declined' is excluded on purpose: dispatch immediately re-searches, so a
  -- push there would alarm the rider over a non-event. 'cancelled' is the
  -- rider's own action, and 'requested' is the state they already see.
  --
  -- 'matched' is what reaches the *driver* with a new ride request; the edge
  -- function decides the recipients from the ride row.
  if new.status not in ('matched', 'accepted', 'no_drivers', 'completed') then
    return new;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'ride_push_function_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'ride_push_anon_key';

  if v_url is null or v_key is null then
    raise warning 'send-ride-push is not configured (vault secrets missing); skipping push for ride %', new.id;
    return new;
  end if;

  -- net.http_post queues the request and returns immediately, so a slow or
  -- failing push never blocks or rolls back the ride status update.
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object('ride_id', new.id),
    timeout_milliseconds := 5000
  );

  return new;
end;
$function$;

drop trigger if exists notify_rider_on_ride_status on public.rides;
create trigger notify_rider_on_ride_status
  after update of status on public.rides
  for each row execute function public.notify_rider_on_ride_status();
