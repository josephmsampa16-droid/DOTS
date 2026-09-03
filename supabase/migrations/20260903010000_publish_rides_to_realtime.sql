-- rides was never added to the supabase_realtime publication, so no
-- postgres_changes subscription on it has ever fired — even though all three
-- clients subscribe to one:
--
--   index.html            -> driver_id=eq.<driver>  (new requests for a driver)
--   dots-taxi-rider.html  -> rider_id=eq.<rider>    (status updates for a rider)
--   mobile/dots-taxi-rider -> rider_id=eq.<rider>   (same, plus the driver map)
--
-- taxis was already published, which is why the staff live-taxi view works.
alter publication supabase_realtime add table public.rides;

-- Realtime only ships the full old record for UPDATE events when the table
-- replicates every column. rides is low volume, so the extra WAL is
-- negligible and it keeps RLS evaluation on updates unambiguous.
alter table public.rides replica identity full;
