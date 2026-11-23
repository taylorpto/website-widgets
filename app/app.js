/* Taylor PTO app.
 *
 * WHERE THE CONTENT COMES FROM — volunteers shouldn't need to edit this file:
 *   - Events, closures, early dismissals: the PTO Google Calendar.
 *     A GitHub Action copies it into data/events.json every hour.
 *   - Links (donate, social, forms): the LINKS block just below.
 */

const LINKS = {
  donate:    "https://www.zeffy.com/en-US/donation-form/donate-to-change-lives-26738",
  facebook:  "https://www.facebook.com/taylorschoolpto",
  instagram: "https://www.instagram.com/thetaylorpto",
  icareForm: "https://docs.google.com/forms/d/e/1FAIpQLScljusxpKYir_0iIrvsK-5W1PrhLOYj1pituVhJXOyKtXhvPQ/viewform",
  holidayShoppeForm: "https://docs.google.com/forms/d/e/1FAIpQLScuHstFizmMCmbU3haXV2fD3eeHJrHBGmCMmmav5wEIrPmPWw/viewform",
  website:   "https://www.taylorpto.org",
  subscribe: "../calendar/",
  email:     "board@taylorpto.org",
};

/* ------------------------------------------------------------------ */

const TZ = "America/New_York";
const CATS = {
  closure: "No school", early: "Early dismissal", pto: "PTO", meeting: "PTO meeting", school: "School",
};
const $view = document.getElementById("view");
const $title = document.getElementById("screen-title");
const $eyebrow = document.getElementById("screen-eyebrow");
const EYEBROW = "Charles G. Taylor Elementary";

const state = { data: null, offline: false, filter: "all", openId: null };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- dates (everything in school-local time) ---------- */

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const nyYmd = (d) => ymdFmt.format(d);
const todayYmd = () => nyYmd(new Date());
const ymdToDate = (ymd) => new Date(ymd + "T12:00:00Z");
const addDays = (ymd, n) => new Date(ymdToDate(ymd).getTime() + n * 86400000).toISOString().slice(0, 10);
const fmtUTC = (ymd, opts) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(ymdToDate(ymd));
const dow = (ymd) => ymdToDate(ymd).getUTCDay();
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const fmtTime = (iso) => timeFmt.format(new Date(iso)).replace(":00", "").replace(" ", " ");

const startYmd = (e) => (e.allDay ? e.start : nyYmd(new Date(e.start)));
const endYmd = (e) => (e.allDay ? e.end : nyYmd(new Date(e.end)));
const covers = (e, ymd) => startYmd(e) <= ymd && endYmd(e) >= ymd;

function whenText(e, withDate) {
  const s = startYmd(e), en = endYmd(e);
  const parts = [];
  if (withDate || s !== en) {
    parts.push(s === en
      ? fmtUTC(s, { weekday: "short", month: "short", day: "numeric" })
      : `${fmtUTC(s, { month: "short", day: "numeric" })} – ${fmtUTC(en, { month: s.slice(5, 7) === en.slice(5, 7) ? undefined : "short", day: "numeric" })}`);
  }
  if (!e.allDay) parts.push(`${fmtTime(e.start)}–${fmtTime(e.end)}`);
  else if (!withDate && s === en) parts.push("All day");
  return parts.join(" · ");
}

/* ---------- school-day status ---------- */

function dayStatus(ymd) {
  const evs = state.data?.events || [];
  const rot = state.data?.rotation || {};
  const closure = evs.find((e) => e.cat === "closure" && covers(e, ymd));
  if (closure) return { kind: "closure", main: "No school", sub: closure.title };
  const wd = dow(ymd);
  if (wd === 0 || wd === 6) return { kind: "weekend", main: "No school", sub: "It's the weekend." };
  const early = evs.find((e) => e.cat === "early" && covers(e, ymd));
  const rotDays = Object.keys(rot).sort();
  const inYear = rotDays.length && ymd >= rotDays[0] && ymd <= rotDays[rotDays.length - 1];
  if (early) return { kind: "early", main: "Early dismissal", sub: early.title.replace(/early dismissal/i, "").replace(/^[\s(]+|[\s)]+$/g, "") || "12:05 PM", rot: rot[ymd] };
  if (rot[ymd] || inYear) return { kind: "school", main: "School day", sub: null, rot: rot[ymd] };
  return { kind: "off", main: "No school", sub: "Outside the school year." };
}

/* ---------- data ---------- */

