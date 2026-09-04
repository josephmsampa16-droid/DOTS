import React from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet } from 'react-native';

// Web stub. react-native-maps has no web implementation, and Metro picks this
// file only for platform 'web', so the native picker is untouched on iOS and
// Android. Exists so the rider app still runs in a browser for review.
export default function DestinationPicker({ visible, onCancel }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.wrap}>
        <Text style={styles.text}>
          Choosing a destination on the map needs the iOS or Android app.
        </Text>
        <TouchableOpacity style={styles.cancel} onPress={onCancel}>
          <Text style={styles.cancelText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  text: { color: '#6B675E', textAlign: 'center' },
  cancel: { marginTop: 16, padding: 12 },
  cancelText: { color: '#1B2A6B', fontWeight: '600' },
});
