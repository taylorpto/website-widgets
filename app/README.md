# The Taylor PTO app

> **Running this day to day?** See the Taylor PTO App & Website SOP: https://claude.ai/artifact/GibDErzVE5HGn2uUAWw27N (accounts, everyday updates, chat admin, hand-off and yearly checklists, troubleshooting).

`app/` is a phone app parents can install from
**https://app.taylorpto.org** (the old taylorpto.github.io/website-widgets/app/ address forwards there). No App Store is involved:
on iPhone they open the link in Safari or Chrome, tap **Share → Add to Home Screen**;
on Android Chrome offers an **Install** button. It opens full-screen with the
PTO badge as its icon and works without a connection.

**You never edit the app to change what it shows:**

| To change… | Edit this |
|---|---|
| Events, no-school days, early dismissals, rotation days | The PTO Google Calendar. The app picks up changes within the hour. |
| Donate / social / iCare form links | The `LINKS` block at the top of `app/app.js`. |

How the calendar gets in: browsers can't read Google Calendar directly, so
the **Sync calendar** GitHub Action (`.github/workflows/sync-calendar.yml`)
runs `scripts/ics-to-json.mjs` every hour and saves `app/data/events.json`.
It only commits when something changed. To force a sync: **Actions → Sync
calendar → Run workflow**. Event categories (No school, Early dismissal, PTO,
Meeting, School) are guessed from event titles, so keep words like
"NO SCHOOL" and "Early Dismissal" in those titles.

If you change `app.js`, `app.css` or `index.html`, bump `VERSION` in
`app/sw.js` (and the `?v=` numbers) so installed phones fetch the new copy.

## Chat

The **Chat** tab is a private chat for Taylor families, replacing the WhatsApp
group. It runs on a free Supabase project (`taylor-pto-app`, owned by the
`taylorpto` GitHub account; sign in to supabase.com with that account).

- **Joining:** a parent signs in with a 6-digit code sent to their email,
  enters the invite code from the newsletter, and waits. A board member
  approves them under **Chat → Members**.
- **Rooms:** Announcements (board posts only; everyone gets a notification),
  General, one room per grade, Volunteers, and a private Board room.
- **Board tools (Chat → Members):** approve or decline families, remove
  members, make someone a board member, see the invite code and change it,
  and handle reported messages. Anyone can delete their own messages; board
  members can delete any message.
- **Notifications:** parents turn them on in the app. On iPhone this only
  works from the home-screen app (Share, then Add to Home Screen).

Where things live:

| What | Where |
|---|---|
| Who can see and post what (enforced by the database) | `supabase/schema.sql` |
| Push notification sender | `supabase/functions/notify/index.ts` |
| The chat screens | `app/chat.js` |
| First board admin(s) | `admin_emails` in the database's private settings: anyone signing up with one of those emails becomes an approved board member automatically |

Nothing secret is stored in this repo. The keys in `app/chat.js` are public
by design; access is controlled by the database rules.
