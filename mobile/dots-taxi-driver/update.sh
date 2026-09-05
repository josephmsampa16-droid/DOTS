#!/bin/sh
# Updates this app's source files from the DOTS repository. Run it from
# inside the dots-taxi-driver folder:
#
#     sh update.sh
#
# It replaces only the app's own files. node_modules is untouched, so there
# is nothing to reinstall afterwards — just restart "npx expo start".
set -e
cd "$(dirname "$0")"
BASE="https://raw.githubusercontent.com/josephmsampa16-droid/DOTS/claude/new-session-oxfk8h/mobile/dots-taxi-driver"

FILES="App.js app.json assets/dots-logo-white.png components/icons.js components/ui.js lib/format.js lib/push.js lib/pushModule.js lib/supabase.js lib/theme.js screens/AccountScreen.js screens/DriverHomeScreen.js screens/LoginScreen.js screens/TripsScreen.js screens/WalletScreen.js tasks/locationTask.js assets/fonts/NunitoSans-Regular.ttf assets/fonts/NunitoSans-SemiBold.ttf assets/fonts/NunitoSans-Bold.ttf assets/fonts/NunitoSans-ExtraBold.ttf lib/fonts.js package.json components/RiderCard.js"

echo "Updating dots-taxi-driver ..."
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

for f in screens/TokensScreen.js screens/RiderHomeScreen.js; do
  if [ -f "$f" ]; then rm -f "$f"; echo "  removed old file $f"; fi
done

if [ ! -e node_modules/expo-font ]; then
  echo "Installing the font loader (one time) ..."
  npx expo install expo-font
fi
echo "Done. Restart the app with: npx expo start"
