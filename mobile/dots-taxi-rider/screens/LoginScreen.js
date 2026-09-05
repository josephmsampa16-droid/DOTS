import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';
import { Screen, Card, Field, PrimaryButton } from '../components/ui';

export default function LoginScreen() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!email || !password) {
      Alert.alert('Missing info', 'Email and password are required.');
      return;
    }
    setLoading(true);
    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              name: name.trim(),
              phone: phone.trim(),
              intended_role: 'Rider',
            },
          },
        });
        if (error) throw error;
        Alert.alert('Check your email', 'Confirm your account, then log in.');
        setIsSignUp(false);
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen role="RIDER" keyboard>
      <Text style={styles.title}>{isSignUp ? 'Create your account' : 'Welcome back'}</Text>

      <Card style={styles.form}>
        {isSignUp && (
          <>
            <Field label="FULL NAME" value={name} onChangeText={setName} placeholder="Your name" />
            <Field label="PHONE" value={phone} onChangeText={setPhone} placeholder="097 000 0000" keyboardType="phone-pad" />
          </>
        )}
        <Field
          label="EMAIL"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <Field
          label="PASSWORD"
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          secureTextEntry
        />
        <PrimaryButton
          title={isSignUp ? 'SIGN UP' : 'LOG IN'}
          onPress={handleSubmit}
          busy={loading}
          style={{ marginTop: 6 }}
        />
      </Card>

      <TouchableOpacity onPress={() => setIsSignUp(!isSignUp)} style={styles.switch}>
        <Text style={styles.switchText}>
          {isSignUp ? 'Already have an account? ' : "Don't have an account? "}
          <Text style={styles.switchLink}>{isSignUp ? 'Log in' : 'Sign up'}</Text>
        </Text>
      </TouchableOpacity>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.3, color: colors.ink, marginTop: 6 },
  form: { gap: 18 },
  switch: { alignItems: 'center', paddingVertical: 10 },
  switchText: { color: colors.muted, fontSize: 14 },
  switchLink: { color: colors.brand, fontWeight: '800' },
});
