import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Web stub. react-native-maps has no web implementation, and Metro picks this
// file over DriverMap.js only for platform 'web', so the native map is
// untouched on iOS and Android. Exists so the rider app can be run in a
// browser for review and screenshots.
export default function DriverMap() {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.text}>Driver map (native builds only)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    height: 180,
    borderRadius: 12,
    backgroundColor: '#EDEDEB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: '#6B675E', fontSize: 13 },
});
