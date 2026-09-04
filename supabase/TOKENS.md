# Driver tokens

## Why tokens rather than a commission

Riders pay drivers in cash. There is no card rail in the transaction, so the
platform cannot take a percentage of a fare it never touches. Instead the driver
buys tokens up front and spends one per completed ride. The commission is
collected before the work, not skimmed from it.

## How it works

| Table | Role |
| --- | --- |
| `driver_wallets` | current balance, read by dispatch on every match |
| `token_ledger` | append-only history of every movement |
| `pricing.token_price` | what one token costs (placeholder K5.00) |

Two tables rather than one because they do different jobs. The wallet is on the
hot path — dispatch reads it for every candidate driver — so it must be a single
cheap lookup. The ledger is the audit trail. Without it, a driver asking "why am
I on 3 tokens?" has no answer, and for anything touching a driver's money that
is not acceptable.

Tokens move only through `adjust_tokens()`, which locks the wallet row, applies
the delta and writes the ledger entry in one transaction. No client can write
either table directly; RLS grants `select` only, and a driver sees only their
own rows.

## When a token is spent

On **completion**, not on accept. A ride that is cancelled, declined or times
out costs the driver nothing. Burning a token on a ride that never happened is
the fastest way to lose drivers.

Charging is idempotent: a unique index on `(ride_id) where reason = 'ride'`
means a status set to `completed` twice still bills once.

## Dispatch gate

`match_nearest_driver()` requires `token_balance > 0`. A driver on empty stops
receiving offers rather than driving rides that cannot be charged for. Verified
against the live function — same driver, same location, only the balance
changed:

| Scenario | Outcome |
| --- | --- |
| Online, 0 tokens | `no_drivers`, no driver assigned |
| Online, 1 token | `matched` |

Balances may go negative. A ride already driven must always be recorded, and
refusing the deduction to hold a floor of zero would lose the record of real
work. A negative driver simply receives no offers until they top up.

## Existing drivers were given 20 tokens

Adding the gate to a live system would otherwise have stopped matching every
current driver instantly, with nothing on screen to explain it. The grant is in
the ledger as `signup_bonus`.

## The flat-token trade-off

One token per ride, as specified. Worth restating with real fares attached,
because the effect is sharp:

| Ride | Fare | Token cost at K5 | Effective commission |
| --- | --- | --- | --- |
| Manda Hill -> Arcades | K16.12 | K5 | **31%** |
| CBD -> Kabulonga | K48.34 | K5 | 10% |
| Manda Hill -> KK Airport | K108.73 | K5 | **4.6%** |

A driver loses far more, proportionally, on short trips. The rational response
is to decline them and wait for airport runs — which works against affordable
short rides being available at all.

Two ways to fix it without abandoning tokens:

- **Tier by distance.** 1 token under 5km, 2 up to 15km, 3 above. Still simple
  to explain, flattens the curve considerably.
- **Price the token lower and sell bigger bundles.** A K2 token is 12% of the
  short fare rather than 31%.

Neither requires a schema change — tiering is a few lines in
`charge_ride_token()`, and the price is a column.

## Buying tokens (MTN Mobile Money)

Two edge functions, both driver-scoped:

| Function | Does |
| --- | --- |
| `driver-buy-tokens` | starts a Request to Pay; MTN pushes a PIN prompt to the driver's phone |
| `driver-check-topup` | polled after; credits the tokens the first time MTN reports SUCCESSFUL |

They are separate from `mtn-initiate-payment` / `mtn-check-payment` rather than
extra branches inside them. Those two are staff-only and handle bookings;
widening their auth so drivers could call them would also let any driver poll
every booking payment in the system. Two narrower functions keep the blast
radius small.

### What is protected, and how

**The price is never taken from the request.** The client says how many tokens;
`driver-buy-tokens` reads `pricing.token_price` and computes the amount. A
client that could name its own amount could buy 100 tokens for one ngwee — the
same reasoning that keeps fares server-side.

**A driver can only act on their own account.** `driver_id` comes from the
verified JWT, never from the body, on both functions.

**One payment credits once.** Guarded twice: the function checks the stored
status first, and a unique index on
`token_ledger(momo_transaction_id) where reason = 'topup'` means two polls
racing cannot both succeed — the second insert is refused by the database
rather than relying on the code winning the race.

**The transaction row is written before the request goes out.** If MTN accepts
the payment but the response never arrives, the row still exists and can be
polled. Losing a driver's money to a dropped connection is not an acceptable
failure.

### Verified end to end against MTN sandbox

| Case | Result |
| --- | --- |
| Rider calls `driver-buy-tokens` | `Drivers only` (403) |
| quantity 0 / 9999 | rejected, 1-500 |
| malformed phone | rejected |
| Driver buys 5 tokens | RTP created, amount 25.00 (5 x K5) |
| First poll | `SUCCESSFUL, credited: true`, balance 5 |
| Second poll | `SUCCESSFUL`, balance still 5 |
| Polling an unknown reference | `Transaction not found` |
| Two credits for one payment (DB level) | second refused, one ledger row |

Sandbox reports EUR whatever the real currency — a documented MTN quirk. In
production the currency comes from `MTN_CURRENCY` or the price list.

## Security: privileged functions are not public

Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
exposes every public function over PostgREST. The anon key is published in
`index.html`, so a function left at the default is callable by anyone on the
internet.

This was found by trying it, not by reading the code: an unauthenticated caller
holding only the public anon key ran `adjust_tokens` and minted 500 tokens.

| Function | Who may call it now |
| --- | --- |
| `adjust_tokens` | `service_role` only (edge functions); triggers reach it as definer |
| `match_nearest_driver` | `service_role` only; triggers reach it as definer |
| `decline_ride` | `authenticated`, and only for a ride assigned to the caller |
| `quote_fare` | `authenticated` |

`decline_ride` also gained an ownership check. It never verified who was
calling, so any signed-in user could decline anybody else's ride.

Verified after the change: anonymous calls to all three privileged functions
return `permission denied`, a signed-in driver cannot mint their own tokens,
`quote_fare` still works for a signed-in user, and a ride insert still
dispatches through the trigger.

**Any new function that touches money or dispatch needs the same treatment.**
The default is open, so this is a step to remember, not something that happens
on its own.

### Still to do

- **No UI yet.** The driver app has no "Buy tokens" screen; the functions are
  callable but nothing calls them. That is the next piece.
- **Production credentials.** `MTN_ENVIRONMENT` is still `sandbox`. Going live
  needs the production subscription key, API user and key, and
  `MTN_ENVIRONMENT=production`.
- **Airtel Money is not covered.** A large share of Zambian drivers are not on
  MTN, and today they cannot buy tokens at all.
