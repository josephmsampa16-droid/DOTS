import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Switch,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { unregisterPushNotifications } from '../lib/push';
import { Notifications, pushSupported } from '../lib/pushModule';
import TokensScreen from './TokensScreen';
import { LOCATION_TASK_NAME } from '../tasks/locationTask';

// Matches the ~8s throttle the web driver app uses.
const LOCATION_INTERVAL_MS = 8000;

// Must match expire_stale_ride_offers(45) on the server. The sweep runs every
// 15s, so the real cutoff is 45-60s — the countdown is the driver's guide, the
// server is the authority.
// What the driver sees at each stage of a trip, and the one action that moves
// it on. Keeping the label, the next status and its timestamp column together
// means the button can never promise something the update doesn't do.
const TRIP_STAGES = {
  accepted: {
    step: 1,
    title: 'Driving to the rider',
    hint: 'Tap when you reach the pickup point.',
    action: 'I have arrived',
    next: 'arrived',
    stamp: 'arrived_at',
  },
  arrived: {
    step: 2,
    title: 'Waiting for the rider',
    hint: 'Tap once the rider is in the car.',
    action: 'Start ride',
    next: 'in_progress',
    stamp: 'started_at',
  },
  in_progress: {
    step: 3,
    title: 'Trip in progress',
    hint: 'Tap when you reach the drop-off.',
    action: 'Complete ride',
    next: 'completed',
    stamp: null,
  },
};

const TRIP_STEP_COUNT = 3;

const OFFER_TIMEOUT_SECONDS = 45;

