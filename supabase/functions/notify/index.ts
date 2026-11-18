// Taylor PTO "notify" Edge Function: sends Web Push notifications.
//
// Called by the database (see supabase/schema.sql, private.call_notify) when:
//   - a message is posted        -> everyone subscribed to that room (Announcements by default)
//   - a family enters the code   -> board members ("New family waiting for approval")
//   - a family is approved       -> that family ("You're in!")
//
// Secrets (set in Supabase, never in this file): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, HOOK_SECRET.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
webpush.setVapidDetails(
  "mailto:board@taylorpto.org",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

type Sub = { endpoint: string; p256dh: string; auth: string };

async function subsFor(userIds: string[] | null, roomId: string | null, excludeUser?: string): Promise<Sub[]> {
  let q = sb.from("push_subscriptions").select("endpoint,p256dh,auth,user_id,rooms");
  if (userIds) q = q.in("user_id", userIds);
  if (roomId) q = q.contains("rooms", [roomId]);
  if (excludeUser) q = q.neq("user_id", excludeUser);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function userIds(filter: { admin?: boolean }): Promise<string[]> {
  let q = sb.from("profiles").select("id").eq("status", "approved");
  if (filter.admin) q = q.eq("role", "admin");
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => r.id);
}

async function send(subs: Sub[], payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // Phone unsubscribed or app removed: forget the subscription.
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, (e as Error).message);
    }
  }));
  return sent;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-hook-secret") !== Deno.env.get("HOOK_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const ev = await req.json();
  try {
    if (ev.type === "message") {
      const { data: room } = await sb.from("rooms").select("name,kind").eq("id", ev.room_id).single();
      const { data: author } = await sb.from("profiles").select("display_name").eq("id", ev.user_id).single();
      if (!room) return new Response("no room", { status: 200 });
      // Only approved members (and only admins for the Board room) are eligible.
      const eligible = await userIds({ admin: room.kind === "board" });
      const subs = await subsFor(eligible, ev.room_id, ev.user_id);
      const sent = await send(subs, {
        title: room.kind === "announce" ? "Taylor PTO" : `${room.name} · ${author?.display_name ?? "Someone"}`,
        body: ev.body,
        url: `./#chat/${ev.room_id}`,
        tag: `room-${ev.room_id}`,
      });
      return Response.json({ sent });
    }
    if (ev.type === "pending") {
      const subs = await subsFor(await userIds({ admin: true }), null);
      const sent = await send(subs, {
        title: "New family waiting for approval",
        body: `${ev.name ?? "Someone"} entered the invite code. Tap to review.`,
        url: "./#chat/admin",
        tag: "pending",
      });
      return Response.json({ sent });
    }
    if (ev.type === "approved") {
      const subs = await subsFor([ev.user_id], null);
      const sent = await send(subs, {
        title: "You're in!",
        body: "Welcome to the Taylor PTO chat.",
        url: "./#chat",
        tag: "approved",
      });
      return Response.json({ sent });
    }
    return Response.json({ ignored: ev.type });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
