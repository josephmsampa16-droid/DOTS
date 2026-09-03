import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Expo SDK 51 requires an explicit EAS project id when asking for a push
// token. It comes from app.json (expo.extra.eas.projectId) once the project
// has been linked with `eas init` — until then getExpoPushTokenAsync() throws,
// so we bail out early with a readable reason instead of crashing the screen.
function getProjectId() {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null
  );
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
// previous rider's ride notifications. RLS already limits this to the caller's
// own rows; failure is non-fatal because sign-out must not be blocked.
export async function unregisterPushNotificationsAsync(userId) {
  if (!userId) return;
  try {
    const { error } = await supabase.from('push_tokens').delete().eq('user_id', userId);
    if (error) console.warn('Could not clear push token:', error.message);
  } catch (err) {
    console.warn('Could not clear push token:', err.message);
  }
}
