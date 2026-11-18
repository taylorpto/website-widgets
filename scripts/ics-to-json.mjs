// Converts the PTO's public Google Calendar into app/data/events.json.
//
// Why this exists: browsers can't read the Google Calendar feed directly
// (Google doesn't allow cross-site requests), so a GitHub Action runs this
// every hour and saves a copy the app CAN read. Nobody needs to run it by hand.
//
// To change what's on the calendar, edit the Google Calendar, not this file.
//
// Usage: node scripts/ics-to-json.mjs [path/to/file.ics]   (no arg = download)

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const ICS_URL =
  "https://calendar.google.com/calendar/ical/c_b9a6473fec98047ae635bd632c2fb5d2df23ee6a31d746eee3ef71feea461fd5%40group.calendar.google.com/public/basic.ics";
const OUT = new URL("../app/data/events.json", import.meta.url);

const DAY = 86400000;
const WINDOW_START = Date.now() - 45 * DAY; // keep recent past for context
const WINDOW_END = Date.now() + 420 * DAY;

// ---------- parse ----------

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}
function unescape(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}

function parseDate(prop, value) {
  // returns { allDay, ms, ymd }
  if (/VALUE=DATE(?!-)/.test(prop) || /^\d{8}$/.test(value)) {
    const ymd = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return { allDay: true, ymd, ms: Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8)) };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { allDay: false, ms: Date.UTC(+y, mo - 1, +d, +h, +mi, +s) };
  // Floating / TZID time: the PTO is in America/New_York.
  return { allDay: false, ms: nyToUtc(+y, mo - 1, +d, +h, +mi, +s) };
}

function nyToUtc(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asNy = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return guess + (guess - asNy);
}

function parseEvents(text) {
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const prop = line.slice(0, i);
    const value = line.slice(i + 1);
    const name = prop.split(";")[0];
    if (name === "DTSTART") cur.start = parseDate(prop, value);
    else if (name === "DTEND") cur.end = parseDate(prop, value);
    else if (name === "SUMMARY") cur.title = unescape(value);
    else if (name === "LOCATION") cur.location = unescape(value);
    else if (name === "DESCRIPTION") cur.description = unescape(value);
    else if (name === "UID") cur.uid = value;
    else if (name === "RRULE") cur.rrule = Object.fromEntries(value.split(";").map((kv) => kv.split("=")));
    else if (name === "EXDATE") for (const v of value.split(",")) { const d = parseDate(prop, v); if (d) cur.exdates.push(d.ms); }
    else if (name === "STATUS") cur.status = value;
    else if (name === "RECURRENCE-ID") cur.recurrenceId = parseDate(prop, value);
  }
  return events;
}

// ---------- recurrence (covers what Google Calendar emits for this calendar) ----------

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function expand(ev) {
  if (!ev.rrule) return [ev.start.ms];
  const r = ev.rrule;
  const interval = +(r.INTERVAL || 1);
  const until = r.UNTIL ? parseDate(r.UNTIL.length === 8 ? "VALUE=DATE" : "", r.UNTIL).ms + (r.UNTIL.length === 8 ? DAY - 1 : 0) : Infinity;
  const count = r.COUNT ? +r.COUNT : Infinity;
  const out = [];
  const start = new Date(ev.start.ms);
  const limit = Math.min(until, WINDOW_END);
  const timeOfDay = ev.start.ms - Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());

  for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= limit && out.length < count; t += DAY) {
    const d = new Date(t);
    const daysFrom = Math.round((t - (ev.start.ms - timeOfDay)) / DAY);
    let hit = false;
    if (r.FREQ === "DAILY") hit = daysFrom % interval === 0;
    else if (r.FREQ === "WEEKLY") {
      const days = r.BYDAY ? r.BYDAY.split(",").map((x) => BYDAY[x.slice(-2)]) : [start.getUTCDay()];
      hit = days.includes(d.getUTCDay()) && Math.floor(daysFrom / 7) % interval === 0;
    } else if (r.FREQ === "MONTHLY") {
      const md = r.BYMONTHDAY ? +r.BYMONTHDAY : start.getUTCDate();
      const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
      hit = d.getUTCDate() === md && months % interval === 0;
    } else if (r.FREQ === "YEARLY") {
      hit = d.getUTCMonth() === start.getUTCMonth() && d.getUTCDate() === start.getUTCDate();
    }
    if (hit) out.push(t + timeOfDay);
  }
  return out.filter((ms) => !ev.exdates.includes(ms));
}

// ---------- categorise ----------

function category(title) {
  const t = title.toLowerCase();
  if (/^day [1-6]$/.test(t)) return "rotation";
  if (/no school|break\b|vacation|holiday.*closed|school closed/.test(t)) return "closure";
  if (/early (dismissal|release)/.test(t)) return "early";
  if (/social|gathering/.test(t)) return "pto";
  if (/pto meeting|board election|election for pto/.test(t)) return "meeting";
  if (/pto|fundrais|trivia|bingo|b\.i\.t|boosterthon|trot|run club|stuffies|treat trolley|dance|picnic|trunk-or-treat|book fair|swag|appreciation/.test(t)) return "pto";
  return "school";
}

// ---------- main ----------

const text = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : await (await fetch(ICS_URL)).text();

if (!text.includes("BEGIN:VCALENDAR")) {
  console.error("Calendar download failed; leaving events.json unchanged.");
  process.exit(1);
}

const raw = parseEvents(text).filter((e) => e.start && e.title && e.status !== "CANCELLED");

// Single-instance overrides of recurring events replace that occurrence.
const overrides = new Set(raw.filter((e) => e.recurrenceId).map((e) => `${e.uid}|${e.recurrenceId.ms}`));

const events = [];
const rotation = {};

for (const ev of raw) {
  const durMs = ev.end ? ev.end.ms - ev.start.ms : ev.start.allDay ? DAY : 0;
  for (const ms of expand(ev)) {
    if (!ev.recurrenceId && overrides.has(`${ev.uid}|${ms}`)) continue;
    if (ms + durMs < WINDOW_START || ms > WINDOW_END) continue;
    const cat = category(ev.title);
    const startIso = ev.start.allDay ? new Date(ms).toISOString().slice(0, 10) : new Date(ms).toISOString();
    if (cat === "rotation") { rotation[startIso] = ev.title; continue; }
    const endMs = ms + durMs;
    events.push({
      id: `${ev.uid}-${ms}`,
      title: ev.title.replace(/\s+/g, " ").trim(),
      allDay: ev.start.allDay,
      start: startIso,
      // all-day end is exclusive in iCal; store the last day inclusive
      end: ev.start.allDay ? new Date(endMs - DAY).toISOString().slice(0, 10) : new Date(endMs).toISOString(),
      location: ev.location || null,
      description: ev.description || null,
      cat,
    });
  }
}

events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));

const out = { source: "Taylor PTO Google Calendar", updated: new Date().toISOString(), events, rotation };
mkdirSync(new URL("../app/data/", import.meta.url), { recursive: true });

// Only rewrite when the content changed, so the hourly job doesn't make empty commits.
let prev = null;
try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
if (prev && JSON.stringify(prev.events) === JSON.stringify(events) && JSON.stringify(prev.rotation) === JSON.stringify(rotation)) {
  console.log(`No changes (${events.length} events).`);
} else {
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(`Wrote ${events.length} events, ${Object.keys(rotation).length} rotation days.`);
}
