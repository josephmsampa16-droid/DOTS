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
// The OS geocoder searches the whole planet and returns the first hit, so a
// bare "Arcades" resolves to a mall on another continent — which priced a 1km
// Manda Hill trip at K7,651 in testing. Naming the country keeps it local.
// Riders who type a country themselves are left alone.
const REGION_HINT = 'Zambia';

export async function lookupAddress(address) {
  const query = address?.trim();
  if (!query) return null;
  const localised = new RegExp(REGION_HINT, 'i').test(query)
    ? query
    : `${query}, ${REGION_HINT}`;
  try {
    const results = await Location.geocodeAsync(localised);
    const hit = results?.[0];
    if (!hit) return null;
    return { latitude: hit.latitude, longitude: hit.longitude };
  } catch {
    return null;
  }
}
