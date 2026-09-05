import React, { useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { supabase } from './lib/supabase';
import { registerForPushNotifications } from './lib/push';
import { colors } from './lib/theme';
import { TabBar } from './components/ui';
import { HomeIcon, WalletIcon, ClockIcon, UserIcon } from './components/icons';
import LoginScreen from './screens/LoginScreen';
import DriverHomeScreen from './screens/DriverHomeScreen';
import WalletScreen from './screens/WalletScreen';
import TripsScreen from './screens/TripsScreen';
import AccountScreen from './screens/AccountScreen';
import './tasks/locationTask'; // registers the background task on app load

// handle_new_user() only copies `name` and `intended_role` out of the signup
// metadata — `phone` is dropped. Backfill it on the first authenticated run so
// staff can actually reach the driver. Only `phone` is touched here: the
// prevent_role_self_promotion trigger rejects any self-change to `role`.
async function syncPhoneFromMetadata(session) {
  const phone = session.user.user_metadata?.phone;
  if (!phone) return;

  const { data, error } = await supabase
    .from('profiles')
    .select('phone')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error || !data || data.phone) return;

  await supabase.from('profiles').update({ phone }).eq('id', session.user.id);
}

const TABS = [
  { key: 'home', label: 'Home', Icon: HomeIcon },
  { key: 'wallet', label: 'Wallet', Icon: WalletIcon },
  { key: 'trips', label: 'Trips', Icon: ClockIcon },
  { key: 'account', label: 'Account', Icon: UserIcon },
];

// Every tab stays mounted and is hidden rather than unmounted. The Home
// screen owns the ride subscription and the location watcher; tearing those
// down whenever the driver glanced at their wallet would drop ride requests.
function MainTabs({ session }) {
  const [tab, setTab] = useState('home');
  // Wallet top-ups change the balance Home displays; bumping this tells Home
  // to refetch without the two screens sharing state.
  const [walletVersion, setWalletVersion] = useState(0);
  // Home knows how to log out properly (taxi offline, tracking stopped, push
  // token removed). Account borrows that through this ref.
  const logoutRef = useRef(null);

  return (
    <View style={styles.shell}>
      <View style={styles.panes}>
        <View style={[styles.pane, tab !== 'home' && styles.hidden]}>
          <DriverHomeScreen
            session={session}
            onNavigate={setTab}
            logoutRef={logoutRef}
            refreshSignal={walletVersion}
          />
        </View>
        <View style={[styles.pane, tab !== 'wallet' && styles.hidden]}>
          <WalletScreen
            session={session}
            active={tab === 'wallet'}
            onBalanceChange={() => setWalletVersion((v) => v + 1)}
          />
        </View>
        <View style={[styles.pane, tab !== 'trips' && styles.hidden]}>
          <TripsScreen session={session} active={tab === 'trips'} />
        </View>
        <View style={[styles.pane, tab !== 'account' && styles.hidden]}>
          <AccountScreen
            session={session}
            active={tab === 'account'}
            onLogout={() => logoutRef.current?.()}
          />
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

  useEffect(() => {
    if (!session) return;
    syncPhoneFromMetadata(session);
    // Re-registers on every launch: tokens can be rotated by the OS, and this
    // is also what re-arms a driver whose token was cleared as unregistered.
    registerForPushNotifications(session.user.id);
  }, [session?.user?.id]);

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
