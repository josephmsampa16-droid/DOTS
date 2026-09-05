import React from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  StyleSheet,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { colors, spacing, radius, type, shadow, weight } from '../lib/theme';
import { ArrowIcon, ChevronIcon, DotIcon, PinIcon } from './icons';

// The building blocks every screen is made from. Screens compose these and
// add nothing of their own beyond layout, which is what keeps the two apps
// looking like one product and lets a redesign happen in this file.

const HEADER_TOP = Platform.select({
  ios: 56,
  android: (StatusBar.currentHeight || 24) + 16,
  default: 32,
});

export function Header({ role }) {
  return (
    <View style={styles.header}>
      <StatusBar barStyle="light-content" backgroundColor={colors.brand} />
      <Image
        source={require('../assets/dots-logo-white.png')}
        style={styles.logo}
        resizeMode="contain"
        accessibilityLabel="DOTS"
      />
      {role ? <Text style={styles.role}>{role}</Text> : null}
    </View>
  );
}

// Blue header, grey page, scrolling body. `keyboard` wraps the body so text
// fields rise above the keyboard on iOS.
export function Screen({ role, children, strip, keyboard = false, scroll = true, contentStyle }) {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.body, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, styles.body, contentStyle]}>{children}</View>
  );
  const inner = (
    <View style={styles.screen}>
      <Header role={role} />
      {strip}
      {body}
    </View>
  );
  if (!keyboard) return inner;
  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {inner}
    </KeyboardAvoidingView>
  );
}

export function Card({ children, style, pad = spacing.xl }) {
  return <View style={[styles.card, { padding: pad }, style]}>{children}</View>;
}

export function Label({ children, large = false, style }) {
  return <Text style={[large ? type.labelLg : type.label, style]}>{children}</Text>;
}

// A labelled, underlined text field — the house input.
export function Field({ label, style, inputStyle, ...inputProps }) {
  return (
    <View style={[styles.field, style]}>
      <Label large>{label}</Label>
      <TextInput
        style={[styles.fieldInput, inputStyle]}
        placeholderTextColor={colors.placeholder}
        {...inputProps}
      />
    </View>
  );
}

export function FieldStatic({ label, value, style, muted = false }) {
  return (
    <View style={[styles.field, style]}>
      <Label large>{label}</Label>
      <Text style={[styles.fieldInput, muted && { color: colors.placeholder }]}>{value}</Text>
    </View>
  );
}

export function PrimaryButton({ title, onPress, disabled = false, busy = false, style, arrow = true }) {
  const off = disabled || busy;
  return (
    <TouchableOpacity
      style={[styles.primary, off && styles.primaryOff, style]}
      onPress={onPress}
      disabled={off}
      activeOpacity={0.85}
    >
      {busy ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <View style={styles.primaryInner}>
          <Text style={styles.primaryText}>{title}</Text>
          {arrow ? <ArrowIcon size={18} color={colors.white} /> : null}
        </View>
      )}
    </TouchableOpacity>
  );
}

export function SecondaryButton({ title, onPress, disabled = false, style, tone = 'brand' }) {
  const color = tone === 'danger' ? colors.red : colors.brand;
  return (
    <TouchableOpacity
      style={[styles.secondary, { borderColor: color }, disabled && styles.primaryOff, style]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      <Text style={[styles.secondaryText, { color }]}>{title}</Text>
    </TouchableOpacity>
  );
}

// Two-column line inside a card: "Base fare ........ 15.00".
export function Row({ label, value, color, strong = false, style }) {
  return (
    <View style={[styles.row, style]}>
      <Text style={[styles.rowLabel, color && { color, ...weight('700') }]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong, color && { color }]}>{value}</Text>
    </View>
  );
}

export function Stat({ label, value, color }) {
  return (
    <View style={styles.stat}>
      <Label style={{ fontSize: 11 }}>{label}</Label>
      <Text style={[styles.statValue, color && { color }]}>{value}</Text>
    </View>
  );
}

