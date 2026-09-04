import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import {
  registerForPushNotificationsAsync,
  unregisterPushNotificationsAsync,
} from '../lib/notifications';
import { describeCoords, lookupAddress } from '../lib/geocoding';
import DriverMap from '../components/DriverMap';
import DestinationPicker from '../components/DestinationPicker';

// Confirmed against the real Supabase schema — rides.status is constrained
// to exactly these seven values (check constraint on the table):
const STATUS_LABELS = {
  requested: 'Looking for a nearby driver…',
  matched: 'Driver found — waiting for confirmation',
  accepted: 'Driver is on the way',
  completed: 'Trip completed',
  declined: 'Driver unavailable — searching again',
  no_drivers: 'No drivers available right now',
  cancelled: 'Ride cancelled',
};

const TERMINAL_STATUSES = ['completed', 'no_drivers', 'cancelled'];

export default function RiderHomeScreen({ session }) {
  const [location, setLocation] = useState(null);
  const [locationError, setLocationError] = useState(null);
  // Free-text addresses, matching what dots-taxi-rider.html writes: pickup is
  // required, drop-off is optional. The driver app renders both.
  const [pickupAddress, setPickupAddress] = useState('');
  const [destAddress, setDestAddress] = useState('');
  const [prefillingPickup, setPrefillingPickup] = useState(false);
  // Coordinates the rider confirmed on the map. When set, these are used
  // instead of geocoding the typed text — the whole point of the picker.
  const [destCoords, setDestCoords] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [activeRide, setActiveRide] = useState(null);
  const [busy, setBusy] = useState(false);
  const channelRef = useRef(null);

  useEffect(() => {
    registerForPushNotificationsAsync(session.user.id);
    getCurrentLocation();
    checkForActiveRide();
    subscribeToOwnRideUpdates();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  const getCurrentLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setLocationError('Location permission denied — enable it to request a ride.');
      return;
    }
    const pos = await Location.getCurrentPositionAsync({});
    setLocation(pos.coords);

    // Prefill the pickup field so the rider usually just confirms it instead
    // of typing. Leaves the field alone if they already started editing.
    setPrefillingPickup(true);
    const described = await describeCoords(pos.coords);
    setPrefillingPickup(false);
    if (described) {
      setPickupAddress((current) => (current.trim() ? current : described));
    }
  };

  const checkForActiveRide = async () => {
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('rider_id', session.user.id)
      .in('status', ['requested', 'matched', 'accepted'])
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) setActiveRide(data);
  };

  const subscribeToOwnRideUpdates = () => {
    channelRef.current = supabase
      .channel('rider-ride-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rides',
          filter: `rider_id=eq.${session.user.id}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') return;
          const ride = payload.new;
          if (TERMINAL_STATUSES.includes(ride.status)) {
            setActiveRide(ride);
            setTimeout(() => setActiveRide(null), 4000);
          } else {
            setActiveRide(ride);
          }
        }
      )
      .subscribe();
  };

  // Quote as soon as there is a confirmed destination, so the rider sees the
  // price before committing rather than after. The same function runs again in
  // the database on insert, so this is a preview, not the authority.
  useEffect(() => {
    if (!location || !destCoords) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setQuoting(true);
      const { data, error } = await supabase.rpc('quote_fare', {
        p_pickup_lat: location.latitude,
        p_pickup_lng: location.longitude,
        p_dest_lat: destCoords.latitude,
        p_dest_lng: destCoords.longitude,
      });
      if (cancelled) return;
      setQuote(error ? null : data?.[0] ?? null);
      setQuoting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [location, destCoords]);

  const handleDestinationConfirmed = (picked) => {
    setPickerOpen(false);
    setDestCoords({ latitude: picked.latitude, longitude: picked.longitude });
    // Only fill the text box if the rider has not written their own wording;
    // their description of the place is usually better than the geocoder's.
    if (picked.address && !destAddress.trim()) setDestAddress(picked.address);
  };

  const requestRide = async () => {
    if (!location) {
      Alert.alert('Location needed', 'Waiting for your location — try again in a moment.');
      return;
    }
    const pickup = pickupAddress.trim();
    const destination = destAddress.trim();
    if (!pickup) {
      Alert.alert('Pickup needed', 'Enter a pickup address so your driver can find you.');
      return;
    }

    setBusy(true);
    try {
      // A pin the rider confirmed beats anything the geocoder guesses. Only
      // fall back to a text lookup when they never opened the map — and that
      // fallback is exactly the path that can place a destination on the wrong
      // continent, so the fare it produces is guarded server-side.
      const resolvedDest =
        destCoords ?? (destination ? await lookupAddress(destination) : null);

      const { data, error } = await supabase
        .from('rides')
        .insert({
          rider_id: session.user.id,
          status: 'requested',
          pickup_lat: location.latitude,
          pickup_lng: location.longitude,
          pickup_address: pickup,
          dest_address: destination || null,
          dest_lat: resolvedDest?.latitude ?? null,
          dest_lng: resolvedDest?.longitude ?? null,
        })
        .select()
        .single();

      if (error) throw error;
      setActiveRide(data);
      setDestCoords(null);
      setQuote(null);
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelRide = async () => {
    if (!activeRide) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('rides')
        .update({ status: 'cancelled' })
        .eq('id', activeRide.id);
      if (error) throw error;
      setActiveRide(null);
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    // Drop this device's token first — after signOut the RLS policy no longer
    // matches, so the delete would silently affect nothing.
    await unregisterPushNotificationsAsync(session.user.id);
    await supabase.auth.signOut();
  };

  const routeLine = activeRide
    ? 'From ' +
      (activeRide.pickup_address || 'your location') +
      (activeRide.dest_address ? ' to ' + activeRide.dest_address : '')
    : null;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>DOTS Taxi Rider</Text>
          <TouchableOpacity onPress={handleLogout}>
            <Text style={styles.logout}>Log out</Text>
          </TouchableOpacity>
        </View>

        {locationError && <Text style={styles.errorText}>{locationError}</Text>}

        {!activeRide && (
          <View style={styles.requestCard}>
            <Text style={styles.requestTitle}>Ready to go?</Text>

            <Text style={styles.label}>Pickup address</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Manda Hill, Lusaka"
              value={pickupAddress}
              onChangeText={setPickupAddress}
            />

            <Text style={styles.label}>Drop-off address (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Levy Junction, Lusaka"
              value={destAddress}
              onChangeText={setDestAddress}
              returnKeyType="done"
            />

            <TouchableOpacity
              style={[styles.mapButton, !location && styles.buttonDisabled]}
              onPress={() => setPickerOpen(true)}
              disabled={!location}
            >
              <Text style={styles.mapButtonText}>
                {destCoords ? 'Change destination on map' : 'Set destination on map'}
              </Text>
            </TouchableOpacity>

            {destCoords && (
              <View style={styles.quoteCard}>
                {quoting ? (
                  <Text style={styles.quoteMuted}>Working out the fare…</Text>
                ) : quote?.fare != null ? (
                  <>
                    <Text style={styles.quoteFare}>
                      {quote.currency} {Number(quote.fare).toFixed(2)}
                    </Text>
                    <Text style={styles.quoteMuted}>
                      about {Number(quote.distance_km).toFixed(1)} km
                    </Text>
                  </>
                ) : (
                  // Server withheld a price: past max_trip_km, so the pin is
                  // almost certainly not where the rider meant.
                  <Text style={styles.quoteWarn}>
                    That destination looks too far to price
                    {quote?.distance_km
                      ? ` (about ${Number(quote.distance_km).toFixed(0)} km)`
                      : ''}
                    . Check the pin.
                  </Text>
                )}
              </View>
            )}

            <Text style={styles.requestSubtitle}>
              {!location
                ? 'Getting your location…'
                : prefillingPickup
                ? 'Looking up your address…'
                : destCoords
                ? "We'll use your current location as the exact pickup point."
                : 'Set a destination on the map to see the fare before you book.'}
            </Text>

            <TouchableOpacity
              style={[styles.button, !location && styles.buttonDisabled]}
              onPress={requestRide}
              disabled={!location || busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Request Ride</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        <DestinationPicker
          visible={pickerOpen}
          origin={location}
          onCancel={() => setPickerOpen(false)}
          onConfirm={handleDestinationConfirmed}
        />

        {activeRide && (
          <View style={styles.statusCard}>
            <Text style={styles.statusText}>
              {STATUS_LABELS[activeRide.status] || activeRide.status}
            </Text>

            {routeLine && <Text style={styles.routeText}>{routeLine}</Text>}

            {activeRide.status === 'requested' && <ActivityIndicator style={{ marginTop: 12 }} />}

            {['requested', 'matched', 'no_drivers'].includes(activeRide.status) && (
              <TouchableOpacity style={styles.cancelButton} onPress={cancelRide} disabled={busy}>
                <Text style={styles.cancelButtonText}>Cancel Request</Text>
              </TouchableOpacity>
            )}

          </View>
        )}

        {activeRide &&
          activeRide.driver_id &&
          ['matched', 'accepted'].includes(activeRide.status) && (
            <DriverMap ride={activeRide} />
          )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#fff' },
  container: { padding: 20, paddingBottom: 40 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 40,
    marginBottom: 24,
  },
  title: { fontSize: 22, fontWeight: '700', color: '#0a3d91' },
  logout: { color: '#c00', fontSize: 14 },
  errorText: { color: '#c00', marginBottom: 12 },
  requestCard: {
    backgroundColor: '#f5f7fb',
    borderRadius: 12,
    padding: 20,
    marginTop: 24,
  },
  requestTitle: { fontSize: 20, fontWeight: '700', marginBottom: 16 },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8A8578',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  requestSubtitle: { color: '#666', marginBottom: 20, fontSize: 13 },
  button: {
    backgroundColor: '#0a3d91',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  mapButton: {
    borderWidth: 1.5,
    borderColor: '#1B2A6B',
    borderRadius: 10,
    padding: 13,
    alignItems: 'center',
    marginBottom: 12,
  },
  mapButtonText: { color: '#1B2A6B', fontWeight: '700' },
  quoteCard: {
    backgroundColor: '#F4F5FA',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  quoteFare: { fontSize: 26, fontWeight: '800', color: '#111' },
  quoteMuted: { color: '#6B675E', marginTop: 2 },
  quoteWarn: { color: '#B0473F', fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  statusCard: {
    backgroundColor: '#0a3d91',
    borderRadius: 12,
    padding: 24,
    marginTop: 40,
    alignItems: 'center',
  },
  statusText: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  routeText: {
    color: '#cfe0ff',
    fontSize: 13,
    marginTop: 10,
    textAlign: 'center',
    lineHeight: 18,
  },
  cancelButton: { marginTop: 20 },
  cancelButtonText: { color: '#ffb3b3', fontSize: 14 },
});
