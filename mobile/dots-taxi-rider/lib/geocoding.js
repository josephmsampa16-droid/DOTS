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
export async function lookupAddress(address) {
  const query = address?.trim();
  if (!query) return null;
  try {
    const results = await Location.geocodeAsync(query);
    const hit = results?.[0];
    if (!hit) return null;
    return { latitude: hit.latitude, longitude: hit.longitude };
  } catch {
    return null;
  }
}