export default function DriverHomeScreen({ session }) {
  const driverId = session.user.id;

  const [taxi, setTaxi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeRide, setActiveRide] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [backgroundTracking, setBackgroundTracking] = useState(false);
  const [tokenBalance, setTokenBalance] = useState(null);
  const [tokensOpen, setTokensOpen] = useState(false);
  // The just-finished ride, kept after `activeRide` clears so the driver still
  // has the amount on screen to read out and collect.
  const [finishedRide, setFinishedRide] = useState(null);

  const [plate, setPlate] = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');

  const channelRef = useRef(null);
  const foregroundWatchRef = useRef(null);

  const isOnline = taxi?.status === 'Online';

  // Dispatch skips a driver on zero, so this number decides whether they get
  // work at all. Refetched whenever it could have moved rather than cached.
  const fetchTokenBalance = useCallback(async () => {
    const { data } = await supabase
      .from('driver_wallets')
      .select('token_balance')
      .eq('driver_id', driverId)
      .maybeSingle();
    setTokenBalance(data?.token_balance ?? 0);
  }, [driverId]);

  const fetchTaxi = useCallback(async () => {
    // A driver may not have registered a vehicle yet, so no .single() here —
    // it errors on zero rows.
    const { data, error } = await supabase
      .from('taxis')
      .select('*')
      .eq('driver_user_id', driverId)
      .limit(1);
    if (error) {
      Alert.alert('Error', error.message);
      return;
    }
    setTaxi(data?.[0] || null);
  }, [driverId]);

  // Refetch rather than trusting a single payload: this also recovers the
  // current ride after a missed realtime event or an app restart.
  const fetchActiveRide = useCallback(async () => {
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('driver_id', driverId)
      .in('status', ['matched', 'accepted', 'arrived', 'in_progress'])
      .order('requested_at', { ascending: false })
      .limit(1);
    setActiveRide(data?.[0] || null);
  }, [driverId]);

  useEffect(() => {
    (async () => {
      await Promise.all([fetchTaxi(), fetchActiveRide(), fetchTokenBalance()]);
      setLoading(false);
    })();

    // Subscribe regardless of online state — a ride already accepted still
    // needs to track through to completion even after going offline.
    channelRef.current = supabase
      .channel(`driver-rides-${driverId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rides',
          filter: `driver_id=eq.${driverId}`,
        },
        () => fetchActiveRide()
      )
      .subscribe();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [driverId, fetchTaxi, fetchActiveRide, fetchTokenBalance]);

  // Countdown on an unanswered offer, so the driver can see it is timed.
  useEffect(() => {
    if (activeRide?.status !== 'matched' || !activeRide?.matched_at) {
      setSecondsLeft(null);
      return;
    }
    const deadline =
      new Date(activeRide.matched_at).getTime() + OFFER_TIMEOUT_SECONDS * 1000;
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeRide?.id, activeRide?.status, activeRide?.matched_at]);

  // Once the offer lapses the server hands the ride to the next driver, but
  // this driver never sees that as a Realtime event: the subscription filters
  // on driver_id = me, and the reassigned row no longer matches. Poll until it
  // clears so the card doesn't sit there claiming a ride we've lost.
  useEffect(() => {
    if (secondsLeft !== 0) return;
    fetchActiveRide();
    const id = setInterval(fetchActiveRide, 5000);
    return () => clearInterval(id);
  }, [secondsLeft, fetchActiveRide]);

  // A push is what reaches the driver when the app is closed, so the tap that
  // opens the app has to be able to pull the ride in on its own — at that
  // point the Realtime subscription has only just been re-established and
  // never saw the event that fired the notification.
  useEffect(() => {
    if (!pushSupported) return;
    const received = Notifications.addNotificationReceivedListener(() =>
      fetchActiveRide()
    );
    const responded = Notifications.addNotificationResponseReceivedListener(() =>
      fetchActiveRide()
    );
    return () => {
      received.remove();
      responded.remove();
    };
  }, [fetchActiveRide]);

  // Writes a fix straight to this driver's taxi row. Used by the foreground
  // watcher; the background task does the same write from tasks/locationTask.
  const pushLocation = useCallback(
    async ({ latitude, longitude }) => {
      await supabase
        .from('taxis')
        .update({
          current_lat: latitude,
          current_lng: longitude,
          last_location_update: new Date().toISOString(),
        })
        .eq('driver_user_id', driverId);
    },
    [driverId]
  );

  // Fallback for when background location isn't available: keep pushing fixes
  // while the app is open. Worse than the background task — the driver has to
  // keep the app in front — but far better than refusing to go Online at all.
  const startForegroundWatch = async () => {
    if (foregroundWatchRef.current) return;
    foregroundWatchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: LOCATION_INTERVAL_MS,
        distanceInterval: 15,
      },
      (loc) => pushLocation(loc.coords)
    );
  };

  const startTracking = async () => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      Alert.alert(
        'Location needed',
        'Location permission is required to go online.'
      );
      return null;
    }

    // match_nearest_driver() skips taxis with a null current_lat/current_lng,
    // so we need a fix in hand *before* flipping to Online — otherwise the
    // driver sits unmatchable until the first update lands.
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    // Background location is best-effort, never a gate. Two ways it can be
    // unavailable: the driver picks "While Using" rather than "Always", or the
    // host app has no Always-usage string in its Info.plist and the request
    // throws ERR_LOCATION_INFO_PLIST — which is what Expo Go does, since it
    // cannot see this project's app.json. Either way the driver still works,
    // they just have to keep the app open.
    let background = false;
    try {
      const bg = await Location.requestBackgroundPermissionsAsync();
      background = bg.status === 'granted';
    } catch {
      background = false;
    }

    if (background) {
      const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(
        LOCATION_TASK_NAME
      );
      if (!alreadyStarted) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.High,
          timeInterval: LOCATION_INTERVAL_MS,
          distanceInterval: 15,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'DOTS Taxi',
            notificationBody: "You're online and receiving ride requests.",
          },
        });
      }
    } else {
      await startForegroundWatch();
      Alert.alert(
        'Keep the app open',
        'Background location is not available, so you will only receive ride requests while this app is open and on screen.'
      );
    }

    setBackgroundTracking(background);
    return position.coords;
  };

  const stopTracking = async () => {
    if (foregroundWatchRef.current) {
      foregroundWatchRef.current.remove();
      foregroundWatchRef.current = null;
    }
    const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(
      LOCATION_TASK_NAME
    );
    if (alreadyStarted) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
    setBackgroundTracking(false);
  };

  const toggleOnline = async (goingOnline) => {
    if (!taxi) return;
    setBusy(true);
    try {
      let patch = { status: 'Offline' };

      if (goingOnline) {
        const coords = await startTracking();
        if (!coords) return; // permission denied — startTracking already explained
        patch = {
          status: 'Online',
          current_lat: coords.latitude,
          current_lng: coords.longitude,
          last_location_update: new Date().toISOString(),
        };
      } else {
        await stopTracking();
      }

      const { error } = await supabase.from('taxis').update(patch).eq('id', taxi.id);
      if (error) throw error;
      await fetchTaxi();
    } catch (err) {
      Alert.alert('Error', err.message);
      // Don't strand a foreground service for a driver who never went online.
      if (goingOnline) await stopTracking();
    } finally {
      setBusy(false);
    }
  };

  const addTaxi = async () => {
    if (!plate.trim() || !model.trim()) {
      Alert.alert('Missing info', 'Plate and model are required.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.from('taxis').insert({
        driver_user_id: driverId,
        plate: plate.trim(),
        model: model.trim(),
        color: color.trim() || null,
        status: 'Offline',
      });
      if (error) throw error;
      await fetchTaxi();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const acceptRide = async () => {
    if (!activeRide) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('rides')
        .update({ status: 'accepted', accepted_at: new Date().toISOString() })
        .eq('id', activeRide.id);
      if (error) throw error;
      await fetchActiveRide();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const declineRide = async () => {
    if (!activeRide) return;
    setBusy(true);
    try {
      // decline_ride() marks the ride 'declined' and immediately re-runs
      // match_nearest_driver() excluding this driver. Writing 'no_drivers'
      // directly instead would dead-end the ride for the rider.
      const { error } = await supabase.rpc('decline_ride', {
        ride_id_in: activeRide.id,
      });
      if (error) throw error;
      setActiveRide(null);
      await fetchActiveRide();
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  // Each stage the driver reports is a fact about the trip — at the pickup,
  // rider aboard, done — and each is stamped so a later dispute has something
  // to point at.
  const advanceRide = async (nextStatus, stampColumn) => {
    if (!activeRide) return;
    setBusy(true);
    try {
      const patch = { status: nextStatus };
      if (stampColumn) patch[stampColumn] = new Date().toISOString();
      const { error } = await supabase.from('rides').update(patch).eq('id', activeRide.id);
      if (error) throw error;
      if (nextStatus === 'completed') {
        // Snapshot before fetchActiveRide() drops it — the fare is what the
        // driver still needs on screen.
        setFinishedRide(activeRide);
      }
      await fetchActiveRide();
      if (nextStatus === 'completed') {
        // Completion just spent a token; show the new balance.
        await fetchTokenBalance();
      }
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    await stopTracking();
    if (taxi) {
      await supabase.from('taxis').update({ status: 'Offline' }).eq('id', taxi.id);
    }
    // Must happen before signOut, while RLS still lets us delete this row.
    await unregisterPushNotifications(driverId);
    await supabase.auth.signOut();
  };

  const offerExpired = secondsLeft === 0;

  // Null unless a trip is underway, which is exactly when the stage card shows.
  const stage = activeRide ? TRIP_STAGES[activeRide.status] : null;

  const pickupLabel =
    activeRide?.pickup_address ||
    (activeRide
      ? `${activeRide.pickup_lat.toFixed(4)}, ${activeRide.pickup_lng.toFixed(4)}`
      : '');

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>DOTS Taxi Driver</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={[styles.tokenChip, tokenBalance === 0 && styles.tokenChipEmpty]}
            onPress={() => setTokensOpen(true)}
          >
            <Text style={[styles.tokenChipText, tokenBalance === 0 && styles.tokenChipTextEmpty]}>
              {tokenBalance ?? '—'} tokens
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleLogout}>
            <Text style={styles.logout}>Log out</Text>
          </TouchableOpacity>
        </View>
      </View>

      <TokensScreen
        visible={tokensOpen}
        session={session}
        balance={tokenBalance}
        onClose={() => setTokensOpen(false)}
        onBalanceChange={fetchTokenBalance}
      />

      {!taxi ? (
        <View>
          <Text style={styles.sectionTitle}>Register your vehicle</Text>
          <Text style={styles.hint}>
            You need a registered vehicle before you can go online.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Plate number"
            value={plate}
            onChangeText={setPlate}
            autoCapitalize="characters"
          />
          <TextInput
            style={styles.input}
            placeholder="Model"
            value={model}
            onChangeText={setModel}
          />
          <TextInput
            style={styles.input}
            placeholder="Colour (optional)"
            value={color}
            onChangeText={setColor}
          />
          <TouchableOpacity style={styles.button} onPress={addTaxi} disabled={busy}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Save vehicle</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text style={styles.taxiLine}>
            {taxi.plate} — {taxi.model}
            {taxi.color ? ` (${taxi.color})` : ''}
          </Text>

          {tokenBalance === 0 && (
            <TouchableOpacity style={styles.emptyBanner} onPress={() => setTokensOpen(true)}>
              <Text style={styles.emptyBannerTitle}>You are out of tokens</Text>
              <Text style={styles.emptyBannerBody}>
                Ride requests will not reach you until you top up. Tap to buy.
              </Text>
            </TouchableOpacity>
          )}

          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>{isOnline ? 'Online' : 'Offline'}</Text>
            <Switch value={isOnline} onValueChange={toggleOnline} disabled={busy} />
          </View>

          {isOnline && (
            <Text style={styles.trackingNote}>
              {backgroundTracking
                ? 'Background location on — requests reach you with the app closed.'
                : 'Foreground only — keep this app open to receive requests.'}
            </Text>
          )}

          {busy && <ActivityIndicator style={{ marginTop: 12 }} />}

          {activeRide?.status === 'matched' && (
            <View style={styles.rideCard}>
              <Text style={styles.rideTitle}>New Ride Request</Text>
              <Text style={styles.rideDetail}>Pickup: {pickupLabel}</Text>
              <Text style={styles.rideDetail}>
                Drop-off: {activeRide.dest_address || 'Not specified'}
              </Text>
              <Text style={offerExpired ? styles.expiredText : styles.countdownText}>
                {offerExpired
                  ? 'Offer expired — passing to another driver…'
                  : `Respond within ${secondsLeft ?? OFFER_TIMEOUT_SECONDS}s`}
              </Text>
              <View style={styles.rideActions}>
                <TouchableOpacity
                  style={[
                    styles.rideButton,
                    styles.acceptButton,
                    offerExpired && styles.disabledButton,
                  ]}
                  onPress={acceptRide}
                  disabled={busy || offerExpired}
                >
                  <Text style={styles.rideButtonText}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.rideButton,
                    styles.declineButton,
                    offerExpired && styles.disabledButton,
                  ]}
                  onPress={declineRide}
                  disabled={busy || offerExpired}
                >
                  <Text style={styles.rideButtonText}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {stage && (
            <View style={styles.rideCard}>
              <View style={styles.stageHeader}>
                <Text style={styles.rideTitle}>{stage.title}</Text>
                <Text style={styles.stageStep}>
                  Step {stage.step} of {TRIP_STEP_COUNT}
                </Text>
              </View>

              <View style={styles.stageTrack}>
                {Array.from({ length: TRIP_STEP_COUNT }, (_, i) => (
                  <View
                    key={i}
                    style={[styles.stageDot, i < stage.step && styles.stageDotDone]}
                  />
                ))}
              </View>

              <Text style={styles.rideDetail}>Pickup: {pickupLabel}</Text>
              <Text style={styles.rideDetail}>
                Drop-off: {activeRide.dest_address || 'Not specified'}
              </Text>

              {activeRide.fare != null && (
                <Text style={styles.rideFare}>
                  Fare {activeRide.currency} {Number(activeRide.fare).toFixed(2)}
                  <Text style={styles.rideFareMuted}>
                    {'  '}({Number(activeRide.distance_km).toFixed(1)} km)
                  </Text>
                </Text>
              )}

              <Text style={styles.stageHint}>{stage.hint}</Text>

              {/* One button, labelled with the thing it actually does. It must
                  not carry styles.rideButton: that has flex:1 for the two-up
                  Accept/Decline row, which in this column collapses the button
                  to its padding and clips the label away. */}
              <TouchableOpacity
                style={[styles.stageButton, busy && styles.stageButtonBusy]}
                onPress={() => advanceRide(stage.next, stage.stamp)}
                disabled={busy}
                activeOpacity={0.85}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.stageButtonText}>{stage.action}</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* Held on screen after completion so the driver can read the amount
              out to the rider and collect it, rather than the card vanishing. */}
          {finishedRide && (
            <View style={styles.collectCard}>
              <Text style={styles.collectTitle}>Trip completed</Text>
              <Text style={styles.collectAmount}>
                {finishedRide.fare != null
                  ? `${finishedRide.currency} ${Number(finishedRide.fare).toFixed(2)}`
                  : 'Fare not priced'}
              </Text>
              <Text style={styles.collectBody}>
                {finishedRide.fare != null
                  ? 'Collect this amount from the rider in cash.'
                  : 'No distance was recorded, so agree the fare with the rider.'}
              </Text>
              <TouchableOpacity
                style={styles.collectDone}
                onPress={() => setFinishedRide(null)}
              >
                <Text style={styles.collectDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}

          {isOnline && !activeRide && (
            <Text style={styles.waitingText}>Waiting for ride requests…</Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 40,
    marginBottom: 24,
  },
  title: { fontSize: 22, fontWeight: '700' },
  logout: { color: '#c00', fontSize: 14 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  tokenChip: {
    backgroundColor: '#EDEFF7',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  tokenChipEmpty: { backgroundColor: '#F6E3E1' },
  tokenChipText: { color: '#1B2A6B', fontWeight: '700', fontSize: 13 },
  tokenChipTextEmpty: { color: '#B0473F' },
  emptyBanner: {
    backgroundColor: '#F6E3E1',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  emptyBannerTitle: { color: '#B0473F', fontWeight: '800', marginBottom: 2 },
  emptyBannerBody: { color: '#8A3A34', fontSize: 13 },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 4 },
  hint: { color: '#666', marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  taxiLine: { fontSize: 15, color: '#444', marginBottom: 12 },
  statusCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 18,
  },
  statusLabel: { fontSize: 18, fontWeight: '600' },
  rideCard: {
    marginTop: 24,
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 18,
  },
  rideTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  rideDetail: { color: '#ddd', fontSize: 14, marginBottom: 8 },
  rideActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  rideButton: { flex: 1, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 8 },
  acceptButton: { backgroundColor: '#2e7d32' },
  declineButton: { backgroundColor: '#555' },
  rideButtonText: { color: '#fff', fontWeight: '600' },
  stageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  stageStep: { color: '#8d8d8d', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  stageTrack: { flexDirection: 'row', gap: 6, marginBottom: 14 },
  stageDot: { flex: 1, height: 3, borderRadius: 2, backgroundColor: '#2f2f2f' },
  stageDotDone: { backgroundColor: '#2e7d32' },
  stageHint: { color: '#9a9a9a', fontSize: 13, marginTop: 14, marginBottom: 4 },
  stageButton: {
    marginTop: 10,
    backgroundColor: '#2e7d32',
    borderRadius: 28,
    paddingVertical: 17,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  stageButtonBusy: { opacity: 0.7 },
  stageButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  rideFare: { color: '#7dd87d', fontSize: 17, fontWeight: '700', marginTop: 4, marginBottom: 4 },
  rideFareMuted: { color: '#8d8d8d', fontSize: 13, fontWeight: '500' },
  collectCard: {
    marginTop: 24,
    backgroundColor: '#0f2c14',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2e7d32',
    padding: 20,
    alignItems: 'center',
  },
  collectTitle: { color: '#9fe5a4', fontSize: 14, fontWeight: '600', letterSpacing: 1 },
  collectAmount: { color: '#fff', fontSize: 34, fontWeight: '800', marginTop: 6 },
  collectBody: { color: '#cfe8d2', fontSize: 14, textAlign: 'center', marginTop: 10 },
  collectDone: {
    marginTop: 16,
    alignSelf: 'stretch',
    backgroundColor: '#2e7d32',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  collectDoneText: { color: '#fff', fontWeight: '700' },
  trackingNote: { marginTop: 10, fontSize: 12, color: '#6B675E', textAlign: 'center' },
  countdownText: { color: '#7dd87d', fontSize: 13, fontWeight: '600', marginTop: 4 },
  expiredText: { color: '#e5a0a0', fontSize: 13, fontWeight: '600', marginTop: 4 },
  disabledButton: { opacity: 0.4 },
  waitingText: { textAlign: 'center', marginTop: 32, color: '#888' },
});
