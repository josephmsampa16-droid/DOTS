import React from 'react';
import { View } from 'react-native';
import { colors } from '../lib/theme';

// Icons drawn from plain Views, so the app needs no icon package. One stroke
// weight and one grid keep them reading as a family at tab-bar size.

const STROKE = 2;

export function HomeIcon({ size = 22, color = colors.ink }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'flex-end' }}>
      <View
        style={{
          width: size * 0.8,
          height: size * 0.68,
          borderWidth: STROKE,
          borderColor: color,
          borderTopLeftRadius: size * 0.22,
          borderTopRightRadius: size * 0.22,
          borderBottomLeftRadius: 3,
          borderBottomRightRadius: 3,
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <View style={{ width: size * 0.22, height: size * 0.3, backgroundColor: color, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
      </View>
    </View>
  );
}

export function CarIcon({ size = 22, color = colors.ink }) {
  const wheel = size * 0.2;
  return (
    <View style={{ width: size, height: size, justifyContent: 'flex-end' }}>
      <View style={{ position: 'absolute', top: size * 0.12, left: size * 0.22, width: size * 0.56, height: size * 0.34, borderWidth: STROKE, borderColor: color, borderTopLeftRadius: size * 0.16, borderTopRightRadius: size * 0.16, borderBottomWidth: 0 }} />
      <View style={{ width: size, height: size * 0.4, borderWidth: STROKE, borderColor: color, borderRadius: size * 0.12, marginBottom: wheel * 0.45 }} />
      <View style={{ position: 'absolute', bottom: 0, left: size * 0.16, width: wheel, height: wheel, borderRadius: wheel, backgroundColor: color }} />
      <View style={{ position: 'absolute', bottom: 0, right: size * 0.16, width: wheel, height: wheel, borderRadius: wheel, backgroundColor: color }} />
    </View>
  );
}

export function WalletIcon({ size = 22, color = colors.ink }) {
  return (
    <View style={{ width: size, height: size, justifyContent: 'center' }}>
      <View style={{ width: size, height: size * 0.68, borderWidth: STROKE, borderColor: color, borderRadius: size * 0.14, justifyContent: 'center' }}>
        <View style={{ position: 'absolute', top: size * 0.16, left: 0, right: 0, height: STROKE, backgroundColor: color }} />
        <View style={{ position: 'absolute', right: STROKE, top: size * 0.3, width: size * 0.22, height: size * 0.18, borderWidth: STROKE, borderColor: color, borderRadius: 3 }} />
      </View>
    </View>
  );
}

export function ClockIcon({ size = 22, color = colors.ink }) {
  return (
    <View style={{ width: size, height: size, borderWidth: STROKE, borderColor: color, borderRadius: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: STROKE, height: size * 0.3, backgroundColor: color, top: size * 0.16, left: size / 2 - STROKE / 2 }} />
      <View style={{ position: 'absolute', width: size * 0.24, height: STROKE, backgroundColor: color, top: size / 2 - STROKE / 2, left: size / 2 - STROKE / 2 }} />
    </View>
  );
}

export function UserIcon({ size = 22, color = colors.ink }) {
  const head = size * 0.42;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'flex-end' }}>
      <View style={{ width: head, height: head, borderRadius: head, borderWidth: STROKE, borderColor: color, marginBottom: 2 }} />
      <View style={{ width: size * 0.9, height: size * 0.36, overflow: 'hidden' }}>
        <View style={{ width: size * 0.9, height: size * 0.72, borderWidth: STROKE, borderColor: color, borderRadius: size * 0.45 }} />
      </View>
    </View>
  );
}

export function ChevronIcon({ size = 16, color = colors.faint, direction = 'right' }) {
  const rot = { right: '45deg', down: '135deg', left: '225deg', up: '-45deg' }[direction];
  const s = size * 0.55;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: s, height: s, borderTopWidth: STROKE, borderRightWidth: STROKE, borderColor: color, transform: [{ rotate: rot }] }} />
    </View>
  );
}

export function ArrowIcon({ size = 18, color = colors.white }) {
  const s = size * 0.5;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size * 0.8, height: STROKE, backgroundColor: color }} />
      <View style={{ position: 'absolute', right: size * 0.1, width: s, height: s, borderTopWidth: STROKE, borderRightWidth: STROKE, borderColor: color, transform: [{ rotate: '45deg' }] }} />
    </View>
  );
}

export function SwapIcon({ size = 14, color = colors.brand }) {
  const h = size * 0.34;
  return (
    <View style={{ width: size, height: size, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 1 }}>
      <View style={{ width: size * 0.4, height: size, alignItems: 'center' }}>
        <View style={{ width: h, height: h, borderTopWidth: STROKE, borderLeftWidth: STROKE, borderColor: color, transform: [{ rotate: '45deg' }], marginTop: 1 }} />
        <View style={{ width: STROKE, flex: 1, backgroundColor: color, marginTop: -h * 0.6 }} />
      </View>
      <View style={{ width: size * 0.4, height: size, alignItems: 'center', justifyContent: 'flex-end' }}>
        <View style={{ width: STROKE, flex: 1, backgroundColor: color, marginBottom: -h * 0.6 }} />
        <View style={{ width: h, height: h, borderBottomWidth: STROKE, borderRightWidth: STROKE, borderColor: color, transform: [{ rotate: '45deg' }], marginBottom: 1 }} />
      </View>
    </View>
  );
}

// Route markers: a solid dot for the pickup, a ring for the destination.
export function DotIcon({ size = 12, color = colors.brand }) {
  return <View style={{ width: size, height: size, borderRadius: size, backgroundColor: color }} />;
}
export function PinIcon({ size = 14, color = colors.ink }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size, borderWidth: STROKE + 1, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size * 0.3, height: size * 0.3, borderRadius: size, backgroundColor: color }} />
    </View>
  );
}
