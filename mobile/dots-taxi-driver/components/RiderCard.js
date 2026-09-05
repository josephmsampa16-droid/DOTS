import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, weight } from '../lib/theme';
import { initials } from '../lib/format';
import { Label } from './ui';

// Who the driver is picking up. The name is shown from the offer onward; the
// phone only once the ride is accepted, so a number is never handed out for a
// ride the driver has not committed to. A ride booked for someone else
// carries that person's details on the ride row and those win.

export default function RiderCard({ ride, showPhone }) {
  const [profile, setProfile] = useState(null);
  const riderId = ride?.rider_id;

  useEffect(() => {
    if (!riderId) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    supabase
      .from('profiles')
      .select('name, phone')
      .eq('id', riderId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setProfile(data ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [riderId]);

  const name = ride?.passenger_name || profile?.name || 'Rider';
  const phone = ride?.passenger_phone || profile?.phone || null;
  const forSomeoneElse = Boolean(ride?.passenger_name);

  return (
    <View style={styles.wrap}>
      <Label>{forSomeoneElse ? 'PASSENGER' : 'RIDER'}</Label>
      <View style={styles.row}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(name)}</Text>
        </View>
        <View style={styles.body}>
          <Text style={styles.name}>{name}</Text>
          {forSomeoneElse && profile?.name ? (
            <Text style={styles.meta}>Booked by {profile.name}</Text>
          ) : null}
          {showPhone && phone ? <Text style={styles.meta}>{phone}</Text> : null}
        </View>
        {showPhone && phone ? (
          <TouchableOpacity
            style={styles.call}
            onPress={() => Linking.openURL(`tel:${phone}`)}
            activeOpacity={0.8}
          >
            <Text style={styles.callText}>Call</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, paddingTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: colors.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.brand, fontSize: 14, ...weight('800') },
  body: { flex: 1, gap: 1 },
  name: { fontSize: 16, ...weight('700'), color: colors.ink },
  meta: { fontSize: 13, ...weight('600'), color: colors.muted },
  call: {
    borderWidth: 1.5,
    borderColor: colors.brand,
    borderRadius: 999,
    paddingHorizontal: 18,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callText: { color: colors.brand, fontSize: 14, ...weight('700') },
});
