# DOTS Taxi Rider — React Native (Expo)

Rider app for DOTS Taxi. Same Supabase backend (`dots-bookings`,
`rtjzcqdxprrvewtbxgsi`) as the driver app and the two web apps in the repo root
— no backend rewrite.

## Running it

1. `npm install` in this folder.
2. `npx expo start`.

`lib/supabase.js` already points at the live project with the public anon key —
the same one already embedded in `index.html` and `dots-taxi-rider.html`, so
this is no wider an exposure than the web apps already carry. Everything is
gated by RLS.

Expo Go is enough for the core ride flow (no background location needed). Push
notifications need one extra step — see below.

## What's built

- Email/password auth (`intended_role: 'Rider'`, matches the `handle_new_user` trigger)
- Foreground location for the pickup point
- Pickup + drop-off address entry, matching what `dots-taxi-rider.html` writes
  and what the driver app renders (see next section)
- Request Ride / Cancel Request, writing to `rides`
- Realtime subscription to the rider's own ride row — status flows through as
  the driver progresses
- Push notifications, end to end (see below)

## Push notifications

The full path is live and was tested against the real project:

```
driver changes rides.status
  -> notify_rider_on_ride_status trigger (public.rides)
  -> pg_net POST
  -> send-ride-push Edge Function
  -> Expo push API
  -> rider's device
```

Pieces, all committed at the repo root under `supabase/`:

- `supabase/migrations/20260903000000_rider_push_notifications.sql` — adds
  `profiles.push_token`, enables `pg_net`, stores the function URL + bearer in
  Vault, and creates the trigger. **Already applied** to the live project.
- `supabase/functions/send-ride-push/index.ts` — **already deployed** as
  `send-ride-push` (verify_jwt on).

Pushes are sent for `matched`, `accepted`, `no_drivers` and `completed`.
`declined` is skipped on purpose (dispatch immediately re-searches, so a push
there alarms the rider over a non-event) and so is `cancelled` (the rider's own
action).

The trigger only passes a ride id. The Edge Function re-reads the ride's real
status and the rider's token with the service role key, so a caller holding
nothing but the public anon key cannot forge the message text or push to a
token of their choosing. Dead tokens (`DeviceNotRegistered`, e.g. after an
uninstall) are cleared from `profiles.push_token` automatically.

`net.http_post` only queues the request, so a slow or unreachable function
never blocks the driver's status update.

### The one thing left to do: an EAS project id

Expo SDK 51 requires an EAS project id before it will issue a push token. Run
`eas init` in this folder and add the result to `app.json`:

```json
"extra": { "eas": { "projectId": "<the id eas init prints>" } }
```

Until then `registerForPushNotificationsAsync` logs a warning and returns —
the rest of the app works, tokens just are not collected. Push tokens are also
never issued on a simulator; test on a physical device.

## Addresses

Deliberately the same contract as the rider web app, so both clients behave
identically and the driver app needs no changes:

- **Pickup address** — required free text. The exact pickup point is still the
  device's GPS fix (`pickup_lat/pickup_lng`); the text is what the driver reads.
- **Drop-off address** — optional free text, stored in `dest_address`.

The driver app already renders both (`index.html` shows "Pickup: … / Drop-off:
…" on a matched ride), so nothing on that side needed touching.

Two things mobile does that the web app can't:

- The pickup field is **prefilled** by reverse-geocoding the GPS fix, so the
  rider usually just confirms it instead of typing. If they have already typed
  something, the prefill leaves it alone.
- The drop-off text is **forward-geocoded** to fill `dest_lat/dest_lng`, which
  the web app leaves null. The live driver map will want those.

Both use `expo-location`'s built-in OS geocoder — no API key, no billing. Both
are strictly best-effort: informal Lusaka addresses ("Plot 42, off Great East
Road") often will not resolve, so a failed lookup just leaves the coordinates
null and the typed text stands on its own. Geocoding never blocks a ride
request, and `lib/geocoding.js` returns null rather than throwing.

## Known consideration: who can read push tokens

The existing `profiles` RLS policy "Logged-in users can view profiles" lets any
authenticated user select every profile row — which now includes `push_token`.
An Expo push token is enough to send that device arbitrary notifications
through Expo's public API, so a signed-up user could spoof a "Your driver is
here" alert at another user.

This was not changed here because narrowing it touches the live driver and web
apps. Two ways to close it when you want to:

- Move tokens to a `push_tokens` table with an own-row-only RLS policy (the
  Edge Function reads it with the service role key either way), or
- Replace the blanket-select policy with one scoped to profiles the caller
  actually needs to see.

## Not yet built

- Live map of the driver's position en route. `react-native-maps` is already in
  `package.json`, and `taxis.current_lat/current_lng` plus the existing
  "Riders see taxi of their matched driver" RLS policy give you the data —
  subscribe to Realtime on `taxis` filtered by the matched `driver_id`. The
  placeholder is marked in `RiderHomeScreen.js`.
- Fare estimate / payment
- Ride history screen

## Schema notes (verified live)

- `rides` columns: `rider_id, driver_id, pickup_lat, pickup_lng, pickup_address,
  dest_lat, dest_lng, dest_address, status, requested_at, matched_at,
  accepted_at, updated_at`. There is **no** `created_at` — order by
  `requested_at` (the scaffold's `checkForActiveRide` had this wrong and it is
  fixed here).
- `rides.status` is constrained to exactly: `requested, matched, accepted,
  declined, no_drivers, cancelled, completed`.
- An existing `trg_match_on_ride_request` trigger runs the dispatcher on insert,
  so a new ride can leave `requested` within the same second.
