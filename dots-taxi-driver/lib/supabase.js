import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Same project the web apps use (dots-bookings). These are the public
// URL + anon key already shipped in index.html — RLS is what protects the
// data, not the secrecy of this key.
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
