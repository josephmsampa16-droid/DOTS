-- The original quote_fare took double precision. The hybrid one takes numeric
-- plus a tier, so both existed at once and PostgREST could not choose between
-- them — every rider quote failed with "could not choose the best candidate
-- function" until this drop. There must only ever be one.
drop function if exists public.quote_fare(double precision, double precision, double precision, double precision);
