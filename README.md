# Taylor PTO — website widgets

Embeddable blocks for **www.taylorpto.org**. The website runs on Google Sites;
these files provide the pieces Google Sites can't do on its own — branded
layouts and anything that shows live numbers.

Hosted free on GitHub Pages at
`https://taylorpto.github.io/website-widgets/`

**If you are new to this and just need to change a number, skip to
"Updating the fundraising total" — you do not need to touch any code.**

---

## Files

| File | What it is |
|---|---|
| `styles.css` | All colours, fonts, and shared blocks. **Edit here to change the look.** |
| `thermometer.html` | Annual Fund progress bar. Reads live totals from a Google Sheet. |
| `page-template.html` | Blank starting point for a new page. Copy it, rename it, replace the words. |
| `trunk-or-treat.html` | Trunk or Treat event page. **Event dates live here** — see warning below. |

---

## Updating the fundraising total

**You don't edit any file for this.** The thermometer reads from a Google Sheet.

1. Open **Taylor PTO – Website Data (PUBLIC)** in Google Drive
2. Go to the **Thermometer** tab
3. Change `raised` (and `donors` if you're tracking them)
4. Wait about five minutes — Google caches published sheets

The website updates itself. No deploy, no code.

The same sheet holds `goal` and `deadline`. Past the deadline the widget hides
the donate button on its own and switches to a thank-you message.

> **Important:** only the *Thermometer* tab is published to the web. If you add
> tabs, publish them individually — never choose "Entire document," which would
> expose everything in the file.

---

## Changing the look

Open `styles.css`. At the top is a `:root` block:

```css
--navy:  #1B3A6B;
--gold:  #C9A84C;
```

Change a value there and **every page updates at once**. That's the whole point
of this setup — don't copy colours into individual files, or they'll drift apart
the first time someone updates one and forgets the others.

These values were taken from the live Fundraising page, and the Annual Fund
emails and printed handout were rebuilt to match them. Change them here and the
website will no longer match the print material until that is rebuilt too.

The site runs on **Roboto** — light (300) body copy, heavy (700/900) headings.
Any page using this stylesheet must load the font itself:

```html
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;600;700;900&display=swap" rel="stylesheet">
```

---

## Adding a new page

1. Copy `page-template.html`, rename it (e.g. `volunteer.html`)
2. Delete the blocks you don't need, replace the words in the ones you keep
3. Commit it
4. In Google Sites: **Insert → Embed → By URL** →
   `https://taylorpto.github.io/website-widgets/volunteer.html`
5. Drag the frame to fit — embeds do **not** auto-resize

Available blocks, all shown in the template: `hero`, `section` (plain or
`tinted`), `cards`, `ways`, `callout`, `btn`, `pto-foot`.

---

## Event dates

`trunk-or-treat.html` has the event date typed into it. That is a copy, and
copies drift — this page was live for weeks saying "Saturday, October 19" when
October 19, 2026 is a **Monday**.

Before changing any date here, check the **PTO Master Calendar** (Google
Calendar, owned by ben@taylorpto.org). It is the source of truth. Then update
this file to match, and check the flyer image says the same thing.

Never type a weekday name you have not verified against a calendar.

---

## Things that will trip you up

**Embeds are invisible to site search.** Google Sites' "Search this site" box
does not look inside embedded frames. Keep meeting dates, the contact address,
and how to give in ordinary Sites text somewhere too.

**Embeds don't resize themselves.** You set a fixed height in Sites. If content
grows past it, it gets cut off.

**Test on a phone.** Most families read on one. The stylesheet handles narrow
screens, but check after any layout change.

**Changes are live immediately.** Committing here publishes to the website with
nobody reviewing in between. A typo is a typo on the live site.

---

## How the data flows

```
Google Sheet (Thermometer tab)
        ↓  published to web as CSV
thermometer.html  ← hosted on GitHub Pages
        ↓  embedded by URL
www.taylorpto.org  ← Google Sites
```

If the sheet can't be reached, the widget shows the last-known figures written
into the file **and** displays "Totals may be a few days behind" so nobody
mistakes stale numbers for current ones. It never renders blank or broken.

---

## Accounts

Everything lives under PTO-owned accounts so it survives board turnover:

- **GitHub:** `taylorpto` — hosts these files
- **Google:** `ben@taylorpto.org` — owns the site and the data sheet

Whoever takes over communications needs both. If you are handing this off, make
sure the logins are in the PTO's shared password store and not only in someone's
browser.

---

## Contact

board@taylorpto.org
