import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { registerForPushNotificationsAsync } from '../lib/notifications';

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

export default function RiderHomeScreen({ session }) {
  const [location, setLocation] = useState(null);
  const [locationError, setLocationError] = useState(null);
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
          if (['completed', 'no_drivers', 'cancelled'].includes(ride.status)) {
            setActiveRide(ride);
            setTimeout(() => setActiveRide(null), 4000);
          } else {
            setActiveRide(ride);
          }
        }
      )
      .subscribe();
  };

  const requestRide = async () => {
    if (!location) {
      Alert.alert('Location needed', 'Waiting for your location — try again in a moment.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from('rides')
        .insert({
          rider_id: session.user.id,
          status: 'requested',
          pickup_lat: location.latitude,
          pickup_lng: location.longitude,
        })
        .select()
        .single();

      if (error) throw error;
      setActiveRide(data);
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
    await supabase.auth.signOut();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>DOTS Taxi</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logout}>Log out</Text>
        </TouchableOpacity>
      </View>

      {locationError && <Text style={styles.errorText}>{locationError}</Text>}

      {!activeRide && (
        <View style={styles.requestCard}>
          <Text style={styles.requestTitle}>Ready to go?</Text>
          <Text style={styles.requestSubtitle}>
            {location ? 'Pickup: your current location' : 'Getting your location…'}
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

      {activeRide && (
        <View style={styles.statusCard}>
          <Text style={styles.statusText}>
            {STATUS_LABELS[activeRide.status] || activeRide.status}
          </Text>

          {activeRide.status === 'requested' && <ActivityIndicator style={{ marginTop: 12 }} />}

          {['requested'].includes(activeRide.status) && (
            <TouchableOpacity style={styles.cancelButton} onPress={cancelRide} disabled={busy}>
              <Text style={styles.cancelButtonText}>Cancel Request</Text>
            </TouchableOpacity>
          )}

          {activeRide.driver_id && ['matched', 'accepted'].includes(activeRide.status) && (
            <Text style={styles.driverNote}>
              Live driver location tracking / map view goes here (next step).
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
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
    marginTop: 40,
  },
  requestTitle: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  requestSubtitle: { color: '#666', marginBottom: 20 },
  button: {
    backgroundColor: '#0a3d91',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
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
  cancelButton: { marginTop: 20 },
  cancelButtonText: { color: '#ffb3b3', fontSize: 14 },
  driverNote: { color: '#cfe0ff', fontSize: 12, marginTop: 16, textAlign: 'center' },
});
