// driver-buy-tokens
//
// Starts an MTN Mobile Money "Request to Pay" so a driver can buy ride tokens.
// MTN pushes a PIN prompt to their phone; the result is collected later by
// driver-check-topup.
//
// The price is read from the pricing table here, never taken from the request.
// A client that could name its own amount could buy 100 tokens for one ngwee,
// which is the same reasoning that keeps fare calculation server-side.
//
// Unlike mtn-initiate-payment this is deliberately NOT staff-only: a driver
// buys their own tokens. In exchange it can only ever act on the caller's own
// account — driver_id comes from the verified JWT, never from the body.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// A bundle nobody sensibly buys in one go is more likely a bug or an attempt to
// run up someone else's phone bill than a real purchase.
const MAX_TOKENS_PER_PURCHASE = 500;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
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

    const { data: profile } = await admin
      .from('profiles').select('role').eq('id', user.id).single();
    if (!profile || profile.role !== 'Driver') {
      return json({ error: 'Drivers only' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const quantity = Number(body.quantity);
    const phone = String(body.phone ?? '').replace(/\D/g, '');

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TOKENS_PER_PURCHASE) {
      return json({ error: `quantity must be a whole number between 1 and ${MAX_TOKENS_PER_PURCHASE}` }, 400);
    }
    if (phone.length < 9) return json({ error: 'A valid mobile money number is required' }, 400);

    // Server-side price. The client says how many, never how much.
    const { data: pricing, error: pricingErr } = await admin
      .from('pricing').select('id, token_price, currency').eq('tier', 'standard').eq('active', true).maybeSingle();
    if (pricingErr || !pricing) return json({ error: 'No active pricing' }, 500);

    const amount = (Number(pricing.token_price) * quantity).toFixed(2);

    const environment = Deno.env.get('MTN_ENVIRONMENT') || 'sandbox';
    const targetEnvironment = Deno.env.get('MTN_TARGET_ENVIRONMENT') || 'sandbox';
    const base = environment === 'production'
      ? 'https://momodeveloper.mtn.com'
      : 'https://sandbox.momodeveloper.mtn.com';
    // MTN's sandbox only ever accepts EUR whatever the real currency — a
    // documented quirk of theirs, not a bug here.
    const currency = environment === 'production'
      ? (Deno.env.get('MTN_CURRENCY') || pricing.currency || 'ZMW')
      : 'EUR';

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
    if (!tokenRes.ok) {
      return json({ error: 'MTN auth failed', detail: await tokenRes.text() }, 502);
    }
    const tokenData = await tokenRes.json();

    const referenceId = crypto.randomUUID();

    // Recorded before the request goes out. If MTN accepts the payment but the
    // response never reaches us, the row still exists and driver-check-topup
    // can find it — losing a driver's money to a dropped connection is not an
    // acceptable failure.
    const { data: txn, error: insertErr } = await admin.from('momo_transactions').insert({
      purpose: 'token_topup',
      driver_id: user.id,
      token_quantity: quantity,
      provider: 'MTN',
      phone,
      amount,
      currency,
      external_reference: referenceId,
      status: 'PENDING',
    }).select('id').single();
    if (insertErr) return json({ error: insertErr.message }, 500);

    const rtpRes = await fetch(`${base}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': targetEnvironment,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount,
        currency,
        externalId: String(txn.id),
        payer: { partyIdType: 'MSISDN', partyId: phone },
        payerMessage: `DOTS Taxi: ${quantity} ride token${quantity === 1 ? '' : 's'}`,
        payeeNote: `Token top-up for driver ${user.id}`,
      }),
    });

    if (!rtpRes.ok) {
      const detail = await rtpRes.text();
      await admin.from('momo_transactions')
        .update({ status: 'FAILED', raw_response: { error: detail }, updated_at: new Date().toISOString() })
        .eq('id', txn.id);
      return json({ error: 'MTN request failed', detail }, 502);
    }

    return json({
      success: true,
      reference_id: referenceId,
      quantity,
      amount,
      currency,
    }, 200);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
