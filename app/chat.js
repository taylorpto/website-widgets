/* Taylor PTO chat.
 *
 * Backend: Supabase project "taylor-pto-app". Who can see and post what is
 * enforced by the database (supabase/schema.sql), not by this file.
 * Joining: sign in with an emailed code -> enter the invite code -> a board
 * member approves you. Board members manage people under "Members".
 *
 * The two keys below are PUBLIC by design (safe to ship in a web page).
 */
(function () {
  const SUPABASE_URL = "https://ztzzrlqgshqhkhwwuzec.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0enpybHFnc2hxaGtod3d1emVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwMzk0MDcsImV4cCI6MjExMDYxNTQwN30.H_znx-2V2bs7kOuycp5KMLlq9U0YOWAXhLJSbw9INpM";
  const VAPID_PUBLIC_KEY = "BAW3SvqLB9V9LSIsIbA3g7bnt71Q9EWam2WhL7-8M64aI6GKWnMwyE-ZJfjIsnaPrqqyHtprtyi1Wd4HXcaC8DU";
  const GRADE_LABEL = ["K", "1st", "2nd", "3rd", "4th"];
  const PAGE = 50;

  if (!window.supabase) { window.Chat = { render() { view().innerHTML = '<p class="empty">Chat couldn\'t load. Check your connection.</p>'; }, badge() {} }; return; }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const C = {
    session: null, me: null, rooms: [], people: new Map(), msgs: new Map(), more: new Map(),
    unread: {}, reads: {}, channel: null, path: "", loaded: false, email: null, busy: false, error: null,
    pushOn: null, subRooms: ["announcements"], pendingCount: 0,
  };

  const view = () => document.getElementById("view");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,)!?])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const active = () => (location.hash || "").startsWith("#chat");
  const tf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const df = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
  const dayKey = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
  const isAdmin = () => C.me?.status === "approved" && C.me?.role === "admin";
  const byTime = (x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id - y.id);
  const nameOf = (uid) => C.people.get(uid)?.display_name || "Taylor parent";

  function rerender() { if (active()) render(C.path); }

  /* ---------------- data ---------------- */

  async function loadMe() {
    if (!C.session) { C.me = null; return; }
    const { data } = await sb.from("profiles").select("id,display_name,grades,status,role,created_at").eq("id", C.session.user.id).maybeSingle();
    C.me = data;
  }

  async function loadApprovedData() {
    const uid = C.session.user.id;
    const [rooms, people, reads, subs] = await Promise.all([
      sb.from("rooms").select("*").order("sort"),
      sb.from("profiles").select("id,display_name,grades,status,role").eq("status", "approved"),
      sb.from("reads").select("room_id,last_read_at").eq("user_id", uid),
      sb.from("push_subscriptions").select("endpoint,rooms").eq("user_id", uid),
    ]);
    C.rooms = rooms.data || [];
    C.people = new Map((people.data || []).map((p) => [p.id, p]));
    C.reads = Object.fromEntries((reads.data || []).map((r) => [r.room_id, r.last_read_at]));
    const mine = subs.data || [];
    const ep = await currentEndpoint();
    const thisDevice = mine.find((s) => s.endpoint === ep);
    C.pushOn = !!thisDevice;
    if (thisDevice) C.subRooms = thisDevice.rooms;
    await loadUnread();
    if (isAdmin()) await loadPendingCount();
    subscribeRealtime();
  }

  async function loadUnread() {
    const uid = C.session.user.id;
    const counts = await Promise.all(C.rooms.map((r) => {
      let q = sb.from("messages").select("id", { count: "exact", head: true }).eq("room_id", r.id).neq("user_id", uid).is("deleted_at", null);
      if (C.reads[r.id]) q = q.gt("created_at", C.reads[r.id]);
      return q.then((res) => [r.id, res.count || 0]);
    }));
    C.unread = Object.fromEntries(counts);
    badge();
  }

  async function loadPendingCount() {
    const { data } = await sb.rpc("admin_people", { p_status: "pending" });
    C.pendingCount = (data || []).length;
  }

  async function loadMessages(roomId, older) {
    const list = C.msgs.get(roomId) || [];
    let q = sb.from("messages").select("*").eq("room_id", roomId).order("created_at", { ascending: false }).limit(PAGE);
    if (older && list.length) q = q.lt("created_at", list[0].created_at);
    const { data, error } = await q;
    if (error) throw error;
    const got = (data || []).reverse();
    C.msgs.set(roomId, older ? got.concat(list) : got);
    C.more.set(roomId, (data || []).length === PAGE);
  }

  async function markRead(roomId) {
    const now = new Date().toISOString();
    C.reads[roomId] = now;
    C.unread[roomId] = 0;
    badge();
    await sb.from("reads").upsert({ user_id: C.session.user.id, room_id: roomId, last_read_at: now }, { onConflict: "user_id,room_id" });
  }

  function subscribeRealtime() {
    if (C.channel) return;
    C.channel = sb.channel("messages")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (p) => {
        const m = p.new;
        if (!m?.room_id) return;
        const list = C.msgs.get(m.room_id);
        if (p.eventType === "INSERT") {
          if (list && !list.some((x) => x.id === m.id)) { list.push(m); list.sort(byTime); }
          const viewing = C.path === `chat/${m.room_id}` && document.visibilityState === "visible";
          if (m.user_id !== C.session?.user.id) {
            if (viewing) markRead(m.room_id); else { C.unread[m.room_id] = (C.unread[m.room_id] || 0) + 1; badge(); }
          }
          if (!C.people.has(m.user_id)) refreshPeople();
        } else if (p.eventType === "UPDATE" && list) {
          const i = list.findIndex((x) => x.id === m.id);
          if (i >= 0) list[i] = m;
        }
        if (C.path === `chat/${m.room_id}`) renderRoom(m.room_id, { keepScroll: p.eventType !== "INSERT" });
        else if (C.path === "chat") rerender();
      })
      .subscribe();
  }

  async function refreshPeople() {
    const { data } = await sb.from("profiles").select("id,display_name,grades,status,role").eq("status", "approved");
    C.people = new Map((data || []).map((p) => [p.id, p]));
  }

  /* ---------------- push ---------------- */

  function b64ToBytes(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const s = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  async function currentEndpoint() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.getSubscription();
      return s?.endpoint || null;
    } catch { return null; }
  }
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  async function enablePush(rooms) {
    if (!pushSupported()) throw new Error(isIOS() && !isStandalone() ? "ios-install" : "unsupported");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("denied");
    const reg = await navigator.serviceWorker.ready;
    let s = await reg.pushManager.getSubscription();
    if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
    const j = s.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert({
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: C.session.user.id, rooms: rooms || C.subRooms,
    }, { onConflict: "endpoint" });
    if (error) throw error;
    C.pushOn = true;
    C.subRooms = rooms || C.subRooms;
  }

  async function setRoomPush(roomId, on) {
    const rooms = new Set(C.subRooms);
    on ? rooms.add(roomId) : rooms.delete(roomId);
    C.subRooms = [...rooms];
    const ep = await currentEndpoint();
    if (ep) await sb.from("push_subscriptions").update({ rooms: C.subRooms }).eq("endpoint", ep);
  }

  function pushErrorText(e) {
    const m = e?.message || "";
    if (m === "ios-install") return "On iPhone, notifications only work from the home-screen app. Add Taylor PTO to your home screen first (Share, then Add to Home Screen), open it from there, and try again.";
    if (m === "denied") return "Notifications are blocked. Turn them on for Taylor PTO in your phone's Settings, then try again.";
    if (m === "unsupported") return "This browser can't receive notifications.";
    return "Couldn't turn on notifications. Please try again.";
  }

  /* ---------------- shared UI bits ---------------- */

  const ICONS = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-6 16-3-7-7-1Z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 1 1 8 0v2.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
    people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.8 14.6c2.4-.2 4.2 1.3 4.7 4.9"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  };
  const errorBox = () => (C.error ? `<p class="chat-error" role="alert">${esc(C.error)}</p>` : "");

  function setTitle(t) { const el = document.getElementById("screen-title"); if (el) el.textContent = t; }

  function badge() {
    const a = document.querySelector('.tabs a[data-tab="chat"]');
    if (!a) return;
    const n = Object.values(C.unread).reduce((x, y) => x + y, 0) + (isAdmin() ? C.pendingCount : 0);
    let b = a.querySelector(".tab-badge");
    if (n > 0) {
      if (!b) { b = document.createElement("span"); b.className = "tab-badge"; a.appendChild(b); }
      b.textContent = n > 99 ? "99+" : String(n);
      b.setAttribute("aria-label", `${n} unread`);
    } else if (b) b.remove();
  }

  /* ---------------- screens ---------------- */

  function renderSignIn() {
    setTitle("Chat");
    const v = view();
    if (C.email) {
      v.innerHTML = `
        <div class="card chat-intro">
          <h2 class="card-h">Check your email</h2>
          <p class="small">We sent a 6-digit code to <strong>${esc(C.email)}</strong>. Enter it below.</p>
          <form id="f-code" class="chat-form" autocomplete="off">
            <label for="code">Sign-in code</label>
            <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="8" required>
            ${errorBox()}
            <button class="btn" type="submit" ${C.busy ? "disabled" : ""}>${C.busy ? "Checking…" : "Sign in"}</button>
          </form>
          <p class="fine" style="margin-top:12px">If the email has a button instead of a code, tap it on this device. <button type="button" class="linkbtn" data-act="restart">Use a different email</button></p>
        </div>`;
      setTimeout(() => document.getElementById("code")?.focus(), 50);
      return;
    }
    v.innerHTML = `
      <div class="card chat-intro">
        <h2 class="card-h">Taylor PTO chat</h2>
        <p class="small">Announcements from the board, plus chat rooms for every grade. It's private: only Taylor families the board has approved can join.</p>
        <form id="f-email" class="chat-form">
          <label for="email">Your email</label>
          <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required>
          ${errorBox()}
          <button class="btn" type="submit" ${C.busy ? "disabled" : ""}>${C.busy ? "Sending…" : "Email me a sign-in code"}</button>
        </form>
        <div class="or"><span>or</span></div>
        <button class="btn google" type="button" data-act="google" ${C.busy ? "disabled" : ""}>
          <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>
          Continue with Google
        </button>
        <p class="fine" style="margin:8px 0 0">Google will say you're signing in to <strong>ztzzrlqgshqhkhwwuzec.supabase.co</strong>. That's the service the PTO chat runs on, so it's safe to continue.</p>
        <p class="fine" style="margin-top:12px">No password needed. You'll need the invite code from the PTO newsletter after you sign in. <a href="privacy.html">Privacy</a></p>
      </div>`;
  }

  function renderJoin() {
    setTitle("Join the chat");
    view().innerHTML = `
      <div class="card">
        <h2 class="card-h">Almost there</h2>
        <p class="small">Enter the invite code from the PTO newsletter. A board member will then approve you, usually within a day.</p>
        <form id="f-join" class="chat-form" autocomplete="off">
          <label for="invite">Invite code</label>
          <input id="invite" name="invite" autocapitalize="characters" required placeholder="e.g. TIGER-1234">
          <label for="dname">Your name, as other parents will see it</label>
          <input id="dname" name="dname" maxlength="60" required placeholder="e.g. Sam Rivera">
          <fieldset class="grades"><legend>Your kids' grades at Taylor</legend>
            ${GRADE_LABEL.map((g, i) => `<label class="gchip"><input type="checkbox" name="g" value="${i}"><span>${g === "K" ? "Kindergarten" : g + " grade"}</span></label>`).join("")}
          </fieldset>
          ${errorBox()}
          <button class="btn" type="submit" ${C.busy ? "disabled" : ""}>${C.busy ? "Sending…" : "Ask to join"}</button>
        </form>
        <p class="fine" style="margin-top:12px"><button type="button" class="linkbtn" data-act="signout">Sign out</button></p>
      </div>`;
  }

  function pushCard(context) {
    if (C.pushOn) return "";
    const ios = isIOS() && !isStandalone();
    const text = context === "pending"
      ? "Turn on notifications and we'll tell you the moment you're approved."
      : "Get a notification for every board announcement. You can add other rooms in Settings.";
    return `<div class="card push-card">
      <span class="ico">${ICONS.bell}</span>
      <div>
        <p class="small" style="margin:0 0 8px">${text}</p>
        ${ios ? '<p class="fine" style="margin:0">On iPhone, first add Taylor PTO to your home screen (Share, then Add to Home Screen) and open it from there.</p>'
              : `<button class="btn" type="button" data-act="push-on" style="width:auto;min-height:40px;padding:8px 14px;font-size:14px">Turn on notifications</button>`}
      </div>
    </div>`;
  }

  function renderPending() {
    setTitle("Chat");
    view().innerHTML = `
      <div class="card status">
        <p class="status-date">Request sent</p>
        <p class="status-main" style="font-size:22px">Waiting for the board to approve you</p>
        <p class="status-sub">This usually takes less than a day. You'll see the chat rooms here as soon as you're in.</p>
      </div>
      ${errorBox()}
      ${pushCard("pending")}
      <p class="fine" style="text-align:center"><button type="button" class="linkbtn" data-act="signout">Sign out</button></p>`;
  }

  function renderRemoved() {
    setTitle("Chat");
    view().innerHTML = `
      <div class="card"><h2 class="card-h">You don't have access to the chat</h2>
      <p class="small">If you think this is a mistake, email <a href="mailto:board@taylorpto.org">board@taylorpto.org</a>.</p>
      <p class="fine"><button type="button" class="linkbtn" data-act="signout">Sign out</button></p></div>`;
  }

  function roomRow(r) {
    const n = C.unread[r.id] || 0;
    const sub = r.kind === "announce" ? "Board posts only" : r.kind === "board" ? "Board members only" : r.grade != null ? "Parents of " + (r.grade === 0 ? "kindergartners" : GRADE_LABEL[r.grade] + " graders") : r.id === "general" ? "All Taylor families" : "Event help and sign-ups";
    return `<li><a href="#chat/${r.id}" class="room${n ? " has-unread" : ""}">
      <span class="room-ico" aria-hidden="true">${r.kind === "announce" ? ICONS.bell : r.kind === "board" ? ICONS.lock : "#"}</span>
      <span><strong>${esc(r.name)}</strong><span class="d">${sub}</span></span>
      ${n ? `<span class="unread" aria-label="${n} unread">${n > 99 ? "99+" : n}</span>` : ""}
    </a></li>`;
  }

  function renderRooms() {
    setTitle("Chat");
    const mine = new Set(C.me.grades || []);
    const top = C.rooms.filter((r) => r.kind === "announce" || r.id === "general");
    const grades = C.rooms.filter((r) => r.grade != null).sort((a, b) => (mine.has(b.grade) - mine.has(a.grade)) || a.sort - b.sort);
    const rest = C.rooms.filter((r) => r.grade == null && !top.includes(r));
    view().innerHTML = `
      ${pushCard("approved")}
      <div class="card" style="padding:4px 14px"><ul class="links rooms">${top.map(roomRow).join("")}</ul></div>
      <h2 class="section-h">Grades</h2>
      <div class="card" style="padding:4px 14px"><ul class="links rooms">${grades.map(roomRow).join("")}</ul></div>
      <h2 class="section-h">More</h2>
      <div class="card" style="padding:4px 14px"><ul class="links rooms">
        ${rest.map(roomRow).join("")}
        ${isAdmin() ? `<li><a href="#chat/admin" class="room"><span class="room-ico" aria-hidden="true">${ICONS.people}</span><span><strong>Members</strong><span class="d">Approve families, invite code, reports</span></span>${C.pendingCount ? `<span class="unread" aria-label="${C.pendingCount} waiting">${C.pendingCount}</span>` : ""}</a></li>` : ""}
        <li><a href="#chat/settings" class="room"><span class="room-ico" aria-hidden="true">${ICONS.gear}</span><span><strong>Settings</strong><span class="d">Notifications, your name, sign out</span></span></a></li>
      </ul></div>`;
  }

  function msgHTML(m, prev) {
    const mine = m.user_id === C.session.user.id;
    const p = C.people.get(m.user_id);
    const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
    const grouped = !newDay && prev && prev.user_id === m.user_id && (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60000;
    const sep = newDay ? `<li class="day-sep"><span>${df.format(new Date(m.created_at))}</span></li>` : "";
    if (m.deleted_at) return sep + `<li class="msg removed${mine ? " mine" : ""}"><p class="bubble"><em>Message removed</em></p></li>`;
    return sep + `<li class="msg${mine ? " mine" : ""}${grouped ? " grouped" : ""}" data-id="${m.id}">
      ${grouped || mine ? "" : `<p class="who">${esc(nameOf(m.user_id))}${p?.role === "admin" ? ' <span class="role">Board</span>' : ""}</p>`}
      <div class="bubble-row">
        <p class="bubble">${linkify(m.body)}</p>
        <button class="msg-more" type="button" data-act="msg-menu" data-id="${m.id}" aria-label="Message options">${ICONS.more}</button>
      </div>
      <p class="when">${tf.format(new Date(m.created_at))}</p>
    </li>`;
  }

  function renderRoom(roomId, { keepScroll = false } = {}) {
    const room = C.rooms.find((r) => r.id === roomId);
    if (!room) { location.hash = "#chat"; return; }
    setTitle(room.name);
    const list = C.msgs.get(roomId);
    const canPost = room.kind === "chat" || isAdmin();
    const scroller = document.scrollingElement;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - innerHeight < 160;
    const prevHeight = scroller.scrollHeight;
    const oldTa = document.getElementById("composer");
    const draft = oldTa?.value;
    const hadFocus = oldTa && document.activeElement === oldTa;
    view().innerHTML = `
      <div class="room-head"><a href="#chat" class="back">${ICONS.back}<span>All rooms</span></a></div>
      ${!list ? '<p class="empty">Loading messages…</p>' : `
        ${C.more.get(roomId) ? '<button class="btn ghost" type="button" data-act="older" style="margin-bottom:10px">Load earlier messages</button>' : ""}
        ${list.length ? `<ul class="thread">${list.map((m, i) => msgHTML(m, list[i - 1])).join("")}</ul>`
          : `<p class="empty">${room.kind === "announce" ? "No announcements yet." : "No messages yet. Say hello!"}</p>`}`}
      ${canPost ? `<form id="f-send" class="composer">
          <label for="composer" class="sr-only">Message ${esc(room.name)}</label>
          <textarea id="composer" rows="1" maxlength="2000" placeholder="${room.kind === "announce" ? "Post an announcement to every family…" : "Message " + esc(room.name)}"></textarea>
          <button type="submit" aria-label="Send" ${C.busy ? "disabled" : ""}>${ICONS.send}</button>
        </form>`
        : '<p class="composer-note">Only board members post here. Everyone gets these as notifications.</p>'}
    `;
    const ta = document.getElementById("composer");
    if (ta && draft) { ta.value = draft; autosize(ta); }
    if (ta && hadFocus) ta.focus({ preventScroll: true });
    if (!keepScroll && (nearBottom || !draft)) scroller.scrollTop = scroller.scrollHeight;
    else if (keepScroll) scroller.scrollTop += scroller.scrollHeight - prevHeight;
  }

  async function renderAdmin() {
    if (!isAdmin()) { location.hash = "#chat"; return; }
    setTitle("Members");
    view().innerHTML = '<p class="empty">Loading…</p>';
    const [people, code, reports] = await Promise.all([
      sb.rpc("admin_people", { p_status: null }),
      sb.rpc("admin_invite_code", { p_new: null }),
      sb.from("reports").select("id,message_id,reason,created_at,reporter").eq("resolved", false).order("created_at", { ascending: false }),
    ]);
    if (!C.path.startsWith("chat/admin")) return;
    const all = people.data || [];
    const pending = all.filter((p) => p.status === "pending");
    const approved = all.filter((p) => p.status === "approved");
    const removed = all.filter((p) => p.status === "removed");
    C.pendingCount = pending.length; badge();
    const grades = (g) => (g || []).length ? (g || []).map((x) => GRADE_LABEL[x]).join(", ") : "No grades given";
    const reps = reports.data || [];
    let repMsgs = new Map();
    if (reps.length) {
      const { data } = await sb.from("messages").select("id,room_id,user_id,body,deleted_at").in("id", reps.map((r) => r.message_id));
      repMsgs = new Map((data || []).map((m) => [m.id, m]));
    }
    view().innerHTML = `
      <div class="room-head"><a href="#chat" class="back">${ICONS.back}<span>All rooms</span></a></div>
      ${errorBox()}
      <h2 class="section-h">Waiting for approval (${pending.length})</h2>
      <div class="card" style="padding:4px 14px">${pending.length ? `<ul class="people">${pending.map((p) => `
        <li><div><strong>${esc(p.display_name)}</strong><span class="d">${esc(p.email)} · ${grades(p.grades)}</span></div>
          <div class="pact"><button class="btn" type="button" data-act="approve" data-id="${p.id}">Approve</button><button class="btn ghost" type="button" data-act="decline" data-id="${p.id}">Decline</button></div></li>`).join("")}</ul>`
        : '<p class="empty">No one is waiting.</p>'}</div>

      ${reps.length ? `<h2 class="section-h">Reported messages (${reps.length})</h2>
      <div class="card" style="padding:4px 14px"><ul class="people">${reps.map((r) => { const m = repMsgs.get(r.message_id); return `
        <li><div><strong>${esc(m ? nameOf(m.user_id) : "Unknown")}</strong> in ${esc(m?.room_id || "")}<span class="d">“${esc(m?.deleted_at ? "(already removed)" : (m?.body || "").slice(0, 160))}”${r.reason ? " · Reason: " + esc(r.reason) : ""}</span></div>
          <div class="pact">${m && !m.deleted_at ? `<button class="btn" type="button" data-act="remove-msg" data-id="${m.id}" data-report="${r.id}">Remove message</button>` : ""}<button class="btn ghost" type="button" data-act="dismiss-report" data-id="${r.id}">Dismiss</button></div></li>`; }).join("")}</ul></div>` : ""}

      <h2 class="section-h">Invite code</h2>
      <div class="card">
        <p class="small" style="margin:0 0 6px">Share this in the newsletter. Change it if it gets posted somewhere public. People who already joined aren't affected.</p>
        <p class="invite-code">${esc(code.data || "")}</p>
        <form id="f-code-change" class="chat-form inline"><label for="newcode" class="sr-only">New invite code</label><input id="newcode" placeholder="New code (6+ characters)" minlength="6" autocapitalize="characters"><button class="btn ghost" type="submit">Change</button></form>
      </div>

      <h2 class="section-h">Members (${approved.length})</h2>
      <div class="card" style="padding:4px 14px"><ul class="people">${approved.map((p) => `
        <li><div><strong>${esc(p.display_name || p.email)}</strong>${p.role === "admin" ? ' <span class="role">Board</span>' : ""}<span class="d">${esc(p.email)} · ${grades(p.grades)}</span></div>
          ${p.id === C.session.user.id ? '<span class="fine">You</span>' : `<div class="pact"><button class="btn ghost" type="button" data-act="${p.role === "admin" ? "unadmin" : "admin"}" data-id="${p.id}">${p.role === "admin" ? "Remove board role" : "Make board member"}</button><button class="btn ghost danger" type="button" data-act="remove" data-id="${p.id}">Remove</button></div>`}</li>`).join("")}</ul></div>

      ${removed.length ? `<h2 class="section-h">Removed or declined (${removed.length})</h2>
      <div class="card" style="padding:4px 14px"><ul class="people">${removed.map((p) => `
        <li><div><strong>${esc(p.display_name || p.email)}</strong><span class="d">${esc(p.email)}</span></div>
          <div class="pact"><button class="btn ghost" type="button" data-act="approve" data-id="${p.id}">Approve</button></div></li>`).join("")}</ul></div>` : ""}
    `;
  }

  function renderSettings() {
    setTitle("Chat settings");
    const ios = isIOS() && !isStandalone();
    view().innerHTML = `
      <div class="room-head"><a href="#chat" class="back">${ICONS.back}<span>All rooms</span></a></div>
      ${errorBox()}
      <h2 class="section-h">Notifications on this device</h2>
      <div class="card">
        ${!C.pushOn ? (ios ? '<p class="small">On iPhone, add Taylor PTO to your home screen (Share, then Add to Home Screen) and open it from there to turn on notifications.</p>'
          : '<p class="small">Notifications are off.</p><button class="btn" type="button" data-act="push-on">Turn on notifications</button>')
          : `<p class="small" style="margin:0 0 6px">Choose which rooms notify you:</p><ul class="toggles">${C.rooms.map((r) => `
            <li><label><input type="checkbox" data-act="room-push" data-id="${r.id}" ${C.subRooms.includes(r.id) ? "checked" : ""}><span>${esc(r.name)}</span></label></li>`).join("")}</ul>`}
      </div>
      <h2 class="section-h">Your profile</h2>
      <div class="card">
        <form id="f-profile" class="chat-form">
          <label for="pname">Name other parents see</label>
          <input id="pname" maxlength="60" required value="${esc(C.me.display_name || "")}">
          <fieldset class="grades"><legend>Your kids' grades</legend>
            ${GRADE_LABEL.map((g, i) => `<label class="gchip"><input type="checkbox" name="g" value="${i}" ${(C.me.grades || []).includes(i) ? "checked" : ""}><span>${g === "K" ? "Kindergarten" : g + " grade"}</span></label>`).join("")}
          </fieldset>
          <button class="btn" type="submit">Save</button>
        </form>
      </div>
      <p class="fine" style="text-align:center;margin-top:16px">Signed in as ${esc(C.session.user.email)} · <button type="button" class="linkbtn" data-act="signout">Sign out</button></p>
      <p class="fine" style="text-align:center">Be kind. Board members can remove messages and members. Use "Report" on any message that needs a look.</p>`;
  }

  /* ---------------- router entry ---------------- */

  async function render(path) {
    C.path = path || "chat";
    const sub = C.path.split("/")[1] || "";
    if (!C.loaded) { view().innerHTML = '<p class="empty">Loading chat…</p>'; return; }
    if (!C.session) return renderSignIn();
    if (!C.me) { await loadMe(); if (!C.me) { view().innerHTML = '<p class="empty">Setting up your account…</p>'; setTimeout(async () => { await loadMe(); rerender(); }, 1500); return; } }
    if (C.me.status === "new") return renderJoin();
    if (C.me.status === "pending") return renderPending();
    if (C.me.status === "removed") return renderRemoved();
    if (!C.rooms.length) { view().innerHTML = '<p class="empty">Loading chat…</p>'; await loadApprovedData(); if (C.path !== path) return; }
    if (!sub) return renderRooms();
    if (sub === "admin") return renderAdmin();
    if (sub === "settings") return renderSettings();
    if (!C.msgs.has(sub)) { renderRoom(sub); try { await loadMessages(sub); } catch (e) { C.error = "Couldn't load messages."; } }
    if (C.path !== `chat/${sub}`) return;
    renderRoom(sub);
    markRead(sub);
  }

  /* ---------------- events ---------------- */

  function autosize(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; }

  async function act(fn) {
    if (C.busy) return;
    C.busy = true; C.error = null; rerender();
    try { await fn(); } catch (e) { C.error = e?.userMessage || e?.message || "Something went wrong. Please try again."; console.error(e); }
    C.busy = false; rerender();
  }

  document.addEventListener("submit", (e) => {
    const f = e.target;
    if (!active()) return;
    if (f.id === "f-email") {
      e.preventDefault();
      const email = f.email.value.trim().toLowerCase();
      act(async () => {
        const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
        if (error) throw Object.assign(error, { userMessage: /rate/i.test(error.message) ? "Too many sign-in emails were sent just now. Please wait a few minutes and try again." : "Couldn't send the code. Check the email address and try again." });
        C.email = email;
      });
    } else if (f.id === "f-code") {
      e.preventDefault();
      const token = f.code.value.trim();
      act(async () => {
        const { error } = await sb.auth.verifyOtp({ email: C.email, token, type: "email" });
        if (error) throw Object.assign(error, { userMessage: "That code didn't work. Check it, or request a new one." });
      });
    } else if (f.id === "f-join") {
      e.preventDefault();
      const grades = [...f.querySelectorAll('input[name="g"]:checked')].map((x) => +x.value);
      const code = f.invite.value, name = f.dname.value;
      act(async () => {
        const { data, error } = await sb.rpc("redeem_invite", { p_code: code, p_name: name, p_grades: grades });
        if (error) throw error;
        if (data === "bad_code") throw { userMessage: "That invite code isn't right. Check the newsletter, or ask a board member." };
        if (data === "locked") throw { userMessage: "Too many wrong codes. Email board@taylorpto.org and we'll sort it out." };
        if (data === "bad_name") throw { userMessage: "Please enter your name." };
        await loadMe();
      });
    } else if (f.id === "f-send") {
      e.preventDefault();
      const ta = f.querySelector("textarea");
      const body = ta.value.trim();
      const roomId = C.path.split("/")[1];
      if (!body) return;
      ta.value = "";
      (async () => {
        const { data, error } = await sb.from("messages").insert({ room_id: roomId, body }).select().single();
        if (error) { ta.value = body; C.error = "Message didn't send. Please try again."; rerender(); return; }
        const list = C.msgs.get(roomId) || [];
        if (!list.some((x) => x.id === data.id)) { list.push(data); list.sort(byTime); }
        C.msgs.set(roomId, list);
        renderRoom(roomId);
        document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
      })();
    } else if (f.id === "f-code-change") {
      e.preventDefault();
      const v = f.newcode.value.trim();
      if (v.length < 6) return;
      act(async () => { const { error } = await sb.rpc("admin_invite_code", { p_new: v }); if (error) throw error; });
    } else if (f.id === "f-profile") {
      e.preventDefault();
      const grades = [...f.querySelectorAll('input[name="g"]:checked')].map((x) => +x.value);
      const display_name = f.pname.value.trim();
      act(async () => {
        const { error } = await sb.from("profiles").update({ display_name, grades }).eq("id", C.session.user.id);
        if (error) throw error;
        await loadMe(); await refreshPeople();
        C.error = null;
      });
    }
  });

  document.addEventListener("input", (e) => { if (e.target.id === "composer") autosize(e.target); });
  document.addEventListener("keydown", (e) => {
    if (e.target.id === "composer" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.form.requestSubmit(); }
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !active()) return;
    const a = b.dataset.act, id = b.dataset.id;
    if (a === "google") act(async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } } });
      if (error) throw Object.assign(error, { userMessage: "Couldn't start Google sign-in. Please try again, or use the email code." });
    });
    else if (a === "restart") { C.email = null; C.error = null; rerender(); }
    else if (a === "signout") act(async () => { await sb.auth.signOut(); });
    else if (a === "push-on") act(async () => { try { await enablePush(); } catch (err) { throw { userMessage: pushErrorText(err) }; } });
    else if (a === "older") {
      const roomId = C.path.split("/")[1];
      loadMessages(roomId, true).then(() => renderRoom(roomId, { keepScroll: true }));
    }
    else if (a === "approve" || a === "decline" || a === "remove") {
      const label = a === "remove" ? "Remove this member from the chat?" : null;
      if (label && !window.confirm(label)) return;
      act(async () => { const { error } = await sb.rpc("admin_set_status", { p_user: id, p_status: a === "approve" ? "approved" : "removed" }); if (error) throw error; await refreshPeople(); });
    }
    else if (a === "admin" || a === "unadmin") act(async () => { const { error } = await sb.rpc("admin_set_role", { p_user: id, p_role: a === "admin" ? "admin" : "member" }); if (error) throw error; await refreshPeople(); });
    else if (a === "remove-msg") act(async () => {
      await sb.rpc("delete_message", { p_id: +id });
      await sb.from("reports").update({ resolved: true }).eq("message_id", +id);
    });
    else if (a === "dismiss-report") act(async () => { await sb.from("reports").update({ resolved: true }).eq("id", +id); });
    else if (a === "msg-menu") openMenu(+id, b);
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset?.act === "room-push") setRoomPush(t.dataset.id, t.checked);
  });

  function openMenu(msgId, anchor) {
    document.querySelector(".msg-menu-pop")?.remove();
    const roomId = C.path.split("/")[1];
    const m = (C.msgs.get(roomId) || []).find((x) => x.id === msgId);
    if (!m) return;
    const canDelete = m.user_id === C.session.user.id || isAdmin();
    const pop = document.createElement("div");
    pop.className = "msg-menu-pop";
    pop.setAttribute("role", "menu");
    pop.innerHTML = `
      <button type="button" role="menuitem" data-m="copy">Copy text</button>
      ${m.user_id !== C.session.user.id ? '<button type="button" role="menuitem" data-m="report">Report to the board</button>' : ""}
      ${canDelete ? '<button type="button" role="menuitem" data-m="delete" class="danger">Delete message</button>' : ""}
      <button type="button" role="menuitem" data-m="close">Cancel</button>`;
    document.body.appendChild(pop);
    pop.querySelector("button").focus();
    pop.addEventListener("click", async (ev) => {
      const k = ev.target.closest("button")?.dataset.m;
      pop.remove();
      if (k === "copy") { try { await navigator.clipboard.writeText(m.body); } catch {} }
      else if (k === "report") {
        const reason = window.prompt("What's wrong with this message? (optional)") ?? null;
        if (reason === null) return;
        const { error } = await sb.from("reports").insert({ message_id: m.id, reason: reason || null });
        C.error = error ? "Couldn't send the report." : null;
        if (!error) alertInline("Thanks. The board will take a look.");
      } else if (k === "delete") {
        if (!window.confirm("Delete this message for everyone?")) return;
        await sb.rpc("delete_message", { p_id: m.id });
        m.deleted_at = new Date().toISOString(); m.body = "";
        renderRoom(roomId, { keepScroll: true });
      }
    });
    setTimeout(() => document.addEventListener("click", function close(ev) { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener("click", close); } }), 0);
  }

  function alertInline(text) {
    const t = document.createElement("div");
    t.className = "toast"; t.setAttribute("role", "status"); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // Pending families: check every 30 seconds whether they've been approved.
  setInterval(async () => {
    if (C.me?.status === "pending" || C.me?.status === "new") {
      const before = C.me.status;
      await loadMe();
      if (C.me && C.me.status !== before) rerender();
    }
  }, 30000);

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !C.session) return;
    await loadMe();
    if (C.me?.status === "approved" && C.rooms.length) {
      await loadUnread();
      if (isAdmin()) await loadPendingCount();
      const sub = C.path.split("/")[1];
      if (sub && C.msgs.has(sub)) { await loadMessages(sub); markRead(sub); }
    }
    rerender();
  });

  sb.auth.onAuthStateChange(async (event, session) => {
    const wasUser = C.session?.user.id;
    C.session = session;
    if (!session) {
      C.me = null; C.rooms = []; C.msgs.clear(); C.unread = {}; C.email = null; C.pushOn = null;
      if (C.channel) { sb.removeChannel(C.channel); C.channel = null; }
    } else if (session.user.id !== wasUser) {
      await loadMe();
      // Clean the ?code=… left by an emailed sign-in link.
      if (location.search.includes("code=")) history.replaceState(null, "", location.pathname + (location.hash || "#chat"));
    }
    C.loaded = true;
    badge();
    rerender();
  });

  window.Chat = { render, badge, client: sb };
})();
