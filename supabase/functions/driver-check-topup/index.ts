// driver-check-topup
//
// Polled by the driver app after driver-buy-tokens. Asks MTN for the status of
// a Request to Pay and, the first time it comes back SUCCESSFUL, credits the
// wallet. adjust_tokens converts the token count to kwacha at token_price.
//
// Separate from mtn-check-payment rather than an extra branch inside it: that
// one is staff-only and confirms bookings, and widening its auth so drivers
// could call it would also let them poll every booking payment in the system.
// A second, narrower function keeps the blast radius small.
//
// Crediting is guarded twice over. This checks the stored status first, and the
// database enforces a unique index on token_ledger(momo_transaction_id) where
// reason = 'topup'. Two polls racing cannot both credit: the second insert is
// refused by the database rather than relying on this code winning the race.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function currentBalance(admin: any, driverId: string) {
  const { data } = await admin
    .from('driver_wallets').select('credit_balance').eq('driver_id', driverId).maybeSingle();
  return Number(data?.credit_balance ?? 0);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    const { reference_id } = await req.json().catch(() => ({}));
    if (!reference_id) return json({ error: 'reference_id is required' }, 400);

    const { data: txn } = await admin
      .from('momo_transactions').select('*').eq('external_reference', reference_id).maybeSingle();
    if (!txn) return json({ error: 'Transaction not found' }, 404);

    // A driver may only ever look at their own top-up. Checked against the JWT,
    // not against anything in the request body.
    if (txn.purpose !== 'token_topup' || txn.driver_id !== user.id) {
      return json({ error: 'Not your transaction' }, 403);
    }

    if (txn.status === 'SUCCESSFUL' || txn.status === 'FAILED') {
      return json({
        status: txn.status,
        credit_balance: await currentBalance(admin, user.id),
      }, 200);
    }

    const environment = Deno.env.get('MTN_ENVIRONMENT') || 'sandbox';
    const targetEnvironment = Deno.env.get('MTN_TARGET_ENVIRONMENT') || 'sandbox';
    const base = environment === 'production'
      ? 'https://momodeveloper.mtn.com'
      : 'https://sandbox.momodeveloper.mtn.com';
    const subscriptionKey = Deno.env.get('MTN_SUBSCRIPTION_KEY')!;
    const apiUser = Deno.env.get('MTN_API_USER')!;
    const apiKey = Deno.env.get('MTN_API_KEY')!;

    const tokenRes = await fetch(`${base}/collection/token/`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Authorization': 'Basic ' + btoa(`${apiUser}:${apiKey}`),
      },
    });
    if (!tokenRes.ok) return json({ error: 'MTN auth failed', detail: await tokenRes.text() }, 502);
    const tokenData = await tokenRes.json();

    const statusRes = await fetch(`${base}/collection/v1_0/requesttopay/${reference_id}`, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'X-Target-Environment': targetEnvironment,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
      },
    });
    if (!statusRes.ok) {
      return json({ error: 'MTN status check failed', detail: await statusRes.text() }, 502);
    }
    const statusData = await statusRes.json();
    const newStatus = statusData.status; // PENDING | SUCCESSFUL | FAILED

    await admin.from('momo_transactions').update({
      status: newStatus,
      raw_response: statusData,
      updated_at: new Date().toISOString(),
    }).eq('id', txn.id);

    let credited = false;
    if (newStatus === 'SUCCESSFUL') {
      const { error: creditErr } = await admin.rpc('adjust_tokens', {
        p_driver_id: txn.driver_id,
        p_delta: txn.token_quantity,
        p_reason: 'topup',
        p_ride_id: null,
        p_momo_transaction_id: txn.id,
        p_note: `MTN ${reference_id}`,
      });
      if (creditErr) {
        // 23505 is the unique index doing its job: this payment already
        // credited. Not an error worth showing the driver.
        if (!String(creditErr.code) .includes('23505')
            && !String(creditErr.message).includes('duplicate key')) {
          return json({ error: 'Payment succeeded but crediting failed', detail: creditErr.message }, 500);
        }
      } else {
        credited = true;
      }
    }

    return json({
      status: newStatus,
      credited,
      tokens: txn.token_quantity,
      credit_balance: await currentBalance(admin, user.id),
    }, 200);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
