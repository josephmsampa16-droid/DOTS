// The four Nunito Sans faces the app uses. React Native treats each weight
// file as its own family, so styles pick a face by name through weight() in
// theme.js rather than by fontWeight — a numeric weight on a custom family
// makes iOS fall back to the system font.
export const FONT_FILES = {
  'NunitoSans-Regular': require('../assets/fonts/NunitoSans-Regular.ttf'),
  'NunitoSans-SemiBold': require('../assets/fonts/NunitoSans-SemiBold.ttf'),
  'NunitoSans-Bold': require('../assets/fonts/NunitoSans-Bold.ttf'),
  'NunitoSans-ExtraBold': require('../assets/fonts/NunitoSans-ExtraBold.ttf'),
};
