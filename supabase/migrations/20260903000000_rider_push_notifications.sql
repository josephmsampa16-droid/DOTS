-- Rider push notifications for the DOTS Taxi mobile app (mobile/dots-taxi-rider).
--
-- Flow: driver changes rides.status -> this trigger -> pg_net POST to the
-- send-ride-push Edge Function -> Expo push to the rider's device.

-- 1. Where the rider's Expo push token lives.
alter table public.profiles add column if not exists push_token text;

-- 2. pg_net gives the trigger a non-blocking outbound HTTP call.
create extension if not exists pg_net;

-- 3. Function URL + the bearer token used to satisfy the Edge Function's
--    verify_jwt check. The anon key is fine here: send-ride-push re-reads the
--    ride and the token server-side with the service role key, so the bearer
--    only proves the caller belongs to this project, it does not decide what
--    gets sent or to whom.
do $$
declare
  v_url text := 'https://rtjzcqdxprrvewtbxgsi.supabase.co/functions/v1/send-ride-push';
  v_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ0anpjcWR4cHJydmV3dGJ4Z3NpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwOTg4NzMsImV4cCI6MjEwMzY3NDg3M30.iZ5_cBx9InDwCG_kh2fhIlVAuikR3TikXHVfIDBdepM';
  v_id  uuid;
begin
  select id into v_id from vault.secrets where name = 'ride_push_function_url';
  if v_id is null then
    perform vault.create_secret(v_url, 'ride_push_function_url', 'send-ride-push Edge Function endpoint');
  else
    perform vault.update_secret(v_id, v_url, 'ride_push_function_url', 'send-ride-push Edge Function endpoint');
  end if;

  select id into v_id from vault.secrets where name = 'ride_push_anon_key';
  if v_id is null then
    perform vault.create_secret(v_key, 'ride_push_anon_key', 'Anon key used as the bearer when calling send-ride-push');
  else
    perform vault.update_secret(v_id, v_key, 'ride_push_anon_key', 'Anon key used as the bearer when calling send-ride-push');
  end if;
end
$$;

-- 4. The trigger itself. net.http_post only queues the request, so a slow or
--    unreachable Edge Function never blocks the driver's status update.
create or replace function public.notify_rider_on_ride_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
  if new.status not in ('matched', 'accepted', 'no_drivers', 'completed') then
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
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object('ride_id', new.id),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

drop trigger if exists notify_rider_on_ride_status on public.rides;
create trigger notify_rider_on_ride_status
after update of status on public.rides
for each row
execute function public.notify_rider_on_ride_status();
