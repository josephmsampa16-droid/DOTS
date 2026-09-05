import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from './supabase';

// The photos DOTS needs before a car can be approved, in the order the
// driver is asked for them.
export const PHOTO_SLOTS = [
  { key: 'front', label: 'Front', hint: 'Whole car from the front, plate visible' },
  { key: 'side', label: 'Side', hint: 'Whole car from the side' },
  { key: 'interior', label: 'Interior', hint: 'Back seats from the door' },
];

export const BUCKET = 'vehicle-photos';

function askSource() {
  return new Promise((resolve) => {
    Alert.alert('Add a photo', undefined, [
      { text: 'Take photo', onPress: () => resolve('camera') },
      { text: 'Choose from library', onPress: () => resolve('library') },
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
    ]);
  });
}

// Lets the driver take or choose a photo and uploads it into their own
// folder in the bucket. Resolves to { uri, path } or null if they backed out.
// The folder is the driver's id, which is what the storage policy checks.
export async function pickAndUploadVehiclePhoto(driverId, slotKey) {
  const source = await askSource();
  if (!source) return null;

  const perm =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert('Permission needed', 'Allow access so you can add a photo of the vehicle.');
    return null;
  }

  const options = { mediaTypes: ['images'], quality: 0.7, allowsEditing: false };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets?.[0]?.uri) return null;

  const uri = result.assets[0].uri;
  const path = `${driverId}/${slotKey}-${Date.now()}.jpg`;

  const response = await fetch(uri);
  const body = await response.arrayBuffer();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, body, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;

  return { uri, path };
}
