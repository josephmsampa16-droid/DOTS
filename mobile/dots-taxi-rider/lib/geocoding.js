import * as Location from 'expo-location';

// Thin wrappers around expo-location's built-in geocoder. It uses the OS
// geocoder (CoreLocation / Android Geocoder), so there is no API key and no
// billing to set up — but it also means results are best-effort, and in
// Lusaka plenty of real destinations ("Plot 42, off Great East Road") will
// not resolve at all. Everything here degrades to null rather than throwing:
// the free-text address the rider typed is the source of truth, coordinates
// are a bonus.

// Builds a short human-readable line from a reverse-geocode result, skipping
// blanks and repeats (the OS often returns the same value for name/street).
function formatPlace(place) {
  if (!place) return null;
  const parts = [place.name, place.street, place.city ?? place.district ?? place.subregion];
  const seen = new Set();
  const line = parts
    .filter((part) => {
      if (!part) return false;
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
  return line || null;
}

// Coordinates -> readable address, for prefilling the pickup field.
export async function describeCoords(coords) {
  if (!coords) return null;
  try {
    const places = await Location.reverseGeocodeAsync({
      latitude: coords.latitude,
      longitude: coords.longitude,
    });
    return formatPlace(places?.[0]);
  } catch {
    return null;
  }
}

// Address -> coordinates, to fill rides.dest_lat/dest_lng when we can. Returns
// null whenever the geocoder has nothing useful, which is expected and fine.
// The OS geocoder searches the whole planet and returns its guesses in its own
// order, so a bare "Arcades" resolves to a mall on another continent — which
// priced a 1km Manda Hill trip at K7,651 in testing. Naming the country helps,
// but it is only a hint: "Chawama Lusaka, Zambia" still came back hundreds of
// kilometres away. So the hint is backed by a hard filter.
const REGION_HINT = 'Zambia';

// Zambia's bounding box, generously drawn. Anything outside it is not a place
// in this country and cannot be a taxi destination, whatever the geocoder
// thinks — this is the check that actually holds, rather than hoping the
// geocoder honours the country in the query string.
const ZAMBIA_BOUNDS = {
  minLat: -18.2,
  maxLat: -8.1,
  minLng: 21.9,
  maxLng: 33.8,
};

function insideZambia({ latitude, longitude }) {
  return (
    latitude >= ZAMBIA_BOUNDS.minLat &&
    latitude <= ZAMBIA_BOUNDS.maxLat &&
    longitude >= ZAMBIA_BOUNDS.minLng &&
    longitude <= ZAMBIA_BOUNDS.maxLng
  );
}

// Rough distance, only ever used to rank candidates against each other.
function roughDistance(a, b) {
  const dLat = a.latitude - b.latitude;
  const dLng = (a.longitude - b.longitude) * Math.cos((a.latitude * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// Address -> coordinates, to fill rides.dest_lat/dest_lng. Returns null when
// nothing credible is found, which the caller shows as "set it on the map"
// rather than pricing a guess.
//
// `near` is the rider's pickup point. Ride destinations are overwhelmingly
// local, so when the geocoder offers several candidates the nearest one is
// almost always the intended one — taking its first result instead is what
// sends a township trip to another province.
export async function lookupAddress(address, near = null) {
  const query = address?.trim();
  if (!query) return null;

  const localised = new RegExp(REGION_HINT, 'i').test(query)
    ? query
    : `${query}, ${REGION_HINT}`;

  try {
    const results = await Location.geocodeAsync(localised);
    const candidates = (results ?? [])
      .map((r) => ({ latitude: r.latitude, longitude: r.longitude }))
      .filter(insideZambia);

    if (candidates.length === 0) return null;
    if (!near) return candidates[0];

    return candidates.sort((a, b) => roughDistance(a, near) - roughDistance(b, near))[0];
  } catch {
    return null;
  }
}
