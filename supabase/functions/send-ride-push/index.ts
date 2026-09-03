import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Sends Expo pushes when a ride's status changes.
//
// Called by the `notify_rider_on_ride_status` trigger on public.rides. The
// caller only supplies a ride id — status, recipients and message text are all
// re-read here with the service role key, so a caller holding nothing but the
// public anon key cannot forge the message or push to an arbitrary token.
//
// On `matched` this notifies BOTH parties: the rider ("driver found") and the
// driver ("new ride request"). The driver push is the one that matters most —
// it's the only thing that reaches a driver whose app is fully closed, where
// the Realtime subscription isn't running.
//
// Tokens live in public.push_tokens, whose RLS scopes each row to its owner.
// The service role key bypasses that, which is why this function can read a
// rider's or driver's tokens while no other signed-in user can. The token is
// the primary key, so a user may have several rows — a driver signed in on two
// devices is alerted on both.

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

// Expo caps a single push request at 100 messages.
const EXPO_BATCH_LIMIT = 100;

type Ride = {
  id: string;
  rider_id: string;
  driver_id: string | null;
  status: string;
  pickup_address: string | null;
};

type Recipient = {
  userId: string;
  role: "rider" | "driver";
  title: string;
  body: string;
};

// One addressed copy of a message: a recipient paired with one of their
// devices. Ticket i in Expo's response corresponds to message i, so this is
// what lets a DeviceNotRegistered map back to the exact token to delete.
type Addressed = Recipient & { token: string };

// Statuses worth interrupting the rider for. `declined` is deliberately
// absent: dispatch immediately re-searches, so the rider would get a scary
// push for a non-event. `cancelled` is the rider's own action.
const RIDER_MESSAGES: Record<string, { title: string; body: string }> = {
  matched: {
    title: "Driver found",
    body: "A driver has been matched to your ride — waiting for them to confirm.",
  },
  accepted: {
    title: "Your driver is on the way",
    body: "Your driver has accepted and is heading to your pickup point.",
  },
  no_drivers: {
    title: "No drivers available",
    body: "We couldn't find a driver right now. Try again in a few minutes.",
  },
  completed: {
    title: "Trip completed",
    body: "Thanks for riding with DOTS Taxi.",
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildRecipients(ride: Ride): Recipient[] {
  const recipients: Recipient[] = [];

  const riderMessage = RIDER_MESSAGES[ride.status];
  if (riderMessage) {
    recipients.push({ userId: ride.rider_id, role: "rider", ...riderMessage });
  }

  // The driver is only ever interrupted for a ride they need to answer.
  // Every later status is a consequence of their own action.
  if (ride.status === "matched" && ride.driver_id) {
    recipients.push({
      userId: ride.driver_id,
      role: "driver",
      title: "New ride request",
      body: ride.pickup_address
        ? `Pickup: ${ride.pickup_address}`
        : "Tap to see the pickup location.",
    });
  }

  return recipients;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Accept both our trigger's shape ({ ride_id }) and the shape a Supabase
  // Database Webhook would send ({ record: { id, ... } }), so the function
  // works either way if you ever wire it up from the dashboard instead.
  const record = payload.record as Record<string, unknown> | undefined;
  const rideId = (payload.ride_id ?? record?.id) as string | undefined;
  if (!rideId) return json({ error: "Missing ride_id" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: rideRow, error: rideError } = await supabase
    .from("rides")
    .select("id, rider_id, driver_id, status, pickup_address")
    .eq("id", rideId)
    .maybeSingle();

  if (rideError) return json({ error: rideError.message }, 500);
  if (!rideRow) return json({ error: "Ride not found" }, 404);
  const ride = rideRow as Ride;

  const recipients = buildRecipients(ride);
  if (recipients.length === 0) {
    return json({ skipped: `status ${ride.status} is not notifiable` });
  }

  const { data: tokenRows, error: tokenError } = await supabase
    .from("push_tokens")
    .select("token, user_id")
    .in("user_id", recipients.map((r) => r.userId));

  if (tokenError) return json({ error: tokenError.message }, 500);

  const tokensByUser = new Map<string, string[]>();
  for (const row of tokenRows ?? []) {
    const list = tokensByUser.get(row.user_id) ?? [];
    list.push(row.token);
    tokensByUser.set(row.user_id, list);
  }

  // Fan each recipient out across their registered devices.
  const addressed: Addressed[] = [];
  const skipped: string[] = [];
  for (const r of recipients) {
    const tokens = tokensByUser.get(r.userId) ?? [];
    if (tokens.length === 0) {
      skipped.push(`${r.role} has no push token`);
      continue;
    }
    for (const token of tokens) addressed.push({ ...r, token });
  }

  if (addressed.length === 0) return json({ skipped });

  const messages = addressed.map((a) => ({
    to: a.token,
    sound: "default",
    title: a.title,
    body: a.body,
    // Ride requests are time-critical: ask Android to wake the device rather
    // than batching the notification.
    priority: "high",
    channelId: a.role === "driver" ? "ride-requests" : "default",
    data: { ride_id: ride.id, status: ride.status, role: a.role },
  }));

  // Collect tickets across batches so index i still lines up with addressed[i].
  const tickets: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < messages.length; offset += EXPO_BATCH_LIMIT) {
    const batch = messages.slice(offset, offset + EXPO_BATCH_LIMIT);
    const expoResponse = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(batch),
    });

    const expoResult = await expoResponse.json().catch(() => null);
    if (!expoResponse.ok) {
      return json({ error: "Expo push failed", expo: expoResult }, 502);
    }
    const batchTickets = Array.isArray(expoResult?.data) ? expoResult.data : [];
    // Keep alignment even if Expo returns a short array for any reason.
    for (let i = 0; i < batch.length; i++) tickets.push(batchTickets[i] ?? null);
  }

  // Expo returns 200 even for per-message errors (e.g. DeviceNotRegistered
  // after an app uninstall). Drop dead tokens so we stop retrying them.
  const deadTokens = addressed
    .filter(
      (_, i) =>
        tickets[i]?.status === "error" &&
        tickets[i]?.details?.error === "DeviceNotRegistered",
    )
    .map((a) => a.token);

  if (deadTokens.length > 0) {
    await supabase.from("push_tokens").delete().in("token", deadTokens);
  }

  return json({
    sent: addressed.map((a) => a.role),
    skipped,
    deleted_tokens: deadTokens.length,
    expo: { data: tickets },
  });
});
