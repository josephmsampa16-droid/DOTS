import React, { useEffect, useRef, useState } from 'react';
import { View, Image, ActivityIndicator, StyleSheet } from 'react-native';
import { useFonts } from 'expo-font';
import { FONT_FILES } from './lib/fonts';
import { supabase } from './lib/supabase';
import { colors } from './lib/theme';
import { TabBar } from './components/ui';
import { CarIcon, ClockIcon, UserIcon } from './components/icons';
import LoginScreen from './screens/LoginScreen';
import RiderHomeScreen from './screens/RiderHomeScreen';
import TripsScreen from './screens/TripsScreen';
import AccountScreen from './screens/AccountScreen';

// The database now copies the phone from signup metadata itself; this covers
// a rider whose profile predates that, so the driver can still call them.
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
  // Hold the splash until the faces are in, so no screen ever paints in the
  // system font and then jumps. A load error is not fatal: the app goes on
  // in the system font rather than stranding the driver on a splash.
  const [fontsLoaded, fontError] = useFonts(FONT_FILES);

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
    if (session) syncPhoneFromMetadata(session);
  }, [session?.user?.id]);

  if (loading || (!fontsLoaded && !fontError)) {
    return (
      <View style={styles.splash}>
        <Image source={require('./assets/dots-logo-white.png')} style={styles.splashLogo} resizeMode="contain" />
        <ActivityIndicator color={colors.white} style={{ marginTop: 24 }} />
      </View>
    );
  }

  return session ? <MainTabs session={session} /> : <LoginScreen />;
}

const styles = StyleSheet.create({
  splash: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.brand },
  splashLogo: { width: 180, height: 45 },
  shell: { flex: 1, backgroundColor: colors.bg },
  panes: { flex: 1 },
  pane: { flex: 1 },
  hidden: { display: 'none' },
});
