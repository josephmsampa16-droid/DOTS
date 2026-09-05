-- §2: a ride booked on someone's behalf names the person who will actually be
-- in the car, so the driver greets and calls the passenger, not the booker.
-- This is also the seam parcels will use: sender, recipient, what is carried.
alter table public.rides
  add column if not exists booked_for_self boolean not null default true,
  add column if not exists passenger_name text,
  add column if not exists passenger_phone text;

-- Booking for someone else without saying who is not a booking.
alter table public.rides drop constraint if exists rides_passenger_named_check;
alter table public.rides add constraint rides_passenger_named_check
  check (booked_for_self or (nullif(trim(passenger_name), '') is not null and nullif(trim(passenger_phone), '') is not null));
