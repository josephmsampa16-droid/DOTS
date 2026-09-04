# Fares and the business model

## How a fare is calculated

```
straight_km = haversine(pickup, destination)      -- as the crow flies
road_km     = straight_km x road_factor           -- roads are not straight
fare        = max(minimum_fare, base_fare + per_km x road_km)
```

All of it runs in the database (`quote_fare()`), and a `before insert` trigger on
`rides` recomputes the fare server-side. Whatever price the app sends is
discarded — a rider app that could name its own price would be trivial to cheat.

Rates live in the `pricing` table, so prices change with an `insert`, not a
release. To change them, add a new row and deactivate the old one; old rides keep
pointing at the price list they were quoted under, so historical fares stay
explainable.

```sql
update pricing set active = false where active;
insert into pricing (base_fare, per_km, minimum_fare, road_factor, note)
values (12.00, 4.00, 18.00, 1.40, 'Feb 2026 revision');
```

## Current rates — PLACEHOLDERS, NOT RESEARCHED

| Field | Value | Meaning |
| --- | --- | --- |
| `base_fare` | K10.00 | charged on every trip |
| `per_km` | K4.50 | per km of estimated road distance |
| `minimum_fare` | K15.00 | floor for very short trips |
| `road_factor` | 1.40 | straight-line -> road distance |

These are a starting point so the maths could be tested end to end. **They are
not based on real Lusaka market data** and should be replaced with rates set from
actual local knowledge.

What they currently produce:

| Route | Straight | Road est. | Fare |
| --- | --- | --- | --- |
| Manda Hill -> Arcades | 0.97 km | 1.36 km | K16.12 |
| Cairo Rd -> Manda Hill | 4.84 km | 6.78 km | K40.51 |
| CBD -> Kabulonga | 6.09 km | 8.52 km | K48.34 |
| Manda Hill -> KK Airport | 15.67 km | 21.94 km | K108.73 |

## How to undercut the competition without underpaying drivers

The lever is **commission, not driver pay**. Platforms of this type commonly take
around 15-20% of the fare. If DOTS takes ~10% through tokens, fares can be set
roughly 8-10% below theirs while the driver still nets the same or more. Cutting
the per-km rate instead just moves the loss onto the driver.

## `road_factor` needs calibrating

`haversine_km` is straight-line distance. Real roads wander, so the fare
multiplies by `road_factor` to approximate driving distance. **1.40 is an
estimate, not a measurement.** Set it too low and every fare underpays the
driver — the exact outcome to avoid.

To calibrate: take ~20 real completed trips, compare each car's actual odometer
distance against `distance_km`, and set `road_factor` to the average ratio.
Better still, replace the estimate with a routing API (Google Directions,
Mapbox, OSRM) that returns true road distance. That costs money per request but
removes the guesswork.

## Known gap: destinations often have no coordinates

`quote_fare()` returns a null distance and fare when the destination has no
lat/lng, and that is the common case today: the OS geocoder frequently cannot
place informal Zambian addresses ("Plot 42, off Great East Road"). No
coordinates means no distance, which means no fare.

Free-text destinations cannot carry distance pricing. The rider app needs a map
destination picker — drop a pin, get coordinates — before up-front pricing works
for most trips.
