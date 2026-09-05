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

# Refresh this updater itself first, so a new step (like a package to install)
# is never missed by a stale copy. Re-runs once if it changed.
if [ -z "$DOTS_UPDATER_REFRESHED" ]; then
  if curl -fsS -o update.sh.new "$BASE/update.sh" && ! cmp -s update.sh.new update.sh; then
    mv update.sh.new update.sh
    echo "Updater refreshed — running the new one."
    DOTS_UPDATER_REFRESHED=1 exec sh update.sh
  fi
  rm -f update.sh.new
fi

FILES="App.js app.json assets/dots-logo-white.png components/DestinationPicker.js components/DestinationPicker.web.js components/DriverMap.js components/DriverMap.web.js components/icons.js components/ui.js lib/format.js lib/geocoding.js lib/notifications.js lib/pushModule.js lib/supabase.js lib/theme.js screens/AccountScreen.js screens/LoginScreen.js screens/RiderHomeScreen.js screens/TripsScreen.js assets/fonts/NunitoSans-Regular.ttf assets/fonts/NunitoSans-SemiBold.ttf assets/fonts/NunitoSans-Bold.ttf assets/fonts/NunitoSans-ExtraBold.ttf lib/fonts.js package.json components/SearchingMap.js components/DriverCard.js components/RatingCard.js"

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

if [ ! -e node_modules/expo-font ]; then
  echo "Installing the font loader (one time) ..."
  npx expo install expo-font
fi
echo "Done. Restart the app with: npx expo start"
