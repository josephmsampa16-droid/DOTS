-- rides.pickup_lat and friends are double precision, while quote_fare now
-- takes numeric. With the old double-precision overload dropped, the trigger
-- had no function to call and every booking failed. Cast explicitly rather
-- than relying on an overload existing to catch it.
create or replace function public.set_ride_fare()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare q record;
begin
  select * into q from quote_fare(new.pickup_lat::numeric, new.pickup_lng::numeric,
                                  new.dest_lat::numeric, new.dest_lng::numeric,
                                  coalesce(new.service_tier, 'standard'));
  new.distance_km       := q.distance_km;
  new.duration_min      := q.duration_min;
  new.fare              := q.fare;
  new.currency          := q.currency;
  new.pricing_id        := q.pricing_id;
  new.demand_multiplier := q.demand_multiplier;
  return new;
end;
$function$;
