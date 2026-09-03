# DOTS Taxi Driver — React Native (Expo)

Native driver app for the DOTS taxi system. It talks to the **same Supabase
backend as the web apps** (`dots-bookings`, ref `rtjzcqdxprrvewtbxgsi`) — same
tables, same RLS, same Realtime. No backend changes.

The reason this exists: the web driver app has to stay open in the foreground to
keep pushing location, because mobile browsers throttle `watchPosition` when
backgrounded. This app uses a native background location task instead.

## Running it

```sh
npm install
npx expo start
```

Supabase URL and anon key are already wired up in `lib/supabase.js` (the same
public values `index.html` ships — RLS is what protects the data).

Expo Go is fine for auth, the ride flow and foreground location. **Background
location needs a dev build**, not Expo Go:

```sh
npx expo run:android   # or: npx expo run:ios
```

## What it does

- Email/password auth. Signup sets `intended_role: 'Driver'`, which the
  `handle_new_user` trigger turns into a `Driver` profile row.
- Vehicle registration — plate/model/colour into `taxis`, same as the web app's
  "add my taxi" step. A driver with no `taxis` row cannot go online and cannot
  be matched, so this screen comes first.
- Go Online/Offline, writing `taxis.status` plus a location fix.
- Background location updates every ~8s into `taxis.current_lat/current_lng/
  last_location_update` (same cadence as the web app's throttle).
- Incoming ride request card over Realtime on `rides` filtered to
  `driver_id = you`, with Accept / Decline, and a Complete step for the
  accepted ride.

## Schema notes (verified against the live database)

These correct a few claims in the original scaffold's README:

- **Driver location lives on `taxis`**, keyed by `driver_user_id` — not on
  `profiles`. `profiles` has no lat/lng columns. ✅ as documented before.
- **`decline_ride(ride_id_in uuid)` does exist.** The earlier scaffold said it
  didn't and wrote `status = 'no_drivers'` directly on decline. That is wrong:
  the RPC sets the ride to `declined` and then re-runs
  `match_nearest_driver(ride_id, exclude => [this driver])` so the ride goes to
  the next-nearest driver. Writing `no_drivers` by hand dead-ends the ride for
  the rider. This app calls the RPC.
- **`match_nearest_driver` skips taxis with a NULL `current_lat`/`current_lng`**,
  even when `status = 'Online'`. So going online has to write a location fix in
  the same update — otherwise the driver is invisible to matching until the
  first background update lands. The web app does this; the scaffold did not.
- **`profiles` does have a `push_token` column** (the scaffold said it didn't),
  so server-side push is wireable without a migration. Not wired up yet.
- **`handle_new_user` only copies `name` and `intended_role`** — `phone` from the
  signup form is dropped. `App.js` backfills `profiles.phone` from user metadata
  on first authenticated run. It touches only `phone`; the
  `prevent_role_self_promotion` trigger rejects any self-change to `role`.
- `rides.status` is constrained to exactly: `requested`, `matched`, `accepted`,
  `declined`, `no_drivers`, `cancelled`, `completed`.

## Ride completion

Neither web app currently sets `completed`. That matters because
`match_nearest_driver` excludes any driver holding a ride in `matched` or
`accepted` — so a driver who accepts one ride is never matched again. This app
adds a "Complete ride" button to close that loop. The web driver app has the
same gap and still needs the equivalent.

## Not built yet

- Push notifications for ride requests when the app is fully closed. The
  foreground service keeps location alive, but a closed app needs
  `expo-notifications` writing `profiles.push_token` plus a server-side trigger
  on `rides` (there is already a `notify_rider_on_ride_status` trigger to model
  it on).
- Map view for pickup / navigation handoff.
- Fare, ratings, ride history.
