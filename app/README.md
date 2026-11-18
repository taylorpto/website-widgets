# The Taylor PTO app

`app/` is a phone app parents can install from
**https://taylorpto.github.io/website-widgets/app/**. No App Store is involved:
on iPhone they open the link in Safari, tap **Share → Add to Home Screen**;
on Android Chrome offers an **Install** button. It opens full-screen with the
PTO badge as its icon and works without a connection.

**You never edit the app to change what it shows:**

| To change… | Edit this |
|---|---|
| Events, no-school days, early dismissals, rotation days | The PTO Google Calendar. The app picks up changes within the hour. |
| Annual Fund numbers | The *Thermometer* tab of the Website Data sheet (same as the website widget). After the deadline the app swaps the progress bar for a general "Make a gift" card. |
| Donate / WhatsApp / social / iCare form links | The `LINKS` block at the top of `app/app.js`. |

How the calendar gets in: browsers can't read Google Calendar directly, so
the **Sync calendar** GitHub Action (`.github/workflows/sync-calendar.yml`)
runs `scripts/ics-to-json.mjs` every hour and saves `app/data/events.json`.
It only commits when something changed. To force a sync: **Actions → Sync
calendar → Run workflow**. Event categories (No school, Early dismissal, PTO,
Meeting, School) are guessed from event titles, so keep words like
"NO SCHOOL" and "Early Dismissal" in those titles.

If you change `app.js`, `app.css` or `index.html`, bump `VERSION` in
`app/sw.js` (and the `?v=` numbers) so installed phones fetch the new copy.
