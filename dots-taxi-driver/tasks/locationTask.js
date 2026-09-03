import * as TaskManager from 'expo-task-manager';
import { supabase } from '../lib/supabase';

export const LOCATION_TASK_NAME = 'dots-taxi-driver-location-task';

// Driver location lives on `taxis` (current_lat, current_lng,
// last_location_update), keyed by driver_user_id — not on `profiles`.
// match_nearest_driver() only considers taxis with status 'Online' AND a
// non-null current_lat/current_lng, so these writes are what keep a driver
// matchable while the app is backgrounded.

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('Background location task error:', error);
    return;
  }

  const locations = data?.locations;
  if (!locations?.length) return;

  // Batches arrive oldest-first; only the freshest fix is worth writing.
  const { latitude, longitude } = locations[locations.length - 1].coords;

  // getSession() reads the persisted session from AsyncStorage instead of
  // making a network round-trip on every location fix.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) return;

  const { error: updateError } = await supabase
    .from('taxis')
    .update({
      current_lat: latitude,
      current_lng: longitude,
      last_location_update: new Date().toISOString(),
    })
    .eq('driver_user_id', session.user.id);

  if (updateError) {
    console.error('Failed to push driver location:', updateError);
  }
});
