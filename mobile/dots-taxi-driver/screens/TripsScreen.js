import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, RefreshControl, ScrollView } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';
import { money, kwacha, whenLabel, isToday } from '../lib/format';
import { Header, Card, Label, Stat, EmptyState } from '../components/ui';

// What the driver has done and what it paid. Every figure comes straight off
// the ride row the settlement trigger stamped, so this list is the same record
// the ledger charges against — not a second calculation that could drift.

export default function TripsScreen({ session, active }) {
  const [trips, setTrips] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('rides')
      .select(
        'id, requested_at, updated_at, pickup_address, dest_address, fare, currency, distance_km, commission_amount, driver_payout'
      )
      .eq('driver_id', session.user.id)
      .eq('status', 'completed')
      .order('updated_at', { ascending: false })
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

  const today = trips.filter((t) => isToday(t.updated_at));
  const sum = (rows, key) => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);

  return (
    <View style={styles.screen}>
      <Header role="DRIVER" />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
      >
        <Card>
          <View style={styles.stats}>
            <Stat label="TRIPS TODAY" value={String(today.length)} />
            <Stat label="FARES" value={kwacha(sum(today, 'fare'))} />
            <Stat label="YOU KEPT" value={kwacha(sum(today, 'driver_payout'))} color={colors.green} />
          </View>
        </Card>

        <Card pad={0} style={{ paddingTop: 18, paddingHorizontal: 18, paddingBottom: 6 }}>
          <Label>RECENT TRIPS</Label>
          {!loaded ? null : trips.length === 0 ? (
            <EmptyState
              title="No trips yet"
              body="Completed rides will appear here with what each one paid."
            />
          ) : (
            trips.map((t, i) => (
              <View key={t.id} style={[styles.trip, i === trips.length - 1 && styles.tripLast]}>
                <View style={styles.tripLeft}>
                  <Text style={styles.when}>{whenLabel(t.updated_at)}</Text>
                  <Text style={styles.route} numberOfLines={1}>
                    {t.pickup_address || 'Pickup'} → {t.dest_address || 'Drop-off'}
                  </Text>
                  {t.distance_km != null && (
                    <Text style={styles.meta}>{Number(t.distance_km).toFixed(1)} km</Text>
                  )}
                </View>
                <View style={styles.tripRight}>
                  <Text style={styles.fare}>{money(t.fare, t.currency)}</Text>
                  {t.driver_payout != null ? (
                    <Text style={styles.kept}>kept {Number(t.driver_payout).toFixed(2)}</Text>
                  ) : (
                    <Text style={styles.meta}>unpriced</Text>
                  )}
                </View>
              </View>
            ))
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 18, paddingBottom: 32, gap: 14 },
  stats: { flexDirection: 'row', gap: 12 },
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
  tripRight: { alignItems: 'flex-end', gap: 3 },
  when: { fontSize: 12, fontWeight: '600', color: colors.muted },
  route: { fontSize: 15, fontWeight: '700', color: colors.ink },
  meta: { fontSize: 12, color: colors.muted },
  fare: { fontSize: 15, fontWeight: '800', color: colors.ink },
  kept: { fontSize: 12, fontWeight: '700', color: colors.green },
});
