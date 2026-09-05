import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, weight } from '../lib/theme';
import { kwacha } from '../lib/format';
import { Screen, Card, Label, Field, PrimaryButton, Row, Hint } from '../components/ui';

// The driver's credit, and buying more of it with Mobile Money.
//
// The purchase is asynchronous and the driver cannot see any of it: they tap
// Buy, MTN pushes a PIN prompt to their phone, and the payment only settles
// once they approve it there. So this screen narrates every step — a spinner
// with no explanation while someone waits for a payment prompt that may never
// arrive is how drivers conclude the app took their money.

const BUNDLES = [5, 10, 25, 50];

// MTN can take a while to report a settled payment, and a driver may take a
// moment to find their phone and key in a PIN.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

const REASON_LABELS = {
  commission: 'DOTS commission',
  ride: 'Completed ride',
  topup: 'Tokens purchased',
  signup_bonus: 'Starting balance',
  refund: 'Refund',
  adjustment: 'Adjustment',
};

export default function WalletScreen({ session, active, onBalanceChange }) {
  const [balance, setBalance] = useState(null);
  const [tokenPrice, setTokenPrice] = useState(null);
  const [currency, setCurrency] = useState('ZMW');
  const [quantity, setQuantity] = useState(10);
  const [phone, setPhone] = useState('');
  const [stage, setStage] = useState('idle'); // idle | starting | awaiting | done | failed
  const [message, setMessage] = useState(null);
  const [history, setHistory] = useState([]);
  const pollTimer = useRef(null);

  const loadBalance = useCallback(async () => {
    const { data } = await supabase
      .from('driver_wallets')
      .select('credit_balance')
      .eq('driver_id', session.user.id)
      .maybeSingle();
    setBalance(Number(data?.credit_balance ?? 0));
  }, [session.user.id]);

  const loadPricing = useCallback(async () => {
    const { data } = await supabase
      .from('pricing')
      .select('token_price, currency')
      .eq('tier', 'standard')
      .eq('active', true)
      .maybeSingle();
    if (data) {
      setTokenPrice(Number(data.token_price));
      setCurrency(data.currency);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from('token_ledger')
      .select('id, delta, reason, created_at, balance_after, note')
      .order('created_at', { ascending: false })
      .limit(12);
    setHistory(data ?? []);
  }, []);

  useEffect(() => {
    if (!active) return;
    loadBalance();
    loadPricing();
    loadHistory();
    // Prefill from the profile so a driver does not retype their own number.
    supabase
      .from('profiles')
      .select('phone')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.phone) setPhone((current) => current || data.phone);
      });
  }, [active, loadBalance, loadPricing, loadHistory, session.user.id]);

  useEffect(
    () => () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    },
    []
  );

  const finish = useCallback(
    async (nextStage, text) => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
      setStage(nextStage);
      setMessage(text);
      await Promise.all([loadHistory(), loadBalance()]);
      onBalanceChange?.();
    },
    [loadHistory, loadBalance, onBalanceChange]
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
            'No confirmation from Mobile Money yet. If you approved the payment, your credit will appear shortly — reopen this screen to check.'
          );
          return;
        }
        const { data, error } = await supabase.functions.invoke('driver-check-topup', {
          body: { reference_id: referenceId },
        });
        if (error) return; // transient; keep polling until the timeout
        if (data?.status === 'SUCCESSFUL') {
          finish(
            'done',
            `${data.tokens} tokens added. Your credit is now ${currency} ${Number(data.credit_balance).toFixed(2)}.`
          );
        } else if (data?.status === 'FAILED') {
          finish('failed', 'The payment was declined or cancelled. Nothing has been charged.');
        }
      }, POLL_INTERVAL_MS);
    },
    [finish, currency]
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
  const total = tokenPrice != null ? (tokenPrice * quantity).toFixed(0) : null;

  return (
    <Screen role="DRIVER" keyboard>
      <Card style={{ gap: 6 }}>
        <Label>CREDIT</Label>
        <Text style={styles.balance}>{balance == null ? '—' : kwacha(balance)}</Text>
        <Hint>DOTS takes its commission from this after each ride. Cash fares are yours.</Hint>
        {balance != null && balance <= 0 && (
          <Text style={styles.warn}>
            {balance < 0 ? `You owe DOTS ${kwacha(Math.abs(balance))} from your last ride. ` : ''}
            You will not receive ride requests until you top up.
          </Text>
        )}
      </Card>

      <Card style={{ gap: 14 }}>
        <Label>TOP UP</Label>
        <View style={styles.bundles}>
          {BUNDLES.map((n) => {
            const on = quantity === n;
            return (
              <TouchableOpacity
                key={n}
                style={[styles.bundle, on && styles.bundleOn]}
                onPress={() => setQuantity(n)}
                disabled={busy}
                activeOpacity={0.8}
              >
                <Text style={[styles.bundleAmount, on && styles.bundleTextOn]}>
                  {tokenPrice != null ? `K${(n * tokenPrice).toFixed(0)}` : n}
                </Text>
                <Text style={[styles.bundleSub, on && styles.bundleSubOn]}>{n} tokens</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Field
          label="MOBILE MONEY NUMBER"
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

        <PrimaryButton
          title={
            busy
              ? stage === 'starting'
                ? 'STARTING…'
                : 'WAITING FOR YOUR PIN…'
              : total
              ? `BUY ${quantity} TOKENS · K${total}`
              : `BUY ${quantity} TOKENS`
          }
          onPress={buy}
          busy={stage === 'starting'}
          disabled={busy}
          arrow={!busy}
        />
      </Card>

      {history.length > 0 && (
        <Card style={{ gap: 10 }}>
          <Label>RECENT ACTIVITY</Label>
          {history.map((row) => {
            const up = Number(row.delta) > 0;
            return (
              <Row
                key={row.id}
                label={
                  row.reason === 'commission' && row.note
                    ? row.note.replace(/^DOTS /, 'DOTS commission · ')
                    : REASON_LABELS[row.reason] ?? 'Adjustment'
                }
                value={`${up ? '+' : ''}${Number(row.delta).toFixed(2)}`}
                color={up ? colors.green : colors.red}
              />
            );
          })}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  balance: { fontSize: 40, ...weight('800'), letterSpacing: -1, color: colors.ink, lineHeight: 44 },
  warn: { color: colors.red, ...weight('700'), marginTop: 6, lineHeight: 19 },
  bundles: { flexDirection: 'row', gap: 8 },
  bundle: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#d9d9d9',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    gap: 2,
  },
  bundleOn: { borderColor: colors.brand, backgroundColor: colors.brand },
  bundleAmount: { fontSize: 18, ...weight('800'), color: colors.ink },
  bundleTextOn: { ...weight('400'), color: colors.white },
  bundleSub: { fontSize: 11, ...weight('600'), color: colors.muted },
  bundleSubOn: { ...weight('400'), color: colors.onBrandMuted },
  message: { ...weight('400'), color: colors.ink, lineHeight: 20 },
  messageGood: { color: colors.green, ...weight('600') },
  messageBad: { color: colors.red, ...weight('600') },
});
