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

## Not built yet: MoMo top-up

Buying tokens still has to be wired to the existing MTN integration
(`mtn-initiate-payment` / `mtn-check-payment` and the `momo_transactions`
table). The pieces needed:

1. A driver-facing function that starts a Request to Pay for
   `tokens x token_price` and records the intended token count.
2. Crediting on confirmation — `mtn-check-payment` currently marks a booking
   Confirmed and writes to `payments`; it needs a branch that calls
   `adjust_tokens(..., 'topup', momo_transaction_id => ...)` instead when the
   transaction is a token purchase.
3. Both existing functions are **Staff only**. Drivers must be allowed to buy
   their own tokens, so that check has to change for the top-up path.

`token_ledger.momo_transaction_id` already exists to tie a credit back to the
payment that produced it.
