#!/bin/sh
# Updates this app's source files from the DOTS repository. Run it from
# inside the dots-taxi-rider folder:
#
#     sh update.sh
#
# It replaces only the app's own files. node_modules is untouched, so there
# is nothing to reinstall afterwards — just restart "npx expo start".
set -e
cd "$(dirname "$0")"
BASE="https://raw.githubusercontent.com/josephmsampa16-droid/DOTS/claude/new-session-oxfk8h/mobile/dots-taxi-rider"

FILES="App.js app.json assets/dots-logo-white.png components/DestinationPicker.js components/DestinationPicker.web.js components/DriverMap.js components/DriverMap.web.js components/icons.js components/ui.js lib/format.js lib/geocoding.js lib/notifications.js lib/pushModule.js lib/supabase.js lib/theme.js screens/AccountScreen.js screens/LoginScreen.js screens/RiderHomeScreen.js screens/TripsScreen.js"

echo "Updating dots-taxi-rider ..."
for f in $FILES; do
  mkdir -p "$(dirname "$f")"
  if curl -fsS --retry 3 --retry-delay 2 -o "$f.tmp" "$BASE/$f"; then
    mv "$f.tmp" "$f"
    printf "  %-40s %8s bytes\n" "$f" "$(wc -c < "$f" | tr -d ' ')"
  else
    rm -f "$f.tmp"
    echo "  FAILED: $f  (check your connection and run sh update.sh again)"
    exit 1
  fi
done

for f in ; do
  if [ -f "$f" ]; then rm -f "$f"; echo "  removed old file $f"; fi
done

echo "Done. Restart the app with: npx expo start"
