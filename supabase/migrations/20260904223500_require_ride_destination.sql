-- A ride with no destination cannot be priced, so it reached the driver as
-- "Not priced" and still cost them a token. The fare is the product; a ride
-- that skips it is a roadside haggle with a token spent on it.
--
-- The coordinates are what the constraint guards, not the address text: they
-- are what quote_fare() measures. A rider may still describe the place in
-- their own words, or in none at all if they picked it on the map.
--
-- NOT VALID so the rides already recorded without a destination stay as
-- history. It still applies to every insert and update from here on, which is
-- the part that matters.
alter table public.rides
  add constraint rides_require_destination
  check (dest_lat is not null and dest_lng is not null)
  not valid;
