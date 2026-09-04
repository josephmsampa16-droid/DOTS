import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Switch,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { supabase } from '../lib/supabase';
import { unregisterPushNotifications } from '../lib/push';
import { LOCATION_TASK_NAME } from '../tasks/locationTask';

// Matches the ~8s throttle the web driver app uses.
const LOCATION_INTERVAL_MS = 8000;

// Must match expire_stale_ride_offers(45) on the server. The sweep runs every
// 15s, so the real cutoff is 45-60s — the countdown is the driver's guide, the
// server is the authority.
const OFFER_TIMEOUT_SECONDS = 45;

export default function DriverHomeScreen({ session }) {
  const driverId = session.user.id;

  const [taxi, setTaxi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeRide, setActiveRide] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);

  const [plate, setPlate] = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');

  const channelRef = useRef(null);

  const isOnline = taxi?.status === 'Online';

  const fetchTaxi = useCallback(async () => {
    // A driver may not have registered a vehicle yet, so no .single() here —
    // it errors on zero rows.
    const { data, error } = await supabase
      .from('taxis')
      .select('*')
      .eq('driver_user_id', driverId)
      .limit(1);
    if (error) {
      Alert.alert('Error', error.message);
      return;
    }
    setTaxi(data?.[0] || null);
  }, [driverId]);

  // Refetch rather than trusting a single payload: this also recovers the
  // current ride after a missed realtime event or an app restart.
  const fetchActiveRide = useCallback(async () => {
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('driver_id', driverId)
      .in('status', ['matched', 'accepted'])
      .order('requested_at', { ascending: false })
      .limit(1);
    setActiveRide(data?.[0] || null);
  }, [driverId]);

  useEffect(() => {
    (async () => {
      await Promise.all([fetchTaxi(), fetchActiveRide()]);
      setLoading(false);
    })();

    // Subscribe regardless of online state — a ride already accepted still
    // needs to track through to completion even after going offline.
    channelRef.current = supabase
      .channel(`driver-rides-${driverId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rides',
          filter: `driver_id=eq.${driverId}`,
        },
        () => fetchActiveRide()
      )
      .subscribe();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [driverId, fetchTaxi, fetchActiveRide]);

  // Countdown on an unanswered offer, so the driver can see it is timed.
  useEffect(() => {
    if (activeRide?.status !== 'matched' || !activeRide?.matched_at) {
      setSecondsLeft(null);
      return;
    }
    const deadline =
      new Date(activeRide.matched_at).getTime() + OFFER_TIMEOUT_SECONDS * 1000;
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeRide?.id, activeRide?.status, activeRide?.matched_at]);

  // Once the offer lapses the server hands the ride to the next driver, but
  // this driver never sees that as a Realtime event: the subscription filters
  // on driver_id = me, and the reassigned row no longer matches. Poll until it
  // clears so the card doesn't sit there claiming a ride we've lost.
  useEffect(() => {
    if (secondsLeft !== 0) return;
    fetchActiveRide();
    const id = setInterval(fetchActiveRide, 5000);
    return () => clearInterval(id);
  }, [secondsLeft, fetchActiveRide]);

  // A push is what reaches the driver when the app is closed, so the tap that
  // opens the app has to be able to pull the ride in on its own — at that
  // point the Realtime subscription has only just been re-established and
  // never saw the event that fired the notification.
  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener(() =>
      fetchActiveRide()
    );
    const responded = Notifications.addNotificationResponseReceivedListener(() =>
      fetchActiveRide()
    );
    return () => {
      received.remove();
      responded.remove();
    };
  }, [fetchActiveRide]);

  const startTracking = async () => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      Alert.alert(
        'Location needed',
        'Foreground location permission is required to go online.'
      );
      return null;
    }

    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') {
      Alert.alert(
        'Background location needed',
        'Please allow "Always" location access so ride requests keep coming in while the app is in the background.'
      );
      return null;
    }

    // match_nearest_driver() skips taxis with a null current_lat/current_lng,
    // so we need a fix in hand *before* flipping to Online — otherwise the
    // driver sits unmatchable until the first background update lands.
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(
      LOCATION_TASK_NAME
    );
    if (!alreadyStarted) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: LOCATION_INTERVAL_MS,
        distanceInterval: 15,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'DOTS Taxi',
          notificationBody: "You're online and receiving ride requests.",
        },
      });
    }
    return position.coords;
  };

  const stopTracking = async () => {
    const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(
      LOCATION_TASK_NAME
    );
    if (alreadyStarted) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
  };

  const toggleOnline = async (goingOnline) => {
    if (!taxi) return;
    setBusy(true);
    try {
      let patch = { status: 'Offline' };

      if (goingOnline) {
        const coords = await startTracking();
        if (!coords) return; // permission denied — startTracking already explained
        patch = {
          status: 'Online',
          current_lat: coords.latitude,
          current_lng: coords.longitude,
          last_location_update: new Date().toISOString(),
        };
      } else {
        await stopTracking();
      }

      const { error } = await supabase.from('taxis').update(patch).eq('id', taxi.id);
      if (error) throw error;
      await fetchTaxi();
    } catch (err) {
      Alert.alert('Error', err.message);
      // Don't strand a foreground service for a driver who never went online.
      if (goingOnline) await stopTracking();
    } finally {
      setBusy(false);
    }
  };

  const addTaxi = async () => {
    if (!plate.trim() || !model.trim()) {
      Alert.alert('Missing info', 'Plate and model are required.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.from('taxis').insert({
        driver_user_id: driverId,
        plate: plate.trim(),
        model: model.trim(),
        color: color.trim() || null,
        status: 'Offline',
      });
      if (error) throw error;
      await fetchTaxi();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const acceptRide = async () => {
    if (!activeRide) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('rides')
        .update({ status: 'accepted', accepted_at: new Date().toISOString() })
        .eq('id', activeRide.id);
      if (error) throw error;
      await fetchActiveRide();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const declineRide = async () => {
    if (!activeRide) return;
    setBusy(true);
    try {
      // decline_ride() marks the ride 'declined' and immediately re-runs
      // match_nearest_driver() excluding this driver. Writing 'no_drivers'
      // directly instead would dead-end the ride for the rider.
      const { error } = await supabase.rpc('decline_ride', {
        ride_id_in: activeRide.id,
      });
      if (error) throw error;
      setActiveRide(null);
      await fetchActiveRide();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const completeRide = async () => {
    if (!activeRide) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('rides')
        .update({ status: 'completed' })
        .eq('id', activeRide.id);
      if (error) throw error;
      await fetchActiveRide();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    await stopTracking();
    if (taxi) {
      await supabase.from('taxis').update({ status: 'Offline' }).eq('id', taxi.id);
    }
    // Must happen before signOut, while RLS still lets us delete this row.
    await unregisterPushNotifications(driverId);
    await supabase.auth.signOut();
  };

  const offerExpired = secondsLeft === 0;

  const pickupLabel =
    activeRide?.pickup_address ||
    (activeRide
      ? `${activeRide.pickup_lat.toFixed(4)}, ${activeRide.pickup_lng.toFixed(4)}`
      : '');

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>DOTS Taxi Driver</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logout}>Log out</Text>
        </TouchableOpacity>
      </View>

      {!taxi ? (
        <View>
          <Text style={styles.sectionTitle}>Register your vehicle</Text>
          <Text style={styles.hint}>
            You need a registered vehicle before you can go online.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Plate number"
            value={plate}
            onChangeText={setPlate}
            autoCapitalize="characters"
          />
          <TextInput
            style={styles.input}
            placeholder="Model"
            value={model}
            onChangeText={setModel}
          />
          <TextInput
            style={styles.input}
            placeholder="Colour (optional)"
            value={color}
            onChangeText={setColor}
          />
          <TouchableOpacity style={styles.button} onPress={addTaxi} disabled={busy}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Save vehicle</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text style={styles.taxiLine}>
            {taxi.plate} — {taxi.model}
            {taxi.color ? ` (${taxi.color})` : ''}
          </Text>

          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>{isOnline ? 'Online' : 'Offline'}</Text>
            <Switch value={isOnline} onValueChange={toggleOnline} disabled={busy} />
          </View>

          {busy && <ActivityIndicator style={{ marginTop: 12 }} />}

          {activeRide?.status === 'matched' && (
            <View style={styles.rideCard}>
              <Text style={styles.rideTitle}>New Ride Request</Text>
              <Text style={styles.rideDetail}>Pickup: {pickupLabel}</Text>
              <Text style={styles.rideDetail}>
                Drop-off: {activeRide.dest_address || 'Not specified'}
              </Text>
              <Text style={offerExpired ? styles.expiredText : styles.countdownText}>
                {offerExpired
                  ? 'Offer expired — passing to another driver…'
                  : `Respond within ${secondsLeft ?? OFFER_TIMEOUT_SECONDS}s`}
              </Text>
              <View style={styles.rideActions}>
                <TouchableOpacity
                  style={[
                    styles.rideButton,
                    styles.acceptButton,
                    offerExpired && styles.disabledButton,
                  ]}
                  onPress={acceptRide}
                  disabled={busy || offerExpired}
                >
                  <Text style={styles.rideButtonText}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.rideButton,
                    styles.declineButton,
                    offerExpired && styles.disabledButton,
                  ]}
                  onPress={declineRide}
                  disabled={busy || offerExpired}
                >
                  <Text style={styles.rideButtonText}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeRide?.status === 'accepted' && (
            <View style={styles.rideCard}>
              <Text style={styles.rideTitle}>Ride in progress</Text>
              <Text style={styles.rideDetail}>Pickup: {pickupLabel}</Text>
              <Text style={styles.rideDetail}>
                Drop-off: {activeRide.dest_address || 'Not specified'}
              </Text>
              <TouchableOpacity
                style={[styles.rideButton, styles.acceptButton]}
                onPress={completeRide}
                disabled={busy}
              >
                <Text style={styles.rideButtonText}>Complete ride</Text>
              </TouchableOpacity>
            </View>
          )}

          {isOnline && !activeRide && (
            <Text style={styles.waitingText}>Waiting for ride requests…</Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 40,
    marginBottom: 24,
  },
  title: { fontSize: 22, fontWeight: '700' },
  logout: { color: '#c00', fontSize: 14 },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 4 },
  hint: { color: '#666', marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  taxiLine: { fontSize: 15, color: '#444', marginBottom: 12 },
  statusCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 18,
  },
  statusLabel: { fontSize: 18, fontWeight: '600' },
  rideCard: {
    marginTop: 24,
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 18,
  },
  rideTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  rideDetail: { color: '#ddd', fontSize: 14, marginBottom: 8 },
  rideActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  rideButton: { flex: 1, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 8 },
  acceptButton: { backgroundColor: '#2e7d32' },
  declineButton: { backgroundColor: '#555' },
  rideButtonText: { color: '#fff', fontWeight: '600' },
  countdownText: { color: '#7dd87d', fontSize: 13, fontWeight: '600', marginTop: 4 },
  expiredText: { color: '#e5a0a0', fontSize: 13, fontWeight: '600', marginTop: 4 },
  disabledButton: { opacity: 0.4 },
  waitingText: { textAlign: 'center', marginTop: 32, color: '#888' },
});
