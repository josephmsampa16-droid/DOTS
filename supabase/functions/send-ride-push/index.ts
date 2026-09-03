import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Sends an Expo push to the rider when their ride's status changes.
//
// Called by the `notify_rider_on_ride_status` trigger on public.rides (see
// supabase/migrations). The caller only supplies a ride id — the status and
// the destination token are re-read here with the service role key, so a
// caller holding nothing but the public anon key cannot forge the message
// text or push to an arbitrary token.

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

// Statuses worth interrupting the rider for. `declined` is deliberately
// absent: the dispatcher immediately re-searches, so the rider would get a
// scary push for a non-event. `cancelled` is the rider's own action.
const MESSAGES: Record<string, { title: string; body: string }> = {
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

  const { data: ride, error: rideError } = await supabase
    .from("rides")
    .select("id, rider_id, status")
    .eq("id", rideId)
    .maybeSingle();

  if (rideError) return json({ error: rideError.message }, 500);
  if (!ride) return json({ error: "Ride not found" }, 404);

  const message = MESSAGES[ride.status];
  if (!message) return json({ skipped: `status ${ride.status} is not notifiable` });

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("push_token")
    .eq("id", ride.rider_id)
    .maybeSingle();

  if (profileError) return json({ error: profileError.message }, 500);
  if (!profile?.push_token) return json({ skipped: "rider has no push token" });

  const expoResponse = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
    body: JSON.stringify({
      to: profile.push_token,
      sound: "default",
      title: message.title,
      body: message.body,
      data: { ride_id: ride.id, status: ride.status },
    }),
  });

  const expoResult = await expoResponse.json().catch(() => null);

  if (!expoResponse.ok) {
    return json({ error: "Expo push failed", expo: expoResult }, 502);
  }

  // Expo returns 200 even for per-message errors (e.g. DeviceNotRegistered
  // after an app uninstall). Clear the dead token so we stop retrying it.
  const ticket = expoResult?.data;
  if (ticket?.status === "error" && ticket?.details?.error === "DeviceNotRegistered") {
    await supabase.from("profiles").update({ push_token: null }).eq("id", ride.rider_id);
  }

  return json({ sent: true, expo: expoResult });
});
