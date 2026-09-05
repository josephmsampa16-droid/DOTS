import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, weight } from '../lib/theme';
import { initials } from '../lib/format';
import { Screen, Card, Label, Row, LinkRow, Hint } from '../components/ui';
import { UserIcon } from '../components/icons';

export default function AccountScreen({ session, active, onLogout }) {
  const [profile, setProfile] = useState(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('name, phone')
      .eq('id', session.user.id)
      .maybeSingle();
    setProfile(data ?? null);
  }, [session.user.id]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const confirmLogout = () => {
    Alert.alert('Log out?', '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => onLogout?.() },
    ]);
  };

  return (
    <Screen role="RIDER">
      <Card>
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(profile?.name)}</Text>
          </View>
          <View style={styles.profileText}>
            <Text style={styles.name}>{profile?.name || 'Rider'}</Text>
            <Text style={styles.contact}>{session.user.email}</Text>
          </View>
        </View>
      </Card>

      <Card style={{ gap: 10 }}>
        <Label>DETAILS</Label>
        <Row label="Phone" value={profile?.phone || '—'} />
        <Row label="Email" value={session.user.email || '—'} />
      </Card>

      <Card style={{ gap: 10 }}>
        <Label>HOW FARES WORK</Label>
        <Hint>
          Every fare is a base charge plus distance and time, worked out before you book and shown
          in full. The price you see is the price you pay, in cash to your driver.
        </Hint>
      </Card>

      <Card pad={0} style={{ paddingHorizontal: 18 }}>
        <LinkRow title="Log out" Icon={UserIcon} onPress={confirmLogout} tone="danger" last />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontSize: 20, ...weight('800') },
  profileText: { flex: 1, gap: 3 },
  name: { fontSize: 19, ...weight('800'), color: colors.ink },
  contact: { ...weight('400'), fontSize: 13, color: colors.muted },
});
