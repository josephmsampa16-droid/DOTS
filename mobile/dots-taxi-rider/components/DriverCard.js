import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, weight } from '../lib/theme';
import { initials } from '../lib/format';
import { Label, Chip } from './ui';

// Who is coming. Everything here comes from driver_public_profile(), which
// answers only for a driver on one of this rider's own rides.

const LIVE = ['matched', 'accepted', 'arrived', 'in_progress'];

export default function DriverCard({ ride }) {
  const [driver, setDriver] = useState(null);
  const [tagLabels, setTagLabels] = useState({});
  const driverId = ride?.driver_id;

  useEffect(() => {
    if (!driverId) {
      setDriver(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      supabase.rpc('driver_public_profile', { p_driver_id: driverId }),
      supabase.from('rating_tags').select('key, label'),
    ]).then(([{ data }, { data: tags }]) => {
      if (cancelled) return;
      setDriver(data?.[0] ?? null);
      setTagLabels(Object.fromEntries((tags ?? []).map((t) => [t.key, t.label])));
    });
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  if (!driverId || !driver) return null;

  const vehicle = [driver.vehicle_color, driver.vehicle_model].filter(Boolean).join(' ');
  const live = LIVE.includes(ride.status);
  const rating = driver.rating != null ? Number(driver.rating).toFixed(2) : null;
  // The two things riders most often said about this driver.
  const said = Object.entries(driver.tag_counts || {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 2)
    .map(([k, n]) => `${tagLabels[k] || k} · ${n}`);

  return (
    <View style={styles.card}>
      <Label>YOUR DRIVER</Label>
      <View style={styles.row}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(driver.name)}</Text>
        </View>
        <View style={styles.body}>
          <Text style={styles.name}>{driver.name || 'DOTS driver'}</Text>
          <Text style={styles.meta}>
            {rating ? `★ ${rating} (${driver.rating_count})` : 'New to DOTS'}
            {' · '}
            {driver.rides_completed === 1 ? '1 ride' : `${driver.rides_completed} rides`}
          </Text>
          {vehicle ? <Text style={styles.vehicle}>{vehicle}</Text> : null}
          {said.length > 0 ? <Text style={styles.said}>{said.join('   ')}</Text> : null}
        </View>
        {driver.vehicle_plate ? <Chip text={driver.vehicle_plate} tone="brand" /> : null}
      </View>

      {live && driver.phone ? (
        <TouchableOpacity
          style={styles.call}
          onPress={() => Linking.openURL(`tel:${driver.phone}`)}
          activeOpacity={0.8}
        >
          <Text style={styles.callText}>Call {driver.name?.split(' ')[0] || 'driver'} · {driver.phone}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 18, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 999,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontSize: 17, ...weight('800') },
  body: { flex: 1, gap: 2 },
  name: { fontSize: 17, ...weight('800'), color: colors.ink },
  meta: { fontSize: 13, ...weight('600'), color: colors.muted },
  vehicle: { fontSize: 13, ...weight('400'), color: colors.muted },
  said: { fontSize: 12, ...weight('700'), color: colors.brand, marginTop: 2 },
  call: {
    borderWidth: 1.5,
    borderColor: colors.brand,
    borderRadius: 999,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callText: { color: colors.brand, fontSize: 14, ...weight('700') },
});
