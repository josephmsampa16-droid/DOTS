import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { supabase } from './lib/supabase';
import { colors } from './lib/theme';
import { TabBar } from './components/ui';
import { CarIcon, ClockIcon, UserIcon } from './components/icons';
import LoginScreen from './screens/LoginScreen';
import RiderHomeScreen from './screens/RiderHomeScreen';
import TripsScreen from './screens/TripsScreen';
import AccountScreen from './screens/AccountScreen';

const TABS = [
  { key: 'ride', label: 'Ride', Icon: CarIcon },
  { key: 'trips', label: 'My Trips', Icon: ClockIcon },
  { key: 'account', label: 'Account', Icon: UserIcon },
];

// Tabs stay mounted and are hidden, not unmounted: the Ride screen holds the
// live subscription that turns "driver found" into a card on screen.
function MainTabs({ session }) {
  const [tab, setTab] = useState('ride');
  const logoutRef = useRef(null);

  return (
    <View style={styles.shell}>
      <View style={styles.panes}>
        <View style={[styles.pane, tab !== 'ride' && styles.hidden]}>
          <RiderHomeScreen session={session} logoutRef={logoutRef} />
        </View>
        <View style={[styles.pane, tab !== 'trips' && styles.hidden]}>
          <TripsScreen session={session} active={tab === 'trips'} />
        </View>
        <View style={[styles.pane, tab !== 'account' && styles.hidden]}>
          <AccountScreen session={session} active={tab === 'account'} onLogout={() => logoutRef.current?.()} />
        </View>
      </View>
      <TabBar items={TABS} active={tab} onChange={setTab} />
    </View>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => {
      listener?.subscription?.unsubscribe();
    };
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  return session ? <MainTabs session={session} /> : <LoginScreen />;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  shell: { flex: 1, backgroundColor: colors.bg },
  panes: { flex: 1 },
  pane: { flex: 1 },
  hidden: { display: 'none' },
});
