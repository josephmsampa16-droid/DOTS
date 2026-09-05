# DOTS Taxi — next features

Captured 5 September 2026 from Joseph's brief. Reference screenshots were from
another operator's app; the *principle* is what we take, the design stays DOTS Blue.

## 1. Pickup is the rider's current location — typing is the exception
**Already true in part.** The rider app reads the device location and prefills
the pickup text. **Gap:** the booking always sends the *device* coordinates,
even when the rider edits the pickup text — so a typed pickup is cosmetic today.
- Geocode a typed pickup (same bounded lookup the drop-off uses) and send *those* coordinates.
- Clear "Use my location" control to snap back.

## 2. Booking for someone else — the passenger is a field
When the pickup is not the rider's own location, or they say it is for someone
else: capture **passenger name + phone**. This is the seam for **parcel sending**
later (sender / recipient / item), so it lands on the ride row now
(`passenger_name`, `passenger_phone`, `booked_for_self`).

## 3. Searching screen: map, pulse, and how many drivers are near
While a ride is `requested`/`matched`, show the map centred on the pickup with
a searching animation and **"N drivers nearby"**.
- Needs an RPC `available_drivers_near(lat, lng, radius_km)` — riders cannot read
  other people's taxis under RLS, so the *count* is served by a `SECURITY DEFINER`
  function that returns a number, never rows.
- Same count shown *before* booking, next to the quote.

## 4. Rider's contact details on the driver's side
During an active ride the driver sees the rider's **name and phone** (from the
profile they signed up with — or the passenger fields from §2 when booked for
someone else) with a tap-to-call. Only while the ride is live; hidden after.

## 5. Driver profile on the rider's side
After matching: **name, photo, car, plate, rating, rides completed**. Before
booking there is no driver yet, so show the nearby count (§3) and, once ratings
exist, the average rating of drivers nearby. Needs driver photo upload (§8's
storage bucket).

## 6. Lusaka only, for now
Bookings whose pickup is outside Lusaka are refused with:
> DOTS is not yet available in your city. It is coming soon — you will be able to book here.
- **Decided (Joseph, 5 Sep):** service area = Lusaka circle **30 km** from Cairo
  Road (-15.4167, 28.2833), **plus Chongwe** as a pocket of 10 km around
  (-15.3292, 28.6820), **plus Chilanga** named explicitly (it is already inside
  the Lusaka circle at ~16 km). Kafue is out for now. Store the areas in a
  `service_areas` table (name, centre, radius) so adding a town is a row, not code.
  Enforce in the database (`rides` insert check) and explain in the app before
  the rider types anything.
- Also closes the far-away geocoding problem from a different side.

## 7. Driver ratings with tags — the brand
After every completed ride the rider rates the driver (1–5) and picks tags:
polite · clean car · no loud music · offered water · good conversation · good
music (final list: decision). Aggregate to the driver's rating and tag counts,
shown on their profile (§5) and in their own Account tab.
- New tables: `ride_ratings` (one per ride, rider-written), `driver_rating_summary`
  (trigger-maintained). The existing `vehicle_ratings` on the car-hire side may
  be reusable — check before building new.
- Purpose stated plainly: DOTS drivers are professional; the rating is how that
  is kept true.

## 8. Vehicle photos + admin approval before a car goes online
At registration the driver uploads photos of the vehicle. Staff approve or
decline from the office; **an unapproved vehicle cannot go Online**.
- Supabase Storage bucket `vehicle-photos` (driver writes own folder; staff read all).
- `taxis.approval_status` (`pending` / `approved` / `declined`) + `declined_reason`.
- Approval screen in the staff web app (Staff role already exists).
- Dispatch and the Online toggle gate on `approved`.

## Suggested order
1. ~~§6 geofence + §3 nearby count + §4 rider contact + §5 driver card~~ **done 5 Sep**
2. ~~§1 typed-pickup fix + §2 passenger fields~~ **done 5 Sep**
3. §7 ratings
4. §8 photos + approval
5. Parcels, on top of §2

## Decisions needed from Joseph
- ~~Lusaka boundary~~ — decided, see §6.
- Final tag list for ratings.
- Does a declined vehicle get a reason shown to the driver? (recommend yes)
- Support phone number for the Account screens.

## Still open from before
- Real per-km rates, token price and road factor (all placeholders).
- `eas init` + Firebase + Apple credentials before the real build (push).
