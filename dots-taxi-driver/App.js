import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { supabase } from './lib/supabase';
import { registerForPushNotifications } from './lib/push';
import LoginScreen from './screens/LoginScreen';
import DriverHomeScreen from './screens/DriverHomeScreen';
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
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return session ? <DriverHomeScreen session={session} /> : <LoginScreen />;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
