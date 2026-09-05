import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { supabase } from '../lib/supabase';

import { weight } from '../lib/theme';
// Live view of the matched driver on their way to the rider.
//
// The driver web app (index.html) pushes its position into
// taxis.current_lat/current_lng on a throttled watchPosition, and the
// "Riders see taxi of their matched driver" RLS policy makes exactly that row
// readable to this rider while the ride is matched or accepted — so we can
// both read it and subscribe to it with the rider's own session.

// A driver whose last fix is older than this is probably not actually moving:
// backgrounded browser, dead signal, phone asleep. Say so rather than showing
// a confident marker sitting on a stale position.
const STALE_AFTER_MS = 60 * 1000;

function timeAgo(timestamp) {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

export default function DriverMap({ ride }) {
  const [taxi, setTaxi] = useState(null);
  const [loading, setLoading] = useState(true);
  // Re-renders on a timer purely so the "updated 40s ago" line keeps counting
  // up while no new position arrives.
  const [, setTick] = useState(0);
  const mapRef = useRef(null);
  const channelRef = useRef(null);

  const driverId = ride?.driver_id;

  useEffect(() => {
    if (!driverId) return undefined;
    let cancelled = false;

    const loadTaxi = async () => {
      setLoading(true);
      const { data } = await supabase
        .from('taxis')
        .select('id, plate, model, color, status, current_lat, current_lng, last_location_update')
        .eq('driver_user_id', driverId)
        .maybeSingle();
      if (!cancelled) {
        setTaxi(data ?? null);
        setLoading(false);
      }
    };

    loadTaxi();

    channelRef.current = supabase
      .channel(`driver-taxi-${driverId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'taxis',
          filter: `driver_user_id=eq.${driverId}`,
        },
        (payload) => {
          if (payload.new) setTaxi(payload.new);
        }
      )
      .subscribe();

    const interval = setInterval(() => setTick((n) => n + 1), 15000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [driverId]);

  const pickup =
    ride?.pickup_lat != null && ride?.pickup_lng != null
      ? { latitude: ride.pickup_lat, longitude: ride.pickup_lng }
      : null;

  const destination =
    ride?.dest_lat != null && ride?.dest_lng != null
      ? { latitude: ride.dest_lat, longitude: ride.dest_lng }
      : null;

  const driver =
    taxi?.current_lat != null && taxi?.current_lng != null
      ? { latitude: taxi.current_lat, longitude: taxi.current_lng }
      : null;

  // Keep every relevant point in frame as the driver closes in.
  useEffect(() => {
    const points = [driver, pickup, destination].filter(Boolean);
    if (!mapRef.current || points.length < 2) return;
    mapRef.current.fitToCoordinates(points, {
      edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
      animated: true,
    });
  }, [driver?.latitude, driver?.longitude, pickup?.latitude, destination?.latitude]);

  if (!driverId) return null;

  if (loading) {
    return (
      <View style={[styles.card, styles.placeholder]}>
        <ActivityIndicator />
      </View>
    );
  }

  const vehicleLine = taxi
    ? [taxi.plate, taxi.model, taxi.color].filter(Boolean).join(' · ')
    : null;

  // Location permission denied on the driver's side, or they went online
  // before their browser produced a fix. The ride is still valid.
  if (!driver) {
    return (
      <View style={[styles.card, styles.placeholder]}>
        <Text style={styles.placeholderText}>
          Waiting for your driver's location…
        </Text>
        {vehicleLine && <Text style={styles.vehicleText}>{vehicleLine}</Text>}
      </View>
    );
  }

  const lastUpdate = timeAgo(taxi.last_location_update);
  const isStale =
    taxi.last_location_update &&
    Date.now() - new Date(taxi.last_location_update).getTime() > STALE_AFTER_MS;

  return (
    <View style={styles.card}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{
          latitude: driver.latitude,
          longitude: driver.longitude,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        <Marker
          coordinate={driver}
          title="Your driver"
          description={vehicleLine ?? undefined}
          pinColor="#0a3d91"
        />
        {pickup && <Marker coordinate={pickup} title="Pickup" pinColor="#1E7A34" />}
        {destination && <Marker coordinate={destination} title="Drop-off" pinColor="#B0473F" />}
      </MapView>

      <View style={styles.footer}>
        {vehicleLine && <Text style={styles.vehicleText}>{vehicleLine}</Text>}
        {lastUpdate && (
          <Text style={[styles.updateText, isStale && styles.updateTextStale]}>
            {isStale ? `Location may be out of date — updated ${lastUpdate}` : `Updated ${lastUpdate}`}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 20,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#f5f7fb',
  },
  map: { height: 240, width: '100%' },
  placeholder: { height: 120, alignItems: 'center', justifyContent: 'center', padding: 16 },
  placeholderText: { ...weight('400'), color: '#5C584F', fontSize: 14, textAlign: 'center' },
  footer: { padding: 12 },
  vehicleText: { fontSize: 14, ...weight('600'), color: '#14251F', textAlign: 'center' },
  updateText: { ...weight('400'), fontSize: 12, color: '#8A8578', textAlign: 'center', marginTop: 4 },
  updateTextStale: { ...weight('400'), color: '#B0473F' },
});
