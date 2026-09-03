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

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

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

  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id, push_token")
    .in("id", recipients.map((r) => r.userId));

  if (profileError) return json({ error: profileError.message }, 500);

  const tokensByUser = new Map<string, string>();
  for (const profile of profiles ?? []) {
    if (profile.push_token) tokensByUser.set(profile.id, profile.push_token);
  }

  // Keep the addressable recipients aligned with the messages we send, so the
  // ticket at index i still maps back to the right user below.
  const addressable = recipients.filter((r) => tokensByUser.has(r.userId));
  const skipped = recipients
    .filter((r) => !tokensByUser.has(r.userId))
    .map((r) => `${r.role} has no push token`);

  if (addressable.length === 0) return json({ skipped });

  const messages = addressable.map((r) => ({
    to: tokensByUser.get(r.userId),
    sound: "default",
    title: r.title,
    body: r.body,
    // Ride requests are time-critical: ask Android to wake the device rather
    // than batching the notification.
    priority: "high",
    channelId: r.role === "driver" ? "ride-requests" : "default",
    data: { ride_id: ride.id, status: ride.status, role: r.role },
  }));

  const expoResponse = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
    body: JSON.stringify(messages),
  });

  const expoResult = await expoResponse.json().catch(() => null);

  if (!expoResponse.ok) {
    return json({ error: "Expo push failed", expo: expoResult }, 502);
  }

  // Expo returns 200 even for per-message errors (e.g. DeviceNotRegistered
  // after an app uninstall). Clear dead tokens so we stop retrying them.
  const tickets = Array.isArray(expoResult?.data) ? expoResult.data : [];
  const deadUserIds = addressable
    .filter((_, i) => tickets[i]?.details?.error === "DeviceNotRegistered")
    .map((r) => r.userId);

  if (deadUserIds.length > 0) {
    await supabase.from("profiles").update({ push_token: null }).in("id", deadUserIds);
  }

  return json({
    sent: addressable.map((r) => r.role),
    skipped,
    cleared_tokens: deadUserIds.length,
    expo: expoResult,
  });
});
