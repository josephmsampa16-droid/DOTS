import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from './supabase';

// Android channel used for incoming ride requests. It has to exist before the
// first notification arrives, and its importance is fixed at creation time —
// changing it later in code has no effect on an already-installed app. MAX
// importance is what makes the request appear as a heads-up alert with sound
// while the app is closed, which is the whole point of this pipeline.
export const RIDE_REQUEST_CHANNEL = 'ride-requests';

// Show ride requests even when the app is already in the foreground —
// otherwise a driver staring at the app is the only one who doesn't get told.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(RIDE_REQUEST_CHANNEL, {
    name: 'Ride requests',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    sound: 'default',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
  });
}

/**
 * Registers this device for push and stores the token on the driver's profile.
 * Returns the token, or null with the reason logged — never throws, because a
 * driver with no push should still be able to work the app.
 */
export async function registerForPushNotifications(userId) {
  try {
    await ensureAndroidChannel();

    // Push tokens are not issued to simulators.
    if (!Device.isDevice) {
      console.warn('Push notifications need a physical device; skipping.');
      return null;
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }
    if (status !== 'granted') {
      console.warn('Push permission denied; ride requests will not alert when closed.');
      return null;
    }

    // Required by expo-notifications from SDK 49 on. Comes from
    // `extra.eas.projectId` in app.json, which `eas init` fills in.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    if (!projectId) {
      console.warn(
        'No EAS projectId in app.json (extra.eas.projectId) — run `eas init`. ' +
          'Push token cannot be issued without it.'
      );
      return null;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return null;

    // Only write when it actually changed — this runs on every launch, and the
    // token is stable across restarts.
    const { data: profile } = await supabase
      .from('profiles')
      .select('push_token')
      .eq('id', userId)
      .maybeSingle();

    if (profile?.push_token !== token) {
      const { error } = await supabase
        .from('profiles')
        .update({ push_token: token })
        .eq('id', userId);
      if (error) console.error('Failed to save push token:', error.message);
    }

    return token;
  } catch (err) {
    console.error('Push registration failed:', err.message);
    return null;
  }
}

/**
 * Drops the stored token at logout so a signed-out phone stops receiving ride
 * requests — and so the next driver to sign in on this handset doesn't inherit
 * the previous driver's notifications.
 */
export async function unregisterPushNotifications(userId) {
  const { error } = await supabase
    .from('profiles')
    .update({ push_token: null })
    .eq('id', userId);
  if (error) console.error('Failed to clear push token:', error.message);
}
