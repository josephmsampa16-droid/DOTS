import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import MapView, { Marker, Circle } from 'react-native-maps';
import { colors, weight } from '../lib/theme';

// The map while DOTS is looking for a driver: the pickup, a pulse spreading
// out from it, and how many drivers are within reach. A rider watching a
// number rather than a spinner knows whether to wait.

export default function SearchingMap({ pickup, nearby }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1800,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  if (!pickup) return null;

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1.6] });
  const opacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.45, 0.12, 0] });

  return (
    <View style={styles.wrap}>
      <MapView
        style={styles.map}
        initialRegion={{
          latitude: pickup.latitude,
          longitude: pickup.longitude,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        }}
        scrollEnabled={false}
        zoomEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
      >
        <Circle center={pickup} radius={400} strokeColor="rgba(32,70,155,0.35)" fillColor="rgba(32,70,155,0.06)" />
        <Circle center={pickup} radius={1200} strokeColor="rgba(32,70,155,0.2)" fillColor="rgba(32,70,155,0.03)" />
        <Marker coordinate={pickup} title="Pickup" pinColor={colors.brand} />
      </MapView>

      <View pointerEvents="none" style={styles.pulseLayer}>
        <Animated.View style={[styles.pulse, { transform: [{ scale }], opacity }]} />
      </View>

      <View style={styles.footer}>
        <Text style={styles.title}>Searching for a driver…</Text>
        <Text style={styles.count}>
          {nearby == null
            ? 'Checking who is nearby'
            : nearby === 0
            ? 'No drivers nearby right now — still looking'
            : nearby === 1
            ? '1 driver nearby'
            : `${nearby} drivers nearby`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 16, overflow: 'hidden', backgroundColor: colors.card },
  map: { height: 220, width: '100%' },
  pulseLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulse: { width: 160, height: 160, borderRadius: 999, backgroundColor: colors.brand },
  footer: { padding: 14, gap: 3 },
  title: { fontSize: 16, ...weight('800'), color: colors.ink },
  count: { fontSize: 13, ...weight('600'), color: colors.muted },
});