// Order by local school date, all-day items first, then by start time.
function sortEvents(data) {
  const key = (e) => `${startYmd(e)}|${e.allDay ? "0" : "1" + e.start}`;
  data.events.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return data;
}

async function loadEvents() {
  try {
    const r = await fetch("data/events.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    state.data = sortEvents(await r.json());
    state.offline = false;
    store.set("events", state.data);
  } catch {
    state.data = store.get("events");
    state.offline = true;
  }
}

/* ---------- event rows ---------- */

function cleanDescription(html) {
  if (!html) return "";
  const t = document.createElement("textarea");
  t.innerHTML = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "");
  return esc(t.value.trim()).replace(/(https?:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function icsFor(e) {
  const stamp = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const icsEsc = (s) => String(s || "").replace(/[\\,;]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Taylor PTO//App//EN", "BEGIN:VEVENT",
    `UID:${e.id}@taylorpto.org`, `DTSTAMP:${stamp(new Date().toISOString())}`];
  if (e.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${addDays(e.end, 1).replace(/-/g, "")}`);
  } else {
    lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
  }
  lines.push(`SUMMARY:${icsEsc(e.title)}`);
  if (e.location) lines.push(`LOCATION:${icsEsc(e.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return "data:text/calendar;charset=utf-8," + encodeURIComponent(lines.join("\r\n"));
}

const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function evRow(e, { withDate = false, noDay = false } = {}) {
  const s = startYmd(e);
  const open = state.openId === e.id;
  const meta = whenText(e, false);
  const detailId = "d-" + btoa(unescape(encodeURIComponent(e.id))).replace(/[^a-z0-9]/gi, "").slice(0, 24);
  return `<li class="ev${open ? " open" : ""}${noDay ? " no-day" : ""}" data-id="${esc(e.id)}">
    <button type="button" aria-expanded="${open}" aria-controls="${detailId}">
      ${noDay ? "" : `<span class="ev-date"><span class="ev-dow">${fmtUTC(s, { weekday: "short" })}</span><span class="ev-dom">${fmtUTC(s, { day: "numeric" })}</span></span>`}
      <span>
        <span class="ev-title">${esc(e.title)}</span>
        <span class="ev-meta">${esc(withDate ? fmtUTC(s, { month: "short", day: "numeric" }) + (meta ? " · " + meta : "") : meta)}</span>
        <span class="tag ${e.cat}">${CATS[e.cat]}</span>
      </span>
      ${CHEV}
    </button>
    <div class="ev-detail" id="${detailId}" ${open ? "" : "hidden"}>
      ${e.location ? `<p>${esc(e.location)}</p>` : ""}
      ${e.description && e.description !== e.location ? `<p>${cleanDescription(e.description)}</p>` : ""}
      <div class="ev-actions">
        <a href="${icsFor(e)}" download="${esc(e.title.replace(/[^\w\s-]/g, "").trim().slice(0, 40) || "event")}.ics">Add to my calendar</a>
        ${e.location ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}" target="_blank" rel="noopener">Directions</a>` : ""}
      </div>
    </div>
  </li>`;
}

$view.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".ev > button");
  if (btn) {
    const li = btn.parentElement;
    const isOpen = li.classList.toggle("open");
    btn.setAttribute("aria-expanded", isOpen);
    li.querySelector(".ev-detail").hidden = !isOpen;
    state.openId = isOpen ? li.dataset.id : null;
    return;
  }
  const chip = ev.target.closest(".chip");
  if (chip) { state.filter = chip.dataset.f; render(); }
  if (ev.target.closest("[data-dismiss-install]")) { store.set("installDismissed", Date.now()); render(); }
  if (ev.target.closest("[data-install]") && deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(() => { deferredPrompt = null; render(); });
  }
});

/* ---------- install banner ---------- */

let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; if (location.hash === "#today" || !location.hash) render(); });
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function installBanner() {
  if (isStandalone()) return "";
  const dismissed = store.get("installDismissed");
  if (dismissed && Date.now() - dismissed < 14 * 86400000) return "";
  const shareIco = '<svg class="share-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/></svg>';
  let body;
  if (isIOS()) body = `<p><strong>Put Taylor PTO on your home screen.</strong></p><p class="small muted">In Safari or Chrome, tap ${shareIco} <strong>Share</strong>, then <strong>Add to Home Screen</strong>. (In Safari, Share may be under <strong>⋯</strong>.)</p>`;
  else if (deferredPrompt) body = `<p><strong>Put Taylor PTO on your home screen.</strong></p><p class="small muted">It opens like an app and works without a connection.</p><button class="btn" type="button" data-install>Install</button>`;
  else return "";
  return `<div class="card install"><img src="icons/icon.png" alt="" width="44" height="44"><div>${body}</div><button class="x" type="button" aria-label="Dismiss" data-dismiss-install>×</button></div>`;
}

/* ---------- screens ---------- */

function upcoming(fromYmd, days, cats) {
  const to = addDays(fromYmd, days);
  return (state.data?.events || []).filter((e) => endYmd(e) >= fromYmd && startYmd(e) <= to && (!cats || cats.includes(e.cat)));
}

// What today is, in a few words. Shown as the Today screen's header.
function todayHeadline(st) {
  if (st.kind === "school") return st.rot || "School day";
  if (st.kind === "early") return "Early dismissal" + (st.rot ? " · " + st.rot : "");
  return "No school";
}
function shortStatus(s) {
  if (s.kind === "school") return s.rot || "School day";
  if (s.kind === "early") return "Early dismissal, " + s.sub;
  if (s.kind === "closure") return "No school, " + s.sub;
  return "No school";
}

function viewToday() {
  const t = todayYmd();
  const st = dayStatus(t);
  const tm = addDays(t, 1);
  const tmSt = dayStatus(tm);
  const tmLabel = fmtUTC(tm, { weekday: "long" });

  // Today / this week / coming up. Each event shows once, under the day it starts
  // (or under Today if it's already underway).
  const wd = dow(t);
  const weekend = wd === 0 || wd === 6;
  const weekStart = weekend ? addDays(t, wd === 6 ? 2 : 1) : tm;   // weekends look ahead to next week
  const weekEnd = addDays(t, weekend ? (wd === 6 ? 8 : 7) : 7 - wd); // through Sunday
  const skip = (e) => e.allDay && /spirit day|order school/i.test(e.title);
  const all = (state.data?.events || []).filter((e) => e.cat !== "rotation" && !skip(e));
  const todays = all.filter((e) => covers(e, t) && e.cat !== "closure" && e.cat !== "early");
  const week = all.filter((e) => startYmd(e) >= weekStart && startYmd(e) <= weekEnd);
  const later = all.filter((e) => startYmd(e) > weekEnd && startYmd(e) <= addDays(weekEnd, 21)).slice(0, 8);
  const list = (evs, withDate) => `<div class="card cal-card"><ul class="ev-list">${evs.map((e) => evRow(e, { withDate, noDay: !withDate })).join("")}</ul></div>`;

  return `
    ${state.offline ? '<div class="offline">You\'re offline. Showing the last saved calendar.</div>' : ""}
    ${installBanner()}
    ${st.kind === "closure" || st.kind === "early" ? `<div class="card status ${st.kind}"><p class="status-sub">${esc(st.kind === "early" ? "Dismissal at " + st.sub : st.sub)}</p></div>` : ""}

    <h2 class="section-h">Today</h2>
    ${todays.length ? list(todays, false) : '<div class="card"><p class="empty" style="margin:0;padding:0">Nothing else on the calendar today.</p></div>'}
    ${weekend ? "" : `<div class="card tomorrow-card"><strong>Tomorrow, ${tmLabel}:</strong> ${esc(shortStatus(tmSt))}</div>`}

    ${week.length ? `<h2 class="section-h">${weekend ? "Next week" : "Rest of this week"}</h2>${list(week, true)}` : ""}

    <h2 class="section-h">Coming up</h2>
    ${later.length ? list(later, true) : '<div class="card"><p class="empty" style="margin:0;padding:0">Nothing on the calendar in the next few weeks.</p></div>'}
    <a class="btn ghost" href="#calendar">See the full calendar</a>

    ${updatedLine()}
  `;
}

function viewCalendar() {
  const t = todayYmd();
  const f = state.filter;
  const groups = { all: null, closures: ["closure", "early"], pto: ["pto"], meeting: ["meeting"], school: ["school"] };
  const evs = (state.data?.events || []).filter((e) => endYmd(e) >= t && (!groups[f] || groups[f].includes(e.cat)));
  const byMonth = new Map();
  for (const e of evs) {
    const k = startYmd(e) < t ? t.slice(0, 7) : startYmd(e).slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(e);
  }
  const chips = [["all", "All"], ["closures", "No school & early"], ["pto", "PTO events"], ["meeting", "Meetings"], ["school", "School"]]
    .map(([k, l]) => `<button class="chip" type="button" data-f="${k}" aria-pressed="${f === k}">${l}</button>`).join("");

  return `
    ${state.offline ? '<div class="offline">You\'re offline. Showing the last saved calendar.</div>' : ""}
    <div class="filters" role="group" aria-label="Filter events">${chips}</div>
    ${byMonth.size ? [...byMonth].map(([k, list]) => `
      <h2 class="month-h">${fmtUTC(k + "-15", { month: "long", year: "numeric" })}</h2>
      <div class="card cal-card"><ul class="ev-list">${list.map((e) => evRow(e)).join("")}</ul></div>`).join("")
      : '<p class="empty">No upcoming events in this category.</p>'}
    <div class="card" style="margin-top:20px">
      <h2 class="card-h">Get it in your own calendar</h2>
      <p class="small muted">Subscribe once and every date shows up in Apple, Google or Outlook Calendar. It stays up to date on its own.</p>
      <a class="btn" href="${LINKS.subscribe}">Subscribe to the calendar</a>
    </div>
    ${updatedLine()}
  `;
}

function viewGive() {
  return `
    <div class="card">
      <p class="section-h" style="margin:0 0 8px">Support the Taylor PTO</p>
      <h2 class="card-h">Every dollar stays at Taylor</h2>
      <p class="small" style="margin:6px 0 14px">Gifts pay for field trips, assemblies, classroom grants, and staff appreciation for every Taylor student.</p>
      <a class="btn gold" href="${LINKS.donate}" target="_blank" rel="noopener">Make a gift</a>
      <p class="fine" style="margin:12px 0 0;text-align:center">Checks can go to the school office, payable to Taylor PTO. The Taylor PTO is a 501(c)(3) nonprofit.</p>
    </div>
    ${(() => {
      const fr = upcoming(todayYmd(), 90, ["pto"]).filter((e) => /fundrais|trivia|bingo|b\.i\.t|boosterthon|stuffies|swag|book fair/i.test(e.title) && !/spirit day/i.test(e.title)).slice(0, 5);
      return fr.length ? `<h2 class="section-h">Upcoming fundraisers</h2><div class="card cal-card"><ul class="ev-list">${fr.map((e) => evRow(e, { withDate: true })).join("")}</ul></div>` : "";
    })()}
  `;
}

const ICON = {
  chat: '<path d="M4 18.5 5.3 15A7.5 7.5 0 1 1 9 18.3Z"/>',
  fb: '<path d="M14 8.5h2.5V5H14a3.5 3.5 0 0 0-3.5 3.5V11H8v3.5h2.5V21H14v-6.5h2.5L17 11h-3V9a.5.5 0 0 1 .5-.5Z"/>',
  ig: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="12" cy="12" r="3.6"/><circle cx="17" cy="7" r=".6"/>',
  hand: '<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11M10 10V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v6"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 5 16.5L4 13a1.5 1.5 0 0 1 2.8-1.2L7 12.5"/>',
  web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
};
const GO = '<svg class="go" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const link = (href, ico, title, desc, ext = true) =>
  `<li><a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ""}><span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[ico]}</svg></span><span><strong>${title}</strong><span class="d">${desc}</span></span>${GO}</a></li>`;

function viewConnect() {
  const meeting = upcoming(todayYmd(), 120, ["meeting"]).find((e) => /pto meeting/i.test(e.title));
  return `
    ${meeting ? `<div class="card">
      <p class="section-h" style="margin:0 0 6px">Next PTO meeting</p>
      <h2 class="card-h">${fmtUTC(startYmd(meeting), { weekday: "long", month: "long", day: "numeric" })}${meeting.allDay ? "" : ", " + fmtTime(meeting.start)}</h2>
      <p class="small muted" style="margin:0">${esc(meeting.location ? meeting.location.split(",")[0] : "Taylor Elementary")}${/babysit/i.test(meeting.title) ? " · Babysitting provided" : ""}</p>
      <p class="small" style="margin:10px 0 0">Every Taylor family is a member. Come to a meeting, no sign-up needed.</p>
    </div>` : ""}

    <h2 class="section-h">Volunteer</h2>
    <div class="card" style="padding:4px 14px"><ul class="links">
      ${todayYmd() <= HOLIDAY_SHOPPE_LAST_DAY ? link("#connect/holiday-shoppe", "hand", "Holiday Shoppe volunteers", "Help run the shoppe Dec 9–11", false) : ""}
      ${link(LINKS.icareForm, "hand", "Sign up for iCare", "Read with a class or help out in the iCare program")}
      ${link("mailto:" + LINKS.email + "?subject=Volunteering%20with%20the%20Taylor%20PTO", "mail", "Offer to help", "Email the PTO board", false)}
    </ul></div>

    <h2 class="section-h">Stay in the loop</h2>
    <div class="card" style="padding:4px 14px"><ul class="links">
      ${link("#chat", "chat", "Family chat", "Announcements, grade rooms and reminders, right here in the app", false)}
      ${link(LINKS.facebook, "fb", "Facebook", "taylorschoolpto")}
      ${link(LINKS.instagram, "ig", "Instagram", "@thetaylorpto")}
      ${link(LINKS.website, "web", "taylorpto.org", "The full PTO website")}
      ${link("mailto:" + LINKS.email, "mail", "Email the board", LINKS.email, false)}
    </ul></div>
    <p class="fine" style="text-align:center;margin-top:16px">Taylor Elementary PTO · 196 South Street, Foxborough, MA · <a href="privacy.html">Privacy</a></p>
  `;
}

// Holiday Shoppe volunteer sign-up (Dec 9–11, 2026, per the PTO Master Calendar).
// The Connect link disappears on its own after the last day.
const HOLIDAY_SHOPPE_LAST_DAY = "2026-12-11";
// Class shopping times, from the school's Holiday Shop sign-up sheet (11/22/26).
// Keep in sync with holiday-shoppe.html and the form's class-time options.
const HOLIDAY_SHOPPE_SCHEDULE = [
  { day: "Wednesday, December 9", classes: [
    ["9:30 a.m.", "Coliflores", "Grade 2"],
    ["10:05 a.m.", "Hoag", "Grade 2"],
    ["10:45 a.m.", "Jarvis", "Grade 3"],
    ["11:50 a.m.", "Culverhouse", "Kindergarten"],
    ["12:30 p.m.", "Reardon", "Grade 1"],
    ["1:40 p.m.", "Timpany", "Grade 3"],
    ["2:15 p.m.", "Donovan", "Grade 3"],
  ] },
  { day: "Thursday, December 10", classes: [
    ["9:30 a.m.", "Nally", "Kindergarten"],
    ["10:05 a.m.", "Zeitler", "Grade 4"],
    ["10:45 a.m.", "Fossella", "Grade 4"],
    ["11:50 a.m.", "Roberts", "Kindergarten"],
    ["12:30 p.m.", "Walsh", "Grade 1"],
    ["1:05 p.m.", "Zabbo", "Grade 1"],
    ["1:40 p.m.", "Doherty", "Grade 4"],
    ["2:15 p.m.", "O'Donnell", "Grade 3"],
  ] },
];

function viewHolidayShoppe() {
  // Same header and details as the website page (holiday-shoppe.html).
  const row = (label, text, first) => `<div style="display:flex;gap:12px;padding:10px 0;${first ? "" : "border-top:1px solid var(--rule)"}"><span class="small" style="flex:0 0 70px;margin:0;font-weight:700;color:var(--heading)">${label}</span><span class="small" style="margin:0">${text}</span></div>`;
  return `
    <div class="card" style="text-align:center;background:#0F4D2E;border-bottom:4px solid #C8102E;color:#ffffff">
      <img src="../img/tiger-holiday.png" alt="The Taylor Tiger in a Santa hat and scarf, holding a wrapped gift" style="display:block;width:110px;height:auto;margin:4px auto 10px">
      <h2 class="card-h" style="color:#ffffff;margin:0 0 6px">Holiday Shoppe</h2>
      <p class="small" style="margin:0 0 10px;color:rgba(255,255,255,0.85)">Kids shop on their own for small gifts for family, friends, teachers, even pets!</p>
      <p class="small" style="margin:0;font-weight:700;color:#ffffff">December 9, 10 &amp; 11 · During the school day</p>
    </div>

    <h2 class="section-h">How shopping works</h2>
    <div class="card" style="padding:4px 14px 6px">
      ${row("Prices", "$0.25 to $15, with most items $3 to $8", true)}
      ${row("Payment", "<strong>Cash only.</strong> An envelope and gift list come home with each student. Send them back with cash by <strong>Tuesday, December 8</strong>.")}
      ${row("Bring", "A shopping bag. Gifts come home wrapped and tagged.")}
      <p class="small" style="margin:0;padding:10px 0 4px;border-top:1px solid var(--rule)"><strong>Scholarships are available.</strong> Contact Mr. G. at <a href="mailto:mrg@taylorpto.org">mrg@taylorpto.org</a>.</p>
    </div>

    <h2 class="section-h">When each class shops</h2>
    <p class="small" style="margin:0 2px 4px">Volunteers usually help during their child's class time, or right before or after.</p>
    ${HOLIDAY_SHOPPE_SCHEDULE.map((d) => `<div class="card" style="padding:4px 14px 6px">
      <p class="small" style="margin:8px 0 2px;font-weight:700;color:var(--heading)">${d.day}</p>
      ${d.classes.map(([t, n, g], i) => row(t, `${esc(n)} · ${g}`, false)).join("")}
    </div>`).join("")}

    <h2 class="section-h">Help run the shoppe</h2>
    <p class="small" style="margin:0 2px 4px">The shoppe is run entirely by parent volunteers. Pick the class times you can help and we'll follow up to confirm your shift.</p>
    <div class="form-embed">
      <iframe src="${LINKS.holidayShoppeForm}?embedded=true" title="Holiday Shoppe volunteer sign-up form" loading="lazy">Loading…</iframe>
    </div>
    <p class="fine" style="text-align:center;margin-top:12px">Form not showing? <a href="${LINKS.holidayShoppeForm}" target="_blank" rel="noopener">Open it in your browser</a> · <a href="../img/holiday-shoppe-flyer-2026.png" target="_blank" rel="noopener">Flyer</a> · <a href="#connect">Back to Connect</a></p>
  `;
}

function updatedLine() {
  if (!state.data?.updated) return "";
  const d = new Date(state.data.updated);
  return `<p class="updated">Calendar synced ${d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>`;
}

/* ---------- router ---------- */

const SCREENS = { today: ["Today", viewToday], calendar: ["Calendar", viewCalendar], give: ["Give", viewGive], connect: ["Connect", viewConnect] };

function render() {
  const path = (location.hash || "#today").slice(1);
  const key = path.split("/")[0];
  const tab = key === "chat" || SCREENS[key] ? key : "today";
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.body.classList.toggle("in-room", /^chat\/(?!admin|settings)[^/]+$/.test(path));
  if (key === "chat") {
    $eyebrow.textContent = EYEBROW;
    document.title = "Chat · Taylor PTO";
    if (window.Chat) window.Chat.render(path);
    else { $title.textContent = "Chat"; $view.innerHTML = '<p class="empty">Chat couldn\'t load. Check your connection.</p>'; }
    return;
  }
  if (path === "connect/holiday-shoppe") {
    $title.textContent = "Holiday Shoppe";
    $eyebrow.textContent = EYEBROW;
    document.title = "Holiday Shoppe · Taylor PTO";
    $view.innerHTML = viewHolidayShoppe();
    return;
  }
  const [title, fn] = SCREENS[key] || SCREENS.today;
  const isToday = fn === viewToday && state.data;
  $title.textContent = isToday ? todayHeadline(dayStatus(todayYmd())) : title;
  $eyebrow.textContent = isToday ? fmtUTC(todayYmd(), { weekday: "long", month: "long", day: "numeric" }) : EYEBROW;
  document.title = title === "Today" ? "Taylor PTO" : `${title} · Taylor PTO`;
  $view.innerHTML = state.data ? fn() : '<p class="empty">Loading…</p>';
}

let lastKey = null;
window.addEventListener("hashchange", () => {
  const key = location.hash.slice(1);
  if (key !== lastKey) { state.openId = null; window.scrollTo(0, 0); lastKey = key; }
  render();
});

(async function init() {
  const cached = store.get("events");
  if (cached) { state.data = cached; render(); }
  await loadEvents();
  if (!state.data) { $view.innerHTML = '<p class="empty">Couldn\'t load the calendar. Check your connection and try again.</p>'; return; }
  render();
})();

// Pick up new versions without making people close the app twice:
// check for an update whenever the app comes back to the foreground, and reload
// once the new version takes over (unless someone is mid-typing; then wait).
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let pendingReload = false;
  const typing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  navigator.serviceWorker.register("sw.js").then((reg) => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
      else if (pendingReload) location.reload();
    });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;            // first install, nothing to refresh
    if (typing()) pendingReload = true; else location.reload();
  });
}

// Refresh when the app comes back to the foreground (so "Today" is never stale).
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") { await loadEvents(); render(); }
});
