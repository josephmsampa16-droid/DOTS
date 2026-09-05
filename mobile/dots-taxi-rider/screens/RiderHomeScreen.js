import React, { useEffect, useRef, useState } from 'react';
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
import { colors } from '../lib/theme';
import { money } from '../lib/format';
import {
  Screen,
  Card,
  Label,
  Field,
  FieldStatic,
  PrimaryButton,
  SecondaryButton,
  Row,
  Timeline,
  TabStrip,
  Hint,
  Notice,
} from '../components/ui';
import { CarIcon, SwapIcon } from '../components/icons';

const TIERS = [
  { key: 'standard', label: 'Standard', Icon: CarIcon },
  { key: 'comfort', label: 'Comfort', Icon: CarIcon },
  { key: 'xl', label: 'XL', Icon: CarIcon },
];
import {
  registerForPushNotificationsAsync,
  unregisterPushNotificationsAsync,
} from '../lib/notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { describeCoords, lookupAddress } from '../lib/geocoding';
import DriverMap from '../components/DriverMap';
import DestinationPicker from '../components/DestinationPicker';

// Confirmed against the real Supabase schema — rides.status is constrained
// to exactly these values (check constraint on the table). `arrived` and
// `in_progress` are the trip stages the driver reports on their way through
// the ride.
const STATUS_LABELS = {
  requested: 'Looking for a nearby driver…',
  matched: 'Driver found — waiting for confirmation',
  accepted: 'Driver is on the way',
  arrived: 'Your driver is here',
  in_progress: 'On your way',
  completed: 'Trip completed',
  declined: 'Driver unavailable — searching again',
  no_drivers: 'No drivers available right now',
  cancelled: 'Ride cancelled',
};

const TERMINAL_STATUSES = ['completed', 'no_drivers', 'cancelled'];

// Every status where the ride is still live and the rider should be looking at
// it — reopening the app mid-trip has to bring them back to this.
const ACTIVE_STATUSES = ['requested', 'matched', 'accepted', 'arrived', 'in_progress'];

// A trip can finish while the rider has the app closed — that is the normal
// case, since they are in the car, not on their phone. Reopening has to still
// tell them what they owe, so a recent completion is looked up on launch.
const RECENT_COMPLETION_MINUTES = 30;

// The last ride whose fare the rider has acknowledged. Persisted so the amount
// is not shoved back at them every time they open the app after paying.
const SETTLED_RIDE_KEY = 'dots.rider.settledRideId';

// The stages where a driver is assigned and worth showing on the map.
const DRIVER_ON_MAP_STATUSES = ['matched', 'accepted', 'arrived', 'in_progress'];