export function Chip({ text, tone = 'brand', style }) {
  const tones = {
    brand: { bg: colors.brandTint, fg: colors.brand },
    green: { bg: colors.greenTint, fg: colors.green },
    red: { bg: colors.redTint, fg: colors.red },
    muted: { bg: colors.line, fg: colors.muted },
    amber: { bg: colors.amberTint, fg: colors.amber },
  }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: tones.bg }, style]}>
      <Text style={[styles.chipText, { color: tones.fg }]}>{text}</Text>
    </View>
  );
}

export function Toggle({ value, onValueChange, disabled }) {
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ false: '#c9ccd3', true: colors.brand }}
      thumbColor={colors.white}
      ios_backgroundColor="#c9ccd3"
    />
  );
}

// The strip under the header: a row of equal tabs, the active one filled.
export function TabStrip({ items, active, onChange }) {
  return (
    <View style={styles.strip}>
      {items.map(({ key, label, Icon }) => {
        const on = key === active;
        const color = on ? colors.white : colors.muted;
        return (
          <TouchableOpacity
            key={key}
            style={[styles.stripItem, on && styles.stripItemOn]}
            onPress={() => onChange?.(key)}
            activeOpacity={0.8}
          >
            {Icon ? <Icon size={22} color={color} /> : null}
            <Text style={[styles.stripText, { color, ...weight(on ? '700' : '600') }]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// Bottom navigation. Rendered once by the app shell, not by screens.
export function TabBar({ items, active, onChange }) {
  return (
    <View style={styles.tabBar}>
      {items.map(({ key, label, Icon }) => {
        const on = key === active;
        const color = on ? colors.ink : colors.faint;
        return (
          <TouchableOpacity
            key={key}
            style={styles.tabItem}
            onPress={() => onChange?.(key)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
          >
            <Icon size={24} color={color} />
            <Text style={[styles.tabText, { color, ...weight(on ? '700' : '600') }]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// A pickup-to-destination pair with the dot/line/pin rail beside it.
export function Timeline({ top, bottom, middle }) {
  return (
    <View style={styles.timeline}>
      <View style={styles.rail}>
        <DotIcon size={12} color={colors.brand} />
        <View style={styles.railLine} />
        {middle ? (
          <>
            {middle}
            <View style={styles.railLine} />
          </>
        ) : null}
        <PinIcon size={14} color={colors.ink} />
      </View>
      <View style={styles.timelineBody}>
        {top}
        {bottom}
      </View>
    </View>
  );
}

export function LinkRow({ title, onPress, Icon, tone = 'ink', last = false }) {
  const color = tone === 'danger' ? colors.red : colors.ink;
  return (
    <TouchableOpacity style={[styles.linkRow, last && styles.linkRowLast]} onPress={onPress} activeOpacity={0.7}>
      {Icon ? <Icon size={20} color={colors.brand} /> : null}
      <Text style={[styles.linkText, { color }]}>{title}</Text>
      <ChevronIcon size={16} color={colors.faint} />
    </TouchableOpacity>
  );
}

export function EmptyState({ title, body }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
    </View>
  );
}

export function Hint({ children, style }) {
  return <Text style={[styles.hint, style]}>{children}</Text>;
}

export function Notice({ title, body, tone = 'amber', onPress }) {
  const bg = { amber: colors.amberTint, red: colors.redTint, green: colors.greenTint, brand: colors.brandTint }[tone];
  const fg = { amber: colors.amber, red: colors.red, green: colors.green, brand: colors.brand }[tone];
  const inner = (
    <View style={[styles.notice, { backgroundColor: bg }]}>
      <Text style={[styles.noticeTitle, { color: fg }]}>{title}</Text>
      {body ? <Text style={[styles.noticeBody, { color: fg }]}>{body}</Text> : null}
    </View>
  );
  return onPress ? <TouchableOpacity onPress={onPress} activeOpacity={0.8}>{inner}</TouchableOpacity> : inner;
}

export function Progress({ steps, done }) {
  return (
    <View style={styles.progress}>
      {Array.from({ length: steps }, (_, i) => (
        <View key={i} style={[styles.progressSeg, i < done && styles.progressSegDone]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    backgroundColor: colors.brand,
    paddingTop: HEADER_TOP,
    paddingBottom: 20,
    paddingHorizontal: 22,
    alignItems: 'center',
    gap: 8,
  },
  logo: { width: 128, height: 32 },
  role: { fontSize: 11, ...weight('800'), letterSpacing: 2.5, color: colors.onBrandMuted },
  body: { padding: spacing.xl, paddingBottom: 32, gap: 14 },

  card: { backgroundColor: colors.card, borderRadius: radius.lg, ...shadow.card },

  field: { gap: 6, borderBottomWidth: 1, borderBottomColor: colors.rule, paddingBottom: 8 },
  fieldInput: { fontSize: 17, ...weight('600'), color: colors.ink, padding: 0, margin: 0 },

  primary: {
    backgroundColor: colors.brandMid,
    borderRadius: 14,
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryOff: { opacity: 0.45 },
  primaryInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  primaryText: { color: colors.white, fontSize: 17, ...weight('800'), letterSpacing: 1.5 },

  secondary: {
    borderWidth: 1.5,
    borderRadius: radius.pill,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  secondaryText: { fontSize: 14, ...weight('700') },

  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  rowLabel: { ...weight('400'), fontSize: 13, color: colors.muted, flexShrink: 1 },
  rowValue: { fontSize: 13, ...weight('700'), color: colors.ink },
  rowValueStrong: { fontSize: 15, ...weight('800') },

  stat: { flex: 1, gap: 4 },
  statValue: { fontSize: 22, ...weight('800'), letterSpacing: -0.4, color: colors.ink },

  chip: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 10 },
  chipText: { fontSize: 11, ...weight('800'), letterSpacing: 0.5 },

  strip: { flexDirection: 'row', marginHorizontal: spacing.xl, borderBottomWidth: 1, borderBottomColor: '#d9d9d9' },
  stripItem: { flex: 1, alignItems: 'center', gap: 6, paddingTop: 14, paddingBottom: 12 },
  stripItemOn: { backgroundColor: colors.brand, borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  stripText: { ...weight('400'), fontSize: 14 },

  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 26 : 14,
    paddingHorizontal: 10,
  },
  tabItem: { flex: 1, alignItems: 'center', gap: 5, minHeight: 44, justifyContent: 'center' },
  tabText: { ...weight('400'), fontSize: 12 },

  timeline: { flexDirection: 'row', gap: 16 },
  rail: { width: 30, alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
  railLine: { width: 2, flex: 1, backgroundColor: '#d9d9d9', marginVertical: 4 },
  timelineBody: { flex: 1, gap: 18 },

  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line, minHeight: 48 },
  linkRowLast: { borderBottomWidth: 0 },
  linkText: { flex: 1, fontSize: 15, ...weight('600') },

  empty: { alignItems: 'center', paddingVertical: 28, gap: 6 },
  emptyTitle: { fontSize: 16, ...weight('700'), color: colors.ink },
  emptyBody: { ...weight('400'), fontSize: 13, color: colors.muted, textAlign: 'center', lineHeight: 19 },

  hint: { ...weight('400'), fontSize: 13, color: colors.muted, lineHeight: 19 },

  notice: { borderRadius: radius.md, padding: 14, gap: 4 },
  noticeTitle: { fontSize: 14, ...weight('800') },
  noticeBody: { ...weight('400'), fontSize: 13, lineHeight: 18 },

  progress: { flexDirection: 'row', gap: 6 },
  progressSeg: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.line },
  progressSegDone: { backgroundColor: colors.brand },
});
