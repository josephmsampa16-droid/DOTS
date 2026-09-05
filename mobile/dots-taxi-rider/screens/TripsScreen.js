import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, RefreshControl, ScrollView } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';
import { money, whenLabel } from '../lib/format';
import { Header, Card, Label, Chip, EmptyState } from '../components/ui';

// Every ride the rider has asked for, priced or not, so a fare they paid last
// week is a tap away rather than a memory.

const STATUS = {
  completed: { text: 'COMPLETED', tone: 'green' },
  cancelled: { text: 'CANCELLED', tone: 'muted' },
  no_drivers: { text: 'NO DRIVERS', tone: 'muted' },
  declined: { text: 'SEARCHING', tone: 'brand' },
  requested: { text: 'SEARCHING', tone: 'brand' },
  matched: { text: 'DRIVER FOUND', tone: 'brand' },
  accepted: { text: 'ON THE WAY', tone: 'brand' },
  arrived: { text: 'DRIVER HERE', tone: 'brand' },
  in_progress: { text: 'IN PROGRESS', tone: 'brand' },
};

export default function TripsScreen({ session, active }) {
  const [trips, setTrips] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('rides')
      .select('id, requested_at, status, pickup_address, dest_address, fare, currency, distance_km, service_tier')
      .eq('rider_id', session.user.id)
      .order('requested_at', { ascending: false })
      .limit(60);
    setTrips(data ?? []);
    setLoaded(true);
  }, [session.user.id]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={styles.screen}>
      <Header role="RIDER" />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
      >
        <Card pad={0} style={{ paddingTop: 18, paddingHorizontal: 18, paddingBottom: 6 }}>
          <Label>YOUR TRIPS</Label>
          {!loaded ? null : trips.length === 0 ? (
            <EmptyState title="No trips yet" body="Rides you request will appear here with their fare." />
          ) : (
            trips.map((t, i) => {
              const st = STATUS[t.status] ?? { text: t.status.toUpperCase(), tone: 'muted' };
              return (
                <View key={t.id} style={[styles.trip, i === trips.length - 1 && styles.tripLast]}>
                  <View style={styles.tripLeft}>
                    <Text style={styles.when}>{whenLabel(t.requested_at)}</Text>
                    <Text style={styles.route} numberOfLines={1}>
                      {t.pickup_address || 'Pickup'} → {t.dest_address || 'Drop-off'}
                    </Text>
                    <Text style={styles.meta}>
                      {t.service_tier ? t.service_tier[0].toUpperCase() + t.service_tier.slice(1) : 'Standard'}
                      {t.distance_km != null ? ` · ${Number(t.distance_km).toFixed(1)} km` : ''}
                    </Text>
                  </View>
                  <View style={styles.tripRight}>
                    <Text style={styles.fare}>{t.fare != null ? money(t.fare, t.currency) : '—'}</Text>
                    <Chip text={st.text} tone={st.tone} />
                  </View>
                </View>
              );
            })
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 18, paddingBottom: 32, gap: 14 },
  trip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  tripLast: { borderBottomWidth: 0 },
  tripLeft: { flex: 1, gap: 3 },
  tripRight: { alignItems: 'flex-end', gap: 5 },
  when: { fontSize: 12, fontWeight: '600', color: colors.muted },
  route: { fontSize: 15, fontWeight: '700', color: colors.ink },
  meta: { fontSize: 12, color: colors.muted },
  fare: { fontSize: 15, fontWeight: '800', color: colors.ink },
});