export default function RiderHomeScreen({ session, logoutRef }) {
  const [location, setLocation] = useState(null);
  const [locationError, setLocationError] = useState(null);
  // Free-text addresses. Both are required: without a destination there is no
  // distance, so no fare — and the ride would reach the driver unpriced while
  // still costing them a token. rides_require_destination enforces the same
  // rule in the database, for anything that does not come through this screen.
  const [pickupAddress, setPickupAddress] = useState('');
  const [destAddress, setDestAddress] = useState('');
  const [prefillingPickup, setPrefillingPickup] = useState(false);
  // Coordinates the rider confirmed on the map. When set, these are used
  // instead of geocoding the typed text — the whole point of the picker.
  const [destCoords, setDestCoords] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  // Whether the current quote came from a confirmed pin or a typed guess, and
  // the place the geocoder actually chose, so a typed quote can be checked.
  const [quoteSource, setQuoteSource] = useState(null);
  const [quoteLabel, setQuoteLabel] = useState(null);
  // Standard, Comfort or XL. Each tier is priced by its own row in the
  // pricing table; the choice is sent with the quote and again on booking.
  const [serviceTier, setServiceTier] = useState('standard');
  const [activeRide, setActiveRide] = useState(null);
  // The ride that just finished, held on screen with the amount owed until the
  // rider dismisses it — the fare is the last thing they need, not the first
  // thing to disappear.
  const [finishedRide, setFinishedRide] = useState(null);
  const [busy, setBusy] = useState(false);
  const channelRef = useRef(null);

  useEffect(() => {
    registerForPushNotificationsAsync(session.user.id);
    getCurrentLocation();
    checkForActiveRide();
    subscribeToOwnRideUpdates();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  const getCurrentLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setLocationError('Location permission denied — enable it to request a ride.');
      return;
    }
    const pos = await Location.getCurrentPositionAsync({});
    setLocation(pos.coords);

    // Prefill the pickup field so the rider usually just confirms it instead
    // of typing. Leaves the field alone if they already started editing.
    setPrefillingPickup(true);
    const described = await describeCoords(pos.coords);
    setPrefillingPickup(false);
    if (described) {
      setPickupAddress((current) => (current.trim() ? current : described));
    }
  };

  const checkForActiveRide = async () => {
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('rider_id', session.user.id)
      .in('status', ACTIVE_STATUSES)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      setActiveRide(data);
      return;
    }

    // No live ride. If one finished recently and the rider never saw the
    // amount — the app was closed when the driver tapped Complete — show it
    // now. updated_at is maintained by trg_rides_updated_at on every update.
    const since = new Date(Date.now() - RECENT_COMPLETION_MINUTES * 60000).toISOString();
    const { data: done } = await supabase
      .from('rides')
      .select('*')
      .eq('rider_id', session.user.id)
      .eq('status', 'completed')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!done) return;

    let settledId = null;
    try {
      settledId = await AsyncStorage.getItem(SETTLED_RIDE_KEY);
    } catch {
      // A storage failure should cost the rider a repeated card, not the fare.
    }
    if (settledId !== done.id) setFinishedRide(done);
  };

  // Dismissing means "I have seen what I owe", so it is remembered across
  // launches rather than reappearing on the next open.
  const dismissFare = async () => {
    const settled = finishedRide;
    setFinishedRide(null);
    if (!settled) return;
    try {
      await AsyncStorage.setItem(SETTLED_RIDE_KEY, settled.id);
    } catch {
      // Nothing to do — worst case the card shows once more.
    }
  };

  const subscribeToOwnRideUpdates = () => {
    channelRef.current = supabase
      .channel('rider-ride-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rides',
          filter: `rider_id=eq.${session.user.id}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') return;
          const ride = payload.new;
          if (ride.status === 'completed') {
            // Not auto-dismissed: the rider has to pay this amount, so it
            // stays until they say they are done with it.
            setFinishedRide(ride);
            setActiveRide(null);
          } else if (TERMINAL_STATUSES.includes(ride.status)) {
            setActiveRide(ride);
            setTimeout(() => setActiveRide(null), 4000);
          } else {
            setActiveRide(ride);
          }
        }
      )
      .subscribe();
  };

  // Quote as soon as the rider has said where they are going — from a pin if
  // they set one, otherwise from what they typed, once they stop typing. The
  // price has to be visible before they commit, not after.
  //
  // A typed address is a guess: the geocoder picks a place and it may not be
  // the one they meant. So a typed quote always shows the place it actually
  // priced, which is the check that catches a wrong "Arcades" before anyone is
  // charged for it. A pinned destination needs no such caveat.
  //
  // The same quote_fare() runs again in the database on insert, so this is a
  // preview, never the authority.
  useEffect(() => {
    const typed = destAddress.trim();
    if (!location || (!destCoords && !typed)) {
      setQuote(null);
      setQuoteSource(null);
      setQuoteLabel(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setQuoting(true);
      let coords = destCoords;
      let label = null;

      if (!coords) {
        const hit = await lookupAddress(typed, location);
        if (cancelled) return;
        if (!hit) {
          setQuote(null);
          setQuoteSource('unresolved');
          setQuoteLabel(null);
          setQuoting(false);
          return;
        }
        coords = hit;
        // Name the place back to the rider so a wrong match is visible.
        label = await describeCoords(hit);
        if (cancelled) return;
      }

      const { data, error } = await supabase.rpc('quote_fare', {
        p_pickup_lat: location.latitude,
        p_pickup_lng: location.longitude,
        p_dest_lat: coords.latitude,
        p_dest_lng: coords.longitude,
        p_service_tier: serviceTier,
      });
      if (cancelled) return;
      setQuote(error ? null : data?.[0] ?? null);
      setQuoteSource(destCoords ? 'pin' : 'typed');
      setQuoteLabel(label);
      setQuoting(false);
    };

    // A pin is a deliberate act, so quote it at once. Typing is not — waiting
    // for a pause avoids geocoding every keystroke.
    const delay = destCoords ? 0 : 800;
    const timer = setTimeout(run, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [location, destCoords, destAddress, serviceTier]);

  const handleDestinationConfirmed = (picked) => {
    setPickerOpen(false);
    setDestCoords({ latitude: picked.latitude, longitude: picked.longitude });
    // Only fill the text box if the rider has not written their own wording;
    // their description of the place is usually better than the geocoder's.
    if (picked.address && !destAddress.trim()) setDestAddress(picked.address);
  };

  const requestRide = async () => {
    if (!location) {
      Alert.alert('Location needed', 'Waiting for your location — try again in a moment.');
      return;
    }
    const pickup = pickupAddress.trim();
    const destination = destAddress.trim();
    if (!pickup) {
      Alert.alert('Pickup needed', 'Enter a pickup address so your driver can find you.');
      return;
    }
    if (!destCoords && !destination) {
      Alert.alert(
        'Where are you going?',
        'Enter a drop-off address, or set it on the map. The fare is worked out ' +
          'from the distance, so we need to know where you are heading.'
      );
      return;
    }

    setBusy(true);
    try {
      // A pin the rider confirmed beats anything the geocoder guesses. Only
      // fall back to a text lookup when they never opened the map — and that
      // fallback is exactly the path that can place a destination on the wrong
      // continent, so the fare it produces is guarded server-side.
      const resolvedDest =
        destCoords ?? (destination ? await lookupAddress(destination, location) : null);

      // Typed text the geocoder cannot place would insert a null destination,
      // which the database now refuses. Say so in words the rider can act on
      // rather than letting the constraint speak for us.
      if (!resolvedDest) {
        Alert.alert(
          "We couldn't find that place",
          `"${destination}" did not match anywhere we recognise. Check the ` +
            'spelling, or tap "Set destination on map" to point at it.'
        );
        setBusy(false);
        return;
      }

      const { data, error } = await supabase
        .from('rides')
        .insert({
          rider_id: session.user.id,
          status: 'requested',
          pickup_lat: location.latitude,
          pickup_lng: location.longitude,
          pickup_address: pickup,
          dest_address: destination || null,
          dest_lat: resolvedDest.latitude,
          dest_lng: resolvedDest.longitude,
          service_tier: serviceTier,
        })
        .select()
        .single();

      if (error) throw error;
      setActiveRide(data);
      setDestCoords(null);
      setQuote(null);
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelRide = async () => {
    if (!activeRide) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('rides')
        .update({ status: 'cancelled' })
        .eq('id', activeRide.id);
      if (error) throw error;
      setActiveRide(null);
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    // Drop this device's token first — after signOut the RLS policy no longer
    // matches, so the delete would silently affect nothing.
    await unregisterPushNotificationsAsync(session.user.id);
    await supabase.auth.signOut();
  };

  // A ride needs somewhere to go before it can be priced, so the button stays
  // dimmed until the rider has said where. requestRide() checks again, since a
  // disabled button is a courtesy and not a guarantee.
  const canRequest = Boolean(location) && Boolean(destCoords || destAddress.trim());

  // Account's Log out borrows this screen's, which also removes the push
  // token while RLS still allows it.
  useEffect(() => {
    if (logoutRef) logoutRef.current = handleLogout;
  });

  // Swap pickup and drop-off text. A pin belonged to the old drop-off, so it
  // no longer stands for anything and is cleared.
  const swapAddresses = () => {
    setPickupAddress(destAddress);
    setDestAddress(pickupAddress);
    setDestCoords(null);
  };

  const routeLine = activeRide
    ? 'From ' +
      (activeRide.pickup_address || 'your location') +
      (activeRide.dest_address ? ' to ' + activeRide.dest_address : '')
    : null;

  const strip = !activeRide ? (
    <TabStrip items={TIERS} active={serviceTier} onChange={setServiceTier} />
  ) : null;

  const demandDown = quote?.demand_multiplier != null && Number(quote.demand_multiplier) < 1;
  const demandUp = quote?.demand_multiplier != null && Number(quote.demand_multiplier) > 1;

  return (
    <Screen role="RIDER" keyboard strip={strip}>
      {locationError && <Notice tone="red" title="Location needed" body={locationError} />}

      {!activeRide && (
        <>
          <Card style={{ paddingBottom: 16 }}>
            <Timeline
              top={
                <Field
                  label="FROM"
                  value={pickupAddress}
                  onChangeText={setPickupAddress}
                  placeholder={prefillingPickup ? 'Finding your address…' : 'Where are you?'}
                />
              }
              middle={
                <TouchableOpacity style={styles.swap} onPress={swapAddresses} hitSlop={8}>
                  <SwapIcon size={14} color={colors.brand} />
                </TouchableOpacity>
              }
              bottom={
                <Field
                  label="TO"
                  value={destAddress}
                  onChangeText={(text) => {
                    setDestAddress(text);
                    // Editing the text means they are describing somewhere
                    // else, so the old pin no longer stands for what they typed.
                    if (destCoords) setDestCoords(null);
                  }}
                  placeholder="Where do you want to go?"
                  returnKeyType="done"
                />
              }
            />
          </Card>

          <SecondaryButton
            title={destCoords ? 'Change destination on map' : 'Set destination on map'}
            onPress={() => setPickerOpen(true)}
            disabled={!location}
          />

          {(destCoords || destAddress.trim()) && (
            <Card style={{ gap: 10 }}>
              {quoting ? (
                <Hint>Working out the fare…</Hint>
              ) : quote?.fare != null ? (
                <>
                  <View style={styles.quoteHead}>
                    <Label large>FARE</Label>
                    <Text style={styles.meta}>
                      about {Number(quote.distance_km).toFixed(1)} km
                      {quote.duration_min != null
                        ? ` · around ${Math.round(Number(quote.duration_min))} min`
                        : ''}
                    </Text>
                  </View>
                  <Text style={styles.quoteFare}>{money(quote.fare, quote.currency)}</Text>

                  {/* The fare broken into its parts. A rider who can see how
                      the number was reached has no reason to suspect it. */}
                  {quote.base_fare != null && (
                    <View style={styles.breakdown}>
                      <Row label="Base fare" value={Number(quote.base_fare).toFixed(2)} />
                      <Row
                        label={`Distance · ${Number(quote.distance_km).toFixed(1)} km`}
                        value={Number(quote.distance_charge).toFixed(2)}
                      />
                      <Row
                        label={`Time · ${Math.round(Number(quote.duration_min))} min`}
                        value={Number(quote.time_charge).toFixed(2)}
                      />
                      {/* Only shown when demand actually moved the price, in
                          either direction — a silent multiplier is the thing
                          riders resent about other apps. */}
                      {(demandDown || demandUp) && (
                        <Row
                          label={demandDown ? 'Quiet right now — discount' : 'Busy right now'}
                          value={`×${Number(quote.demand_multiplier).toFixed(2)}`}
                          color={demandDown ? colors.green : colors.red}
                        />
                      )}
                    </View>
                  )}
                  {quoteSource === 'typed' && (
                    // A typed quote priced whatever the geocoder chose. Naming
                    // it is what lets the rider notice it picked the wrong one.
                    <Hint>
                      {quoteLabel ? `Priced to: ${quoteLabel}. ` : ''}
                      Not right? Set it on the map.
                    </Hint>
                  )}
                </>
              ) : quoteSource === 'unresolved' ? (
                <Notice
                  tone="amber"
                  title="Couldn't find that address"
                  body="Set the destination on the map to get a price."
                />
              ) : (
                // Server withheld a price: past max_trip_km, so the
                // destination is almost certainly not the one they meant.
                <Notice
                  tone="amber"
                  title={`That looks too far to price${
                    quote?.distance_km ? ` — about ${Number(quote.distance_km).toFixed(0)} km away` : ''
                  }`}
                  body={
                    (quoteLabel
                      ? `We found "${quoteLabel}", which is probably not the place you meant. `
                      : 'We could not place that address confidently. ') + 'Set it on the map instead.'
                  }
                />
              )}
            </Card>
          )}

          <Hint>
            {!location
              ? 'Getting your location…'
              : "We'll use your current location as the exact pickup point. The price you see is the price you pay, in cash to your driver."}
          </Hint>

          <PrimaryButton
            title={quote?.fare != null && !quoting ? `REQUEST RIDE · ${money(quote.fare, quote.currency)}` : 'REQUEST RIDE'}
            onPress={requestRide}
            disabled={!canRequest}
            busy={busy}
          />
        </>
      )}

      <DestinationPicker
        visible={pickerOpen}
        origin={location}
        onCancel={() => setPickerOpen(false)}
        onConfirm={handleDestinationConfirmed}
      />

      {activeRide && (
        <Card style={{ gap: 12 }}>
          <Label>YOUR RIDE</Label>
          <Text style={styles.statusText}>{STATUS_LABELS[activeRide.status] || activeRide.status}</Text>
          {activeRide.status === 'requested' && <ActivityIndicator color={colors.brand} />}
          <Timeline
            top={<FieldStatic label="FROM" value={activeRide.pickup_address || 'Your location'} />}
            bottom={<FieldStatic label="TO" value={activeRide.dest_address || 'Not specified'} />}
          />
          {activeRide.fare != null && (
            <View style={styles.quoteHead}>
              <Label>FARE</Label>
              <Text style={styles.rideFare}>
                {money(activeRide.fare, activeRide.currency)}
                <Text style={styles.meta}>
                  {'  '}({Number(activeRide.distance_km).toFixed(1)} km)
                </Text>
              </Text>
            </View>
          )}
          {['requested', 'matched', 'no_drivers'].includes(activeRide.status) && (
            <SecondaryButton title="Cancel request" onPress={cancelRide} disabled={busy} tone="danger" />
          )}
        </Card>
      )}

      {/* What the rider owes, shown the moment the driver completes the trip.
          The driver sees the same number on their own screen. */}
      {finishedRide && (
        <Card style={styles.pay}>
          <Label style={{ color: colors.green }}>TRIP COMPLETED</Label>
          <Text style={styles.payLead}>Amount to pay your driver</Text>
          <Text style={styles.payAmount}>
            {finishedRide.fare != null ? money(finishedRide.fare, finishedRide.currency) : 'Not priced'}
          </Text>
          {finishedRide.distance_km != null && (
            <Text style={styles.meta}>{Number(finishedRide.distance_km).toFixed(1)} km trip</Text>
          )}
          <Hint style={{ textAlign: 'center' }}>
            {finishedRide.fare != null
              ? 'Pay your driver in cash.'
              : 'No distance was recorded — agree the fare with your driver.'}
          </Hint>
          <PrimaryButton title="DONE" onPress={dismissFare} arrow={false} />
        </Card>
      )}

      {activeRide &&
        activeRide.driver_id &&
        DRIVER_ON_MAP_STATUSES.includes(activeRide.status) && (
          <Card pad={0} style={{ overflow: 'hidden' }}>
            <DriverMap ride={activeRide} />
          </Card>
        )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  swap: {
    width: 30,
    height: 30,
    borderRadius: 999,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  quoteHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  meta: { fontSize: 12, fontWeight: '600', color: colors.muted },
  quoteFare: { fontSize: 30, fontWeight: '800', letterSpacing: -0.6, color: colors.ink, marginTop: -4 },
  breakdown: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10, gap: 6 },
  statusText: { fontSize: 21, fontWeight: '800', letterSpacing: -0.2, color: colors.ink, marginTop: -6 },
  rideFare: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, color: colors.green },
  pay: { gap: 8, alignItems: 'center' },
  payLead: { fontSize: 14, color: colors.muted },
  payAmount: { fontSize: 38, fontWeight: '800', letterSpacing: -0.8, color: colors.ink },
});
