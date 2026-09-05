-- The commission rate belongs to the driver, and no driver is known when a
-- ride is created — so the split is settled at completion, against whoever
-- actually did the work. A fleet driver's negotiated rate overrides the band.
create or replace function public.driver_commission_rate(p_driver_id uuid)
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  override_rate numeric;
  lvl text;
  band_rate numeric;
begin
  select commission_rate_override, driver_level
    into override_rate, lvl
  from profiles where id = p_driver_id;

  if override_rate is not null then
    return override_rate;
  end if;

  select rate into band_rate from commission_levels where level = coalesce(lvl, 'new');

  -- An unknown level must never silently become free work for the platform or
  -- a surprise charge for the driver; fall back to the tier's own rate.
  if band_rate is null then
    select commission_rate into band_rate from pricing where active and tier = 'standard' limit 1;
  end if;

  return coalesce(band_rate, 0.1500);
end;
$function$;

revoke all on function public.driver_commission_rate(uuid) from public;
grant execute on function public.driver_commission_rate(uuid) to authenticated, service_role;

-- Stamped onto the ride so the split is a record, not a recalculation: a rate
-- change next month must not rewrite what a driver earned last week.
create or replace function public.settle_ride_commission()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  rate numeric;
  comm numeric;
begin
  if new.status = 'completed'
     and old.status is distinct from 'completed'
     and new.driver_id is not null
     and new.fare is not null
     and new.commission_amount is null then
    rate := driver_commission_rate(new.driver_id);
    comm := round((new.fare * rate)::numeric, 2);
    update rides
       set commission_rate = rate,
           commission_amount = comm,
           driver_payout = round((new.fare - comm)::numeric, 2)
     where id = new.id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_settle_ride_commission on public.rides;
create trigger trg_settle_ride_commission
  after update of status on public.rides
  for each row execute function public.settle_ride_commission();
