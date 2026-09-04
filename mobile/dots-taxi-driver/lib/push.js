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

// The Expo token issued to THIS device, remembered so sign-out can delete
// exactly that row rather than every device the driver owns.
let deviceToken = null;

function getProjectId() {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null
  );
}

// Resolves this device's Expo token, preferring the one cached at
// registration. The fallback matters when registration didn't complete this
// session (a transient failure on launch) but a row from a previous session is
// still live — without it, sign-out would leave that row pushing to a phone
// nobody is signed in on. Returns null rather than throwing: sign-out must
// never be blocked by push.
async function getDeviceToken() {
  if (deviceToken) return deviceToken;
  if (!Device.isDevice) return null;

  const projectId = getProjectId();
  if (!projectId) return null;

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    deviceToken = token ?? null;
    return deviceToken;
  } catch (err) {
    console.warn("Could not resolve this device's push token:", err.message);
    return null;
  }
}

// Show ride requests even when the app is already in the foreground —
// otherwise a driver staring at the app is the only one who doesn't get told.
Notifications.setNotificationHandler({
  // SDK 57 split the deprecated shouldShowAlert into shouldShowBanner (the
  // heads-up alert) and shouldShowList (the notification centre entry); both
  // must be set explicitly now.
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
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
    const projectId = getProjectId();

    if (!projectId) {
      console.warn(
        'No EAS projectId in app.json (extra.eas.projectId) — run `eas init`. ' +
          'Push token cannot be issued without it.'
      );
      return null;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return null;

    // push_tokens is keyed by token, one row per device, so a driver signed in
    // on two handsets gets alerted on both. The upsert also reclaims a token
    // that used to belong to another account on this device.
    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { token, user_id: userId, updated_at: new Date().toISOString() },
        { onConflict: 'token' }
      );
    if (error) console.error('Failed to save push token:', error.message);

    // Remember it so logout can remove this device's row specifically.
    deviceToken = token;
    return token;
  } catch (err) {
    console.error('Push registration failed:', err.message);
    return null;
  }
}

/**
 * Drops this device's token at logout so a signed-out phone stops receiving
 * ride requests — and so the next driver to sign in on this handset doesn't
 * inherit the previous driver's notifications. Only this device's row is
 * removed; the driver's other devices keep working.
 */
export async function unregisterPushNotifications(userId) {
  if (!userId) return;
  try {
    const token = await getDeviceToken();
    if (!token) return; // nothing registered from this device — leave others alone

    // The user_id filter is a second condition so a token already reassigned to
    // somebody else on this handset is left alone.
    const { error } = await supabase
      .from('push_tokens')
      .delete()
      .eq('token', token)
      .eq('user_id', userId);

    if (error) console.error('Failed to clear push token:', error.message);
    else deviceToken = null;
  } catch (err) {
    console.error('Failed to clear push token:', err.message);
  }
}
