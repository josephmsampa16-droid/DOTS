import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, weight } from '../lib/theme';
import { Label, PrimaryButton, Hint } from './ui';

// Rate the driver after a completed ride: stars, the things that were true
// of the trip, a line if they want. Hides itself once the ride is rated.

export default function RatingCard({ ride, onRated, onDismiss }) {
  const [tags, setTags] = useState([]);
  const [alreadyRated, setAlreadyRated] = useState(null); // null = unknown
  const [stars, setStars] = useState(0);
  const [picked, setPicked] = useState(() => new Set());
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const rideId = ride?.id;

  useEffect(() => {
    if (!rideId) return undefined;
    let cancelled = false;
    (async () => {
      const [{ data: t }, { data: existing }] = await Promise.all([
        supabase.from('rating_tags').select('key, label').order('sort'),
        supabase.from('ride_ratings').select('ride_id').eq('ride_id', rideId).maybeSingle(),
      ]);
      if (cancelled) return;
      setTags(t ?? []);
      setAlreadyRated(Boolean(existing));
    })();
    return () => {
      cancelled = true;
    };
  }, [rideId]);

  if (!rideId || !ride?.driver_id || alreadyRated !== false) return null;

  const toggle = (key) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    if (stars < 1) {
      Alert.alert('How many stars?', 'Tap a star to rate the driver.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('submit_ride_rating', {
      p_ride_id: rideId,
      p_stars: stars,
      p_tags: Array.from(picked),
      p_comment: comment.trim() || null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not save your rating', error.message);
      return;
    }
    setAlreadyRated(true);
    onRated?.();
  };

  return (
    <View style={styles.card}>
      <Label>RATE YOUR DRIVER</Label>
      <Text style={styles.title}>How was the trip?</Text>

      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map((n) => (
          <TouchableOpacity key={n} onPress={() => setStars(n)} hitSlop={6} accessibilityLabel={`${n} stars`}>
            <Text style={[styles.star, n <= stars && styles.starOn]}>★</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tags.length > 0 && (
        <View style={styles.tags}>
          {tags.map((t) => {
            const on = picked.has(t.key);
            return (
              <TouchableOpacity
                key={t.key}
                style={[styles.tag, on && styles.tagOn]}
                onPress={() => toggle(t.key)}
                activeOpacity={0.8}
              >
                <Text style={[styles.tagText, on && styles.tagTextOn]}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <TextInput
        style={styles.comment}
        value={comment}
        onChangeText={setComment}
        placeholder="Anything else? (optional)"
        placeholderTextColor={colors.placeholder}
        multiline
      />

      <PrimaryButton title="SEND RATING" onPress={submit} busy={busy} arrow={false} />
      {onDismiss ? (
        <TouchableOpacity onPress={onDismiss} style={styles.skip}>
          <Text style={styles.skipText}>Not now</Text>
        </TouchableOpacity>
      ) : null}
      <Hint>Ratings keep DOTS drivers professional. Your driver sees the totals, never who said what.</Hint>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 18, gap: 12 },
  title: { fontSize: 20, ...weight('800'), color: colors.ink, marginTop: -4 },
  stars: { flexDirection: 'row', gap: 6, justifyContent: 'center', paddingVertical: 4 },
  star: { fontSize: 36, color: '#d9d9d9', ...weight('400') },
  starOn: { color: colors.brand },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: {
    borderWidth: 1.5,
    borderColor: '#d9d9d9',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  tagOn: { borderColor: colors.brand, backgroundColor: colors.brand },
  tagText: { fontSize: 13, ...weight('700'), color: colors.ink },
  tagTextOn: { color: colors.white },
  comment: {
    borderBottomWidth: 1,
    borderBottomColor: colors.rule,
    paddingVertical: 8,
    fontSize: 15,
    ...weight('600'),
    color: colors.ink,
    minHeight: 40,
  },
  skip: { alignItems: 'center', paddingVertical: 6 },
  skipText: { fontSize: 13, ...weight('700'), color: colors.muted },
});
