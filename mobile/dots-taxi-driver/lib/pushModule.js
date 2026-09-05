import { Platform } from 'react-native';
import Constants from 'expo-constants';

// expo-notifications registers a device-push-token listener as an *import-time*
// side effect (DevicePushTokenAutoRegistration.fx). Inside Expo Go on Android
// that call throws — remote push was removed from Expo Go in SDK 53 — and
// because it happens while the module is loading, it takes the whole app down
// before the first render: a red error screen instead of a UI.
//
// So the module must not even be imported there. A require() behind this flag
// is the only way to avoid it; a top-level import is hoisted and would run
// regardless of any runtime check.
//
// Development builds and iOS are unaffected — there this resolves to the real
// module and push works normally.
export const pushSupported = !(
  Platform.OS === 'android' &&
  Constants.executionEnvironment === 'storeClient'
);

export const Notifications = pushSupported ? require('expo-notifications') : null;
