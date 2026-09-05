# send-ride-push

Expo push fan-out for ride status changes. Invoked by the
`notify_rider_on_ride_status` trigger on `public.rides` via `pg_net`.

Reads tokens from `public.push_tokens` (token primary key, many rows per user).
An earlier revision read `profiles.push_token`; that column was dropped by the
`move_push_tokens_out_of_profiles` migration and this function was updated to
match — if pushes ever stop entirely, check that this function and the token
storage still agree.

Deploy:

```sh
supabase functions deploy send-ride-push --project-ref rtjzcqdxprrvewtbxgsi
```

`verify_jwt` stays true; the trigger passes the anon key as a bearer token and
all message content is re-derived server-side from the ride id.
