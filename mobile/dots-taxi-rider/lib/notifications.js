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

// Stores the Expo push token on profiles.push_token. The `notify_rider_on_ride_status`
// trigger reads it and calls the send-ride-push Edge Function whenever the
// rider's ride is matched / accepted / completed.
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
      const { error } = await supabase
        .from('profiles')
        .update({ push_token: token })
        .eq('id', userId);
      if (error) console.warn('Could not save push token:', error.message);
    }
  } catch (err) {
    console.warn('Could not get Expo push token:', err.message);
  }
}
