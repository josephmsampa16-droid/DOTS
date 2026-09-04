import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import MapView from 'react-native-maps';
import { describeCoords } from '../lib/geocoding';

// Pick a destination by moving the map under a fixed centre pin.
//
// This exists because typed addresses cannot be trusted to price a ride. The OS
// geocoder searches globally and returns its first guess, which put a 1km
// "Manda Hill -> Arcades" trip 1,200km away and would have billed K7,651. A
// dropped pin is the rider stating exactly where they mean, so the distance —
// and therefore the fare — rests on their choice rather than a lookup.
//
// The pin is a static overlay and the map moves beneath it, rather than a
// draggable marker: it keeps the target under the thumb instead of hidden by
// it, and it cannot be flung off-screen.

// Roughly a city-sized view, so the rider starts able to see where they are.
const INITIAL_DELTA = 0.045;

export default function DestinationPicker({ visible, origin, onCancel, onConfirm }) {
  const [centre, setCentre] = useState(null);
  const [label, setLabel] = useState(null);
  const [describing, setDescribing] = useState(false);
  // Ignores the result of any reverse-geocode the rider has already panned past.
  const lookupSeq = useRef(0);

  const initialRegion = origin
    ? {
        latitude: origin.latitude,
        longitude: origin.longitude,
        latitudeDelta: INITIAL_DELTA,
        longitudeDelta: INITIAL_DELTA,
      }
    : null;

  useEffect(() => {
    if (visible && origin && !centre) {
      setCentre({ latitude: origin.latitude, longitude: origin.longitude });
    }
    if (!visible) {
      setCentre(null);
      setLabel(null);
    }
  }, [visible, origin]);

  // Naming the point back to the rider is what makes a pin trustworthy — a bare
  // marker gives them no way to tell they have grabbed the wrong Arcades.
  const describe = useCallback(async (coords) => {
    const seq = ++lookupSeq.current;
    setDescribing(true);
    const text = await describeCoords(coords);
    if (seq !== lookupSeq.current) return; // a newer pan already won
    setLabel(text);
    setDescribing(false);
  }, []);

  const handleRegionChange = (region) => {
    const coords = { latitude: region.latitude, longitude: region.longitude };
    setCentre(coords);
    describe(coords);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.flex}>
        {initialRegion ? (
          <MapView
            style={styles.flex}
            initialRegion={initialRegion}
            onRegionChangeComplete={handleRegionChange}
            showsUserLocation
            showsMyLocationButton
          />
        ) : (
          <View style={[styles.flex, styles.centre]}>
            <ActivityIndicator />
            <Text style={styles.waiting}>Getting your location…</Text>
          </View>
        )}

        {/* Static overlay: the map moves, this does not. pointerEvents none so
            it never swallows a pan gesture. */}
        <View style={styles.pinLayer} pointerEvents="none">
          <View style={styles.pinHead} />
          <View style={styles.pinStem} />
        </View>

        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Move the map to your destination</Text>
          <Text style={styles.sheetLabel} numberOfLines={2}>
            {describing ? 'Finding this place…' : label || 'Drop the pin anywhere'}
          </Text>

          <TouchableOpacity
            style={[styles.confirm, !centre && styles.confirmDisabled]}
            disabled={!centre}
            onPress={() => onConfirm({ ...centre, address: label })}
          >
            <Text style={styles.confirmText}>Confirm destination</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancel} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centre: { alignItems: 'center', justifyContent: 'center' },
  waiting: { marginTop: 10, color: '#6B675E' },
  pinLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    // Lifts the pin so its tip, not its middle, sits on the map centre.
    marginBottom: 34,
  },
  pinHead: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#1B2A6B',
    borderWidth: 3,
    borderColor: '#fff',
  },
  pinStem: { width: 2, height: 14, backgroundColor: '#1B2A6B' },
  sheet: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: '#111' },
  sheetLabel: { marginTop: 6, marginBottom: 14, color: '#6B675E', minHeight: 34 },
  confirm: {
    backgroundColor: '#1B2A6B',
    borderRadius: 10,
    padding: 15,
    alignItems: 'center',
  },
  confirmDisabled: { opacity: 0.4 },
  confirmText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  cancel: { padding: 12, alignItems: 'center' },
  cancelText: { color: '#6B675E' },
});
