import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Same Supabase project (dots-bookings) as the driver app and the existing
// web apps. The anon key is a public, RLS-gated key — it is already embedded
// in index.html and dots-taxi-rider.html, so shipping it here is no wider an
// exposure than the web apps already carry.
const SUPABASE_URL = 'https://rtjzcqdxprrvewtbxgsi.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ0anpjcWR4cHJydmV3dGJ4Z3NpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwOTg4NzMsImV4cCI6MjEwMzY3NDg3M30.iZ5_cBx9InDwCG_kh2fhIlVAuikR3TikXHVfIDBdepM';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
