import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TouchableOpacity,
} from 'react-native';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { colors, weight } from '../lib/theme';
import { kwacha, money } from '../lib/format';
import {
  Screen,
  Card,
  Label,
  Field,
  PrimaryButton,
  SecondaryButton,
  Toggle,
  Timeline,
  FieldStatic,
  Progress,
  Notice,
  Hint,
} from '../components/ui';
import RiderCard from '../components/RiderCard';
import VehiclePhotos from '../components/VehiclePhotos';
import { PHOTO_SLOTS } from '../lib/vehiclePhotos';
import { unregisterPushNotifications } from '../lib/push';
import { Notifications, pushSupported } from '../lib/pushModule';
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

export default function DriverHomeScreen({ session, onNavigate, logoutRef, refreshSignal }) {
  const driverId = session.user.id;

  const [taxi, setTaxi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeRide, setActiveRide] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [backgroundTracking, setBackgroundTracking] = useState(false);
  const [tokenBalance, setTokenBalance] = useState(null);
  // The just-finished ride, kept after `activeRide` clears so the driver still
  // has the amount on screen to read out and collect.
  const [finishedRide, setFinishedRide] = useState(null);

  const [plate, setPlate] = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  // Photos chosen for registration (or a resubmission), keyed by slot.
  const [photos, setPhotos] = useState({});
  // A declined vehicle re-enters review through the same photo tiles.
  const [resubmitting, setResubmitting] = useState(false);

  const channelRef = useRef(null);
  const foregroundWatchRef = useRef(null);

  const isOnline = taxi?.status === 'Online';

  // Dispatch skips a driver on zero, so this number decides whether they get
  // work at all. Refetched whenever it could have moved rather than cached.
  const fetchTokenBalance = useCallback(async () => {
    const { data } = await supabase
      .from('driver_wallets')
      .select('credit_balance')
      .eq('driver_id', driverId)
      .maybeSingle();
    setTokenBalance(Number(data?.credit_balance ?? 0));
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
    const missing = PHOTO_SLOTS.filter((slot) => !photos[slot.key]);
    if (missing.length > 0) {
      Alert.alert(
        'Photos needed',
        `Add the ${missing.map((m) => m.label.toLowerCase()).join(', ')} photo${missing.length > 1 ? 's' : ''} so DOTS can approve the vehicle.`
      );
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
        photo_paths: PHOTO_SLOTS.map((slot) => photos[slot.key].path),
        submitted_at: new Date().toISOString(),
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
        // Re-read rather than reusing activeRide: the commission split is
        // written by an AFTER UPDATE trigger, so it does not exist on the copy
        // we held a moment ago. Fall back to that copy if the read fails —
        // the fare alone is still worth showing.
        const { data: settled } = await supabase
          .from('rides')
          .select('*')
          .eq('id', activeRide.id)
          .maybeSingle();
        setFinishedRide(settled ?? activeRide);
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

  // New photos for a declined vehicle. The database allows exactly this move
  // (declined -> pending) and nothing else on approval from a driver.
  const resubmitPhotos = async () => {
    const missing = PHOTO_SLOTS.filter((slot) => !photos[slot.key]);
    if (missing.length > 0) {
      Alert.alert('Photos needed', 'Add all three photos before resubmitting.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase
        .from('taxis')
        .update({
          photo_paths: PHOTO_SLOTS.map((slot) => photos[slot.key].path),
          approval_status: 'pending',
        })
        .eq('id', taxi.id);
      if (error) throw error;
      setResubmitting(false);
      setPhotos({});
      await fetchTaxi();
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

  // Account's Log out has to do everything this screen's does — taxi offline,
  // tracking stopped, push token removed — so it borrows this function.
  useEffect(() => {
    if (logoutRef) logoutRef.current = handleLogout;
  });

  // A top-up on the Wallet tab changes the number shown here.
  useEffect(() => {
    if (refreshSignal) fetchTokenBalance();
  }, [refreshSignal, fetchTokenBalance]);

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
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  const outOfCredit = tokenBalance != null && tokenBalance <= 0;

  return (
    <Screen role="DRIVER" keyboard>
      {!taxi ? (
        <Card style={{ gap: 16 }}>
          <Label>REGISTER YOUR VEHICLE</Label>
          <Hint>You need a registered vehicle before you can go online.</Hint>
          <Field label="PLATE NUMBER" value={plate} onChangeText={setPlate} autoCapitalize="characters" placeholder="e.g. BAX 1234" />
          <Field label="MODEL" value={model} onChangeText={setModel} placeholder="e.g. Honda Fit 2009" />
          <Field label="COLOUR (OPTIONAL)" value={color} onChangeText={setColor} placeholder="e.g. Black" />
          <VehiclePhotos driverId={driverId} photos={photos} onChange={setPhotos} disabled={busy} />
          <PrimaryButton title="SUBMIT FOR APPROVAL" onPress={addTaxi} busy={busy} />
        </Card>
      ) : (
        <>
          {outOfCredit && (
            <Notice
              tone="red"
              title="You are out of credit"
              body="Ride requests will not reach you until you top up. Tap to open your wallet."
              onPress={() => onNavigate?.('wallet')}
            />
          )}

          {taxi.approval_status === 'pending' && (
            <Notice
              tone="brand"
              title="Vehicle under review"
              body="DOTS staff are checking your photos. You can go online as soon as it is approved."
            />
          )}
          {taxi.approval_status === 'declined' && !resubmitting && (
            <Notice
              tone="red"
              title="Vehicle not approved"
              body={`${taxi.declined_reason ? taxi.declined_reason + ' ' : ''}Tap to submit new photos.`}
              onPress={() => setResubmitting(true)}
            />
          )}
          {taxi.approval_status === 'declined' && resubmitting && (
            <Card style={{ gap: 16 }}>
              <Label>NEW PHOTOS</Label>
              {taxi.declined_reason ? <Hint>Reason given: {taxi.declined_reason}</Hint> : null}
              <VehiclePhotos driverId={driverId} photos={photos} onChange={setPhotos} disabled={busy} />
              <PrimaryButton title="RESUBMIT FOR APPROVAL" onPress={resubmitPhotos} busy={busy} />
              <SecondaryButton title="Cancel" onPress={() => setResubmitting(false)} disabled={busy} />
            </Card>
          )}

          <Card>
            <View style={styles.statusRow}>
              <View style={{ gap: 3, flex: 1 }}>
                <Label>STATUS</Label>
                <Text style={styles.statusText}>{isOnline ? 'Online' : 'Offline'}</Text>
                <Text style={styles.vehicle} numberOfLines={1}>
                  {taxi.plate} · {taxi.model}
                  {taxi.color ? ` · ${taxi.color}` : ''}
                </Text>
              </View>
              <View style={styles.statusRight}>
                <Toggle value={isOnline} onValueChange={toggleOnline} disabled={busy || taxi.approval_status !== 'approved'} />
                <TouchableOpacity onPress={() => onNavigate?.('wallet')} hitSlop={8}>
                  <Text style={[styles.credit, outOfCredit && styles.creditEmpty]}>
                    {tokenBalance == null ? '—' : `${kwacha(tokenBalance)} credit`}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
            {isOnline && (
              <Hint style={{ marginTop: 10 }}>
                {backgroundTracking
                  ? 'Background location on — requests reach you with the app closed.'
                  : 'Foreground only — keep this app open to receive requests.'}
              </Hint>
            )}
          </Card>

          {busy && !activeRide && <ActivityIndicator color={colors.brand} />}

          {activeRide?.status === 'matched' && (
            <Card style={{ gap: 14 }}>
              <View style={styles.cardHead}>
                <Label>NEW RIDE REQUEST</Label>
                <Text style={offerExpired ? styles.expired : styles.countdown}>
                  {offerExpired ? 'Expired' : `${secondsLeft ?? OFFER_TIMEOUT_SECONDS}s`}
                </Text>
              </View>
              <Timeline
                top={<FieldStatic label="PICKUP" value={pickupLabel} />}
                bottom={<FieldStatic label="DROP-OFF" value={activeRide.dest_address || 'Not specified'} muted={!activeRide.dest_address} />}
              />
              <RiderCard ride={activeRide} showPhone={false} />
              {activeRide.fare != null && (
                <View style={styles.fareRow}>
                  <Label>FARE</Label>
                  <Text style={styles.fare}>{money(activeRide.fare, activeRide.currency)}</Text>
                </View>
              )}
              {offerExpired ? (
                <Hint>Offer expired — passing to another driver…</Hint>
              ) : (
                <Hint>Respond before the timer runs out or it goes to the next driver.</Hint>
              )}
              <PrimaryButton
                title="ACCEPT"
                onPress={acceptRide}
                disabled={busy || offerExpired}
                busy={busy}
              />
              <SecondaryButton
                title="Decline"
                onPress={declineRide}
                disabled={busy || offerExpired}
              />
            </Card>
          )}

          {stage && (
            <Card style={{ gap: 14 }}>
              <View style={styles.cardHead}>
                <Label>{`STEP ${stage.step} OF ${TRIP_STEP_COUNT}`}</Label>
                {activeRide.distance_km != null && (
                  <Text style={styles.meta}>
                    {Number(activeRide.distance_km).toFixed(1)} km
                    {activeRide.duration_min != null
                      ? ` · ${Math.round(Number(activeRide.duration_min))} min`
                      : ''}
                  </Text>
                )}
              </View>
              <Text style={styles.stageTitle}>{stage.title}</Text>
              <Progress steps={TRIP_STEP_COUNT} done={stage.step} />
              <Timeline
                top={<FieldStatic label="PICKUP" value={pickupLabel} />}
                bottom={<FieldStatic label="DROP-OFF" value={activeRide.dest_address || 'Not specified'} muted={!activeRide.dest_address} />}
              />
              <RiderCard ride={activeRide} showPhone />
              {activeRide.fare != null && (
                <View style={styles.fareRow}>
                  <Label>FARE</Label>
                  <Text style={styles.fare}>{money(activeRide.fare, activeRide.currency)}</Text>
                </View>
              )}
              <Hint>{stage.hint}</Hint>
              <PrimaryButton
                title={stage.action.toUpperCase()}
                onPress={() => advanceRide(stage.next, stage.stamp)}
                busy={busy}
              />
            </Card>
          )}

          {/* Held on screen after completion so the driver can read the amount
              out to the rider and collect it, rather than the card vanishing. */}
          {finishedRide && (
            <Card style={styles.collect}>
              <Label style={{ color: colors.green }}>TRIP COMPLETED</Label>
              <Text style={styles.collectAmount}>
                {finishedRide.fare != null ? money(finishedRide.fare, finishedRide.currency) : 'Fare not priced'}
              </Text>
              <Hint style={{ textAlign: 'center' }}>
                {finishedRide.fare != null
                  ? 'Collect this amount from the rider in cash.'
                  : 'No distance was recorded, so agree the fare with the rider.'}
              </Hint>

              {/* What the ride actually earned, once DOTS's share is out. The
                  driver should never have to work this out themselves. */}
              {finishedRide.driver_payout != null && (
                <View style={styles.split}>
                  <View style={styles.splitRow}>
                    <Text style={styles.splitLabel}>
                      DOTS {(Number(finishedRide.commission_rate) * 100).toFixed(0)}%
                    </Text>
                    <Text style={styles.splitValue}>
                      −{money(finishedRide.commission_amount, finishedRide.currency)}
                    </Text>
                  </View>
                  <View style={styles.splitRow}>
                    <Text style={styles.splitStrong}>You keep</Text>
                    <Text style={styles.splitStrongValue}>
                      {money(finishedRide.driver_payout, finishedRide.currency)}
                    </Text>
                  </View>
                </View>
              )}
              <PrimaryButton title="DONE" onPress={() => setFinishedRide(null)} arrow={false} />
            </Card>
          )}

          {isOnline && !activeRide && !finishedRide && (
            <Text style={styles.waiting}>Waiting for ride requests…</Text>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusText: { fontSize: 17, ...weight('700'), color: colors.ink },
  vehicle: { ...weight('400'), fontSize: 12, color: colors.muted },
  statusRight: { alignItems: 'flex-end', gap: 8 },
  credit: { fontSize: 13, ...weight('800'), color: colors.green },
  creditEmpty: { ...weight('400'), color: colors.red },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  meta: { fontSize: 12, ...weight('600'), color: colors.muted },
  stageTitle: { fontSize: 21, ...weight('800'), letterSpacing: -0.2, color: colors.ink, marginTop: -6 },
  fareRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 2 },
  fare: { fontSize: 24, ...weight('800'), letterSpacing: -0.4, color: colors.green },
  countdown: { fontSize: 14, ...weight('800'), color: colors.green },
  expired: { fontSize: 14, ...weight('800'), color: colors.red },
  collect: { gap: 10, alignItems: 'center' },
  collectAmount: { fontSize: 36, ...weight('800'), letterSpacing: -0.8, color: colors.ink },
  split: { alignSelf: 'stretch', marginTop: 4, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line, gap: 6 },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between' },
  splitLabel: { ...weight('400'), fontSize: 14, color: colors.muted },
  splitValue: { fontSize: 14, ...weight('700'), color: colors.muted },
  splitStrong: { fontSize: 16, ...weight('800'), color: colors.ink },
  splitStrongValue: { fontSize: 18, ...weight('800'), color: colors.green },
  waiting: { ...weight('400'), textAlign: 'center', marginTop: 12, color: colors.muted },
});
