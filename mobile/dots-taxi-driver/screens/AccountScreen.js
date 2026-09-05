import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, weight } from '../lib/theme';
import { initials } from '../lib/format';
import { Screen, Card, Label, Row, Chip, LinkRow, Hint } from '../components/ui';
import { UserIcon } from '../components/icons';

// Who the driver is to DOTS: their details, their car, and the commission
// band they are on — the one number that decides what each ride pays them.

export default function AccountScreen({ session, active, onLogout }) {
  const [profile, setProfile] = useState(null);
  const [taxi, setTaxi] = useState(null);
  const [levels, setLevels] = useState([]);
  const [summary, setSummary] = useState(null);
  const [tagLabels, setTagLabels] = useState({});

  const load = useCallback(async () => {
    const [{ data: p }, { data: t }, { data: l }, { data: rs }, { data: rt }] = await Promise.all([
      supabase
        .from('profiles')
        .select('name, phone, driver_level, commission_rate_override')
        .eq('id', session.user.id)
        .maybeSingle(),
      supabase.from('taxis').select('plate, model, color').eq('driver_user_id', session.user.id).maybeSingle(),
      supabase.from('commission_levels').select('level, rate, label').order('rate'),
      supabase.from('driver_rating_summary').select('rating_count, stars_sum, tag_counts').eq('driver_id', session.user.id).maybeSingle(),
      supabase.from('rating_tags').select('key, label').order('sort'),
    ]);
    setSummary(rs ?? null);
    setTagLabels(Object.fromEntries((rt ?? []).map((x) => [x.key, x.label])));
    setProfile(p ?? null);
    setTaxi(t ?? null);
    setLevels(l ?? []);
  }, [session.user.id]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const levelRow = levels.find((l) => l.level === (profile?.driver_level ?? 'new'));
  const rate =
    profile?.commission_rate_override != null
      ? Number(profile.commission_rate_override)
      : levelRow
      ? Number(levelRow.rate)
      : null;
  const percent = rate != null ? `${(rate * 100).toFixed(0)}%` : '—';
  const levelLabel = profile?.commission_rate_override != null ? 'Negotiated rate' : levelRow?.label ?? 'New driver';

  const confirmLogout = () => {
    Alert.alert('Log out?', 'You will go offline and stop receiving ride requests.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => onLogout?.() },
    ]);
  };

  return (
    <Screen role="DRIVER">
      <Card>
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(profile?.name)}</Text>
          </View>
          <View style={styles.profileText}>
            <Text style={styles.name}>{profile?.name || 'Driver'}</Text>
            <Text style={styles.contact}>{profile?.phone || session.user.email}</Text>
            <Chip text={`${levelLabel.toUpperCase()} · ${percent} COMMISSION`} style={{ marginTop: 4 }} />
          </View>
        </View>
      </Card>

      <Card style={{ gap: 10 }}>
        <Label>YOUR RATING</Label>
        {summary && summary.rating_count > 0 ? (
          <>
            <View style={styles.ratingRow}>
              <Text style={styles.ratingBig}>★ {(summary.stars_sum / summary.rating_count).toFixed(2)}</Text>
              <Text style={styles.ratingCount}>
                from {summary.rating_count} {summary.rating_count === 1 ? 'rider' : 'riders'}
              </Text>
            </View>
            {Object.entries(summary.tag_counts || {})
              .filter(([, n]) => Number(n) > 0)
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .map(([k, n]) => (
                <Row key={k} label={tagLabels[k] || k} value={String(n)} />
              ))}
          </>
        ) : (
          <Hint>No ratings yet. Riders rate you after each completed trip; the totals show here.</Hint>
        )}
      </Card>

      <Card style={{ gap: 10 }}>
        <Label>VEHICLE</Label>
        {taxi ? (
          <>
            <Row label="Model" value={taxi.model || '—'} />
            <Row label="Colour" value={taxi.color || '—'} />
            <Row label="Plate" value={taxi.plate || '—'} />
          </>
        ) : (
          <Hint>No vehicle registered yet. Add one on the Home tab to go online.</Hint>
        )}
      </Card>

      <Card style={{ gap: 10 }}>
        <Label>COMMISSION</Label>
        <Hint>
          You collect the full fare in cash. After each ride DOTS takes {percent} of that fare from
          your credit. Everything else is yours.
        </Hint>
        {levels.map((l) => {
          const current = l.level === (profile?.driver_level ?? 'new') && profile?.commission_rate_override == null;
          return (
            <Row
              key={l.level}
              label={l.label}
              value={`${(Number(l.rate) * 100).toFixed(0)}%`}
              color={current ? colors.brand : undefined}
              strong={current}
            />
          );
        })}
      </Card>

      <Card pad={0} style={{ paddingHorizontal: 18 }}>
        <LinkRow title="Log out" Icon={UserIcon} onPress={confirmLogout} tone="danger" last />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  ratingRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  ratingBig: { fontSize: 28, ...weight('800'), color: colors.brand, letterSpacing: -0.5 },
  ratingCount: { fontSize: 13, ...weight('600'), color: colors.muted },
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
