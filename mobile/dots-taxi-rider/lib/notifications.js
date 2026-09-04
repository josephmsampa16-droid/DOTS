import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  // shouldShowAlert was deprecated and split in two: SDK 57 requires
  // shouldShowBanner (the heads-up alert) and shouldShowList (the
  // notification centre entry) explicitly.
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Expo requires an explicit EAS project id when asking for a push token. It comes from app.json (expo.extra.eas.projectId) once the project
// has been linked with `eas init` — until then getExpoPushTokenAsync() throws,
// so we bail out early with a readable reason instead of crashing the screen.
function getProjectId() {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null
  );
}

// The Expo token issued to THIS device, remembered so sign-out can delete
// exactly that row. A rider signed in on a phone and a tablet has one row per
// device, and logging out of one must not silence the other.
let deviceToken = null;

// Resolves this device's Expo token, preferring the one cached at
// registration. Returns null rather than throwing: every caller treats push as
// best-effort, and sign-out in particular must never be blocked by it.
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
    console.warn('Could not resolve this device\'s push token:', err.message);
    return null;
  }
}

// Stores the Expo push token in public.push_tokens, whose RLS scopes each row
// to its owner — a push token is a bearer credential, so it must not sit in a
// table every signed-in user can read. The `notify_rider_on_ride_status`
// trigger calls the send-ride-push Edge Function, which reads these with the
// service role key whenever the rider's ride is matched / accepted /
// completed.
export async function registerForPushNotificationsAsync(userId) {
  if (!Device.isDevice) return; // push tokens don't work on simulators

  const projectId = getProjectId();
  if (!projectId) {
    console.warn(
      'Push notifications disabled: no EAS projectId. Run `eas init` and add ' +
        'expo.extra.eas.projectId to app.json.'
    );
    return;
  }

  if (Platform.OS === 'android') {
    // Must exist before the permission prompt so the channel importance sticks.
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return;

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (token) deviceToken = token;
    if (userId && token) {
      // The token is the primary key, so re-registering the same device
      // updates its row rather than piling up duplicates.
      const { error } = await supabase
        .from('push_tokens')
        .upsert({ token, user_id: userId, updated_at: new Date().toISOString() }, {
          onConflict: 'token',
        });
      if (error) console.warn('Could not save push token:', error.message);
    }
  } catch (err) {
    console.warn('Could not get Expo push token:', err.message);
  }
}

// Called before signing out, so a shared or resold phone stops receiving the
// previous rider's ride notifications.
//
// Scoped to this device's token, not to every row the user owns: deleting by
// user_id would sign the rider's other devices out of push too. The user_id
// filter is kept as a second condition so a token that has already been
// reassigned to somebody else on this handset is left alone. RLS also limits
// this to the caller's own rows; failure is non-fatal because sign-out must
// not be blocked.
export async function unregisterPushNotificationsAsync(userId) {
  if (!userId) return;
  try {
    const token = await getDeviceToken();
    if (!token) return; // nothing registered from this device — leave others alone

    const { error } = await supabase
      .from('push_tokens')
      .delete()
      .eq('token', token)
      .eq('user_id', userId);

    if (error) console.warn('Could not clear push token:', error.message);
    else deviceToken = null;
  } catch (err) {
    console.warn('Could not clear push token:', err.message);
  }
}
