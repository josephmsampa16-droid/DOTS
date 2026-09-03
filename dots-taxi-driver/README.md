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

## Push notifications

Realtime only delivers while the app is running. A driver whose app is fully
closed is reached by push instead:

```
rides.status -> 'matched'
  -> notify_rider_on_ride_status trigger (AFTER UPDATE OF status)
    -> net.http_post -> send-ride-push edge function
      -> Expo -> driver's phone ("New ride request")
```

Most of this was already live for riders. What was added is the **driver** leg:
`send-ride-push` previously notified only the rider, so `matched` told the rider
"driver found" while the driver themselves got nothing.

- `lib/push.js` registers the device and stores the token on
  `profiles.push_token`, clearing it at logout so a signed-out handset stops
  receiving requests.
- Android gets a dedicated `ride-requests` channel at MAX importance, so a
  request is a heads-up alert with sound rather than a silent tray entry.
  **Channel importance is fixed when the channel is first created** — changing
  it in code later has no effect on an already-installed app, so bump the
  channel id if you ever need to change it.
- The edge function sends `priority: 'high'` so Android wakes the device
  instead of batching the notification.
- Dead tokens (`DeviceNotRegistered`, e.g. after an uninstall) are cleared
  automatically.

### Required before push works

`getExpoPushTokenAsync` needs an EAS project id, and `app.json` has none yet:

```sh
npx eas init      # writes extra.eas.projectId into app.json
```

Until that exists the app logs a warning and runs fine without push. Push also
needs a dev build and a physical device — tokens are not issued to simulators,
and Expo Go cannot receive them for a project it doesn't own.

`ride_push_function_url` and `ride_push_anon_key` are already set in Vault on
the live project; `supabase/migrations/20260903000000_ride_push_pipeline.sql`
documents the trigger side.

## Not built yet

- Map view for pickup / navigation handoff.
- Fare, ratings, ride history.
- Ride request timeout — nothing currently re-matches a ride if the driver
  never answers, so it sits in `matched` until they do.
