import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { supabase } from '../lib/supabase';

// Buying ride tokens with Mobile Money.
//
// The flow is asynchronous and the driver cannot see any of it: they tap Buy,
// MTN pushes a PIN prompt to their phone, and the payment only settles once
// they approve it there. So this screen narrates every step — a spinner with no
// explanation while someone waits for a payment prompt that may never arrive is
// how drivers conclude the app took their money.

const BUNDLES = [5, 10, 25, 50];

// MTN can take a while to report a settled payment, and a driver may take a
// moment to find their phone and key in a PIN.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

export default function TokensScreen({ visible, session, balance, onClose, onBalanceChange }) {
  const [tokenPrice, setTokenPrice] = useState(null);
  const [currency, setCurrency] = useState('ZMW');
  const [quantity, setQuantity] = useState(10);
  const [phone, setPhone] = useState('');
  const [stage, setStage] = useState('idle'); // idle | starting | awaiting | done | failed
  const [message, setMessage] = useState(null);
  const [history, setHistory] = useState([]);
  const pollTimer = useRef(null);

  const loadPricing = useCallback(async () => {
    const { data } = await supabase
      .from('pricing').select('token_price, currency').eq('tier', 'standard').eq('active', true).maybeSingle();
    if (data) {
      setTokenPrice(Number(data.token_price));
      setCurrency(data.currency);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from('token_ledger')
      .select('id, delta, reason, created_at, balance_after')
      .order('created_at', { ascending: false })
      .limit(10);
    setHistory(data ?? []);
  }, []);

  useEffect(() => {
    if (!visible) return;
    loadPricing();
    loadHistory();
    // Prefill from the profile so a driver does not retype their own number.
    supabase
      .from('profiles').select('phone').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => {
        if (data?.phone && !phone) setPhone(data.phone);
      });
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [visible, loadPricing, loadHistory]);

  const finish = useCallback(
    async (nextStage, text) => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
      setStage(nextStage);
      setMessage(text);
      await loadHistory();
      onBalanceChange?.();
    },
    [loadHistory, onBalanceChange]
  );

  const startPolling = useCallback(
    (referenceId) => {
      const startedAt = Date.now();
      pollTimer.current = setInterval(async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          // Deliberately not called a failure: the payment may still settle, and
          // the next poll from a reopened screen would pick it up.
          finish(
            'failed',
            'No confirmation from Mobile Money yet. If you approved the payment, your tokens will appear shortly — reopen this screen to check.'
          );
          return;
        }
        const { data, error } = await supabase.functions.invoke('driver-check-topup', {
          body: { reference_id: referenceId },
        });
        if (error) return; // transient; keep polling until the timeout
        if (data?.status === 'SUCCESSFUL') {
          finish('done', `${data.tokens} tokens added. Your credit is now ${currency} ${Number(data.credit_balance).toFixed(2)}.`);
        } else if (data?.status === 'FAILED') {
          finish('failed', 'The payment was declined or cancelled. Nothing has been charged.');
        }
      }, POLL_INTERVAL_MS);
    },
    [finish]
  );

  const buy = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9) {
      Alert.alert('Check the number', 'Enter the Mobile Money number to charge.');
      return;
    }
    setStage('starting');
    setMessage(null);
    const { data, error } = await supabase.functions.invoke('driver-buy-tokens', {
      body: { quantity, phone: digits },
    });
    if (error) {
      const detail = await error.context?.text?.().catch(() => null);
      let text = 'Could not start the payment.';
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error) text = parsed.error;
      } catch {
        /* keep the generic message */
      }
      setStage('failed');
      setMessage(text);
      return;
    }
    setStage('awaiting');
    setMessage(
      `Check your phone. Approve the ${data.currency} ${data.amount} payment with your Mobile Money PIN.`
    );
    startPolling(data.reference_id);
  };

  const busy = stage === 'starting' || stage === 'awaiting';
  const total = tokenPrice != null ? (tokenPrice * quantity).toFixed(2) : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={busy ? undefined : onClose}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
        <Text style={styles.title}>Ride tokens</Text>

        <View style={styles.balanceCard}>
          <Text style={styles.balanceValue}>
            {balance == null ? '—' : `${currency} ${Number(balance).toFixed(2)}`}
          </Text>
          <Text style={styles.balanceLabel}>credit</Text>
          <Text style={styles.balanceHint}>
            DOTS takes its commission from this after each ride. Cash fares are yours.
          </Text>
          {balance != null && balance <= 0 && (
            <Text style={styles.balanceWarn}>
              {balance < 0
                ? `You owe DOTS ${currency} ${Math.abs(balance).toFixed(2)} from your last ride. `
                : ''}
              You will not receive ride requests until you top up.
            </Text>
          )}
        </View>

        <Text style={styles.section}>How many?</Text>
        <View style={styles.bundleRow}>
          {BUNDLES.map((n) => (
            <TouchableOpacity
              key={n}
              style={[styles.bundle, quantity === n && styles.bundleActive]}
              onPress={() => setQuantity(n)}
              disabled={busy}
            >
              <Text style={[styles.bundleNum, quantity === n && styles.bundleNumActive]}>
                {tokenPrice != null ? `K${(n * tokenPrice).toFixed(0)}` : n}
              </Text>
              <Text style={[styles.bundleSub, quantity === n && styles.bundleSubActive]}>
                {n} tokens
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {total && (
          <Text style={styles.total}>
            {currency} {total}
            <Text style={styles.totalMuted}>
              {'  '}({currency} {tokenPrice.toFixed(2)} per token)
            </Text>
          </Text>
        )}

        <Text style={styles.section}>Mobile Money number</Text>
        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="e.g. 0970000000"
          keyboardType="phone-pad"
          editable={!busy}
        />

        {message && (
          <Text
            style={[
              styles.message,
              stage === 'done' && styles.messageGood,
              stage === 'failed' && styles.messageBad,
            ]}
          >
            {message}
          </Text>
        )}

        <TouchableOpacity
          style={[styles.buy, busy && styles.buyDisabled]}
          onPress={buy}
          disabled={busy}
        >
          {busy ? (
            <View style={styles.buyBusy}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.buyText}>
                {stage === 'starting' ? 'Starting…' : 'Waiting for your PIN…'}
              </Text>
            </View>
          ) : (
            <Text style={styles.buyText}>Buy {quantity} tokens</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.close} onPress={onClose} disabled={busy}>
          <Text style={[styles.closeText, busy && styles.closeDisabled]}>
            {busy ? 'Please wait…' : 'Close'}
          </Text>
        </TouchableOpacity>

        {history.length > 0 && (
          <>
            <Text style={styles.section}>Recent activity</Text>
            {history.map((row) => (
              <View key={row.id} style={styles.historyRow}>
                <Text style={styles.historyReason}>
                  {row.reason === 'commission'
                    ? 'DOTS commission'
                    : row.reason === 'ride'
                    ? 'Completed ride'
                    : row.reason === 'topup'
                    ? 'Tokens purchased'
                    : row.reason === 'signup_bonus'
                    ? 'Starting balance'
                    : row.reason === 'refund'
                    ? 'Refund'
                    : 'Adjustment'}
                </Text>
                <Text style={[styles.historyDelta, row.delta > 0 && styles.historyDeltaUp]}>
                  {row.delta > 0 ? '+' : ''}{Number(row.delta).toFixed(2)}
                </Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#fff' },
  container: { padding: 20, paddingTop: 50, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 16 },
  balanceCard: {
    backgroundColor: '#F4F5FA',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 22,
  },
  balanceValue: { fontSize: 44, fontWeight: '800', color: '#111' },
  balanceLabel: { color: '#6B675E', marginTop: 2 },
  balanceHint: { color: '#8A867D', fontSize: 12, marginTop: 8, textAlign: 'center', lineHeight: 17 },
  balanceWarn: { color: '#B0473F', fontWeight: '700', marginTop: 10, textAlign: 'center' },
  section: { fontSize: 13, fontWeight: '700', color: '#6B675E', marginBottom: 8, marginTop: 4 },
  bundleRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  bundle: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#DDD',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  bundleActive: { borderColor: '#1B2A6B', backgroundColor: '#1B2A6B' },
  bundleNum: { fontSize: 18, fontWeight: '700', color: '#111' },
  bundleNumActive: { color: '#fff' },
  bundleSub: { fontSize: 11, color: '#6B675E', marginTop: 2 },
  bundleSubActive: { color: '#C9CFEA' },
  total: { fontSize: 20, fontWeight: '800', marginBottom: 18 },
  totalMuted: { fontSize: 13, fontWeight: '400', color: '#6B675E' },
  input: {
    borderWidth: 1,
    borderColor: '#DDD',
    borderRadius: 10,
    padding: 13,
    fontSize: 16,
    marginBottom: 16,
  },
  message: { marginBottom: 14, color: '#111', lineHeight: 20 },
  messageGood: { color: '#1E7A34', fontWeight: '600' },
  messageBad: { color: '#B0473F', fontWeight: '600' },
  buy: {
    backgroundColor: '#1B2A6B',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
  },
  buyDisabled: { opacity: 0.75 },
  buyBusy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  buyText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  close: { padding: 14, alignItems: 'center', marginBottom: 6 },
  closeText: { color: '#6B675E' },
  closeDisabled: { opacity: 0.5 },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#EEE',
  },
  historyReason: { color: '#444' },
  historyDelta: { fontWeight: '700', color: '#B0473F' },
  historyDeltaUp: { color: '#1E7A34' },
});
