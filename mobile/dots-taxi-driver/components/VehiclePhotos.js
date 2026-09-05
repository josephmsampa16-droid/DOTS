import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { colors, weight } from '../lib/theme';
import { PHOTO_SLOTS, pickAndUploadVehiclePhoto } from '../lib/vehiclePhotos';
import { Label, Hint } from './ui';

// Three photo tiles. Each uploads as soon as it is chosen, so "Save vehicle"
// only has to record the paths.

export default function VehiclePhotos({ driverId, photos, onChange, disabled }) {
  const [uploading, setUploading] = useState(null);

  const pick = async (slot) => {
    if (disabled || uploading) return;
    setUploading(slot.key);
    try {
      const picked = await pickAndUploadVehiclePhoto(driverId, slot.key);
      if (picked) onChange({ ...photos, [slot.key]: picked });
    } catch (err) {
      Alert.alert('Upload failed', err.message);
    } finally {
      setUploading(null);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <Label>VEHICLE PHOTOS</Label>
      <View style={styles.row}>
        {PHOTO_SLOTS.map((slot) => {
          const photo = photos[slot.key];
          const busy = uploading === slot.key;
          return (
            <TouchableOpacity
              key={slot.key}
              style={[styles.tile, photo && styles.tileDone]}
              onPress={() => pick(slot)}
              disabled={disabled || Boolean(uploading)}
              activeOpacity={0.8}
            >
              {photo ? (
                <Image source={{ uri: photo.uri }} style={styles.image} />
              ) : (
                <View style={styles.plus}>
                  <Text style={styles.plusText}>+</Text>
                </View>
              )}
              {busy && (
                <View style={styles.busy}>
                  <ActivityIndicator color={colors.white} />
                </View>
              )}
              <Text style={styles.tileLabel}>{slot.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Hint>
        {PHOTO_SLOTS.map((s) => `${s.label}: ${s.hint.toLowerCase()}`).join('. ')}. DOTS staff review
        these before the car can go online.
      </Hint>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  tile: {
    flex: 1,
    aspectRatio: 0.9,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#d9d9d9',
    borderStyle: 'dashed',
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  tileDone: { borderStyle: 'solid', borderColor: colors.brand },
  image: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined },
  plus: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  plusText: { fontSize: 30, color: colors.brand, ...weight('400') },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(32,70,155,0.55)', alignItems: 'center', justifyContent: 'center' },
  tileLabel: {
    alignSelf: 'stretch',
    textAlign: 'center',
    paddingVertical: 5,
    fontSize: 12,
    ...weight('700'),
    color: colors.white,
    backgroundColor: 'rgba(28,28,30,0.72)',
  },
});
