# Pitwall

**An F1 strategist's command center, in your browser.** Live timing, telemetry, race trace, tyre stints, championship standings, and onboard telemetry with a synchronised speed-coloured racing line — built on the [OpenF1](https://openf1.org) public API.

Zero build step. Three files of vanilla HTML / CSS / JS. Deploys to Netlify in a minute.

> _Unofficial. Not affiliated with Formula 1._

---

## Highlights

**Race & strategy**
- **Overview** — country flag, hero, podium, computed insights (most overtakes, fastest pit, biggest grid jumper, track-temp swing).
- **Results** — final classification with grid → finish Δ, points, DNF/DSQ badges, fastest lap.
- **Race Trace** — position-by-lap line chart, one line per driver in team colour.
- **Stints / Pit Stops / Overtakes** — strategy tabs with team-coloured timelines and timestamps.

**Driver deep-dives**
- **Onboard** — pick a driver + lap → speed-coloured racing line on a real GPS-traced track map, plus speed / throttle / brake / gear / DRS traces. Hovering the speed chart drops a synchronised crosshair _and_ a glowing dot on the track at that exact point.
- **Compare** — A/B two drivers with side-by-side stats, sector deltas, and overlay lap chart.
- **Driver side panel** — click any driver acronym anywhere → slide-over with their session summary (pace, strategy, battle).

**Championship**
- **Standings** — drivers' and constructors' tables for the season, computed from `session_result`. Verified against the 2024 season's official totals (VER 437/9 wins, McLaren 666 constructors' points).

**Communication**
- **Race Control** — flag/category-coloured FIA message timeline.
- **Radio** — team-radio MP3s with inline `<audio>` players, filterable by driver.

**Conditions**
- **Weather** — air/track temp, humidity & wind charts, plus rainfall flag.

**Shell features**
- **Sidebar IA** with grouped nav (Race · Championship · Drivers · Lap analysis · Strategy · Communication · Conditions).
- **F1 Calendar** slide-over with status pills (DONE / UPCOMING / LIVE / CANCELLED) and click-to-jump.
- **⌘K command palette** — fuzzy-search across drivers, sessions, sections.
- **URL hash routing** — every view shareable (`#year=2024&meeting=…&session=…&tab=onboard&driver=1`).
- **Light & dark themes** with theme-aware Chart.js styling.
- **Accessible** — focus traps in dialogs, keyboard activation everywhere, `aria-pressed` toggles, `prefers-reduced-motion`.
- **Client-side access gate** with SHA-256 hashed key (soft lock — see [Access key](#access-key)).
- **Live-aware** — upcoming sessions show a countdown + weekend schedule; cancelled sessions show a clear "no data" state.

---

## Tech

- Pure HTML + CSS + JavaScript. No bundler, no framework, no build step.
- [Chart.js v4](https://www.chartjs.org/) loaded via CDN.
- Fonts: Inter / Saira Condensed / JetBrains Mono via Google Fonts (preloaded).
- Data: [OpenF1](https://openf1.org) public API. Rate-limit-aware (concurrency cap + retry/backoff + LRU cache).

---

## Run locally

Any static server works. Pick one:

```bash
# Python
python3 -m http.server 8765

# Node (one-liner)
npx serve

# PHP
php -S localhost:8765
```

Open `http://localhost:8765`. Default access key is **`pitwall`** (you'll change this — see below).

---

## Access key

Pitwall ships with a **client-side access gate** that serves two purposes:

1. **Reduces OpenF1 rate-limit pressure.** OpenF1 throttles by IP at the edge, and the dashboard is fetch-heavy by design — Onboard pulls `car_data` + `location` (hundreds of GPS samples) per lap, Standings fires 60+ parallel requests on first visit, every Overview computes insights from four endpoints in parallel. The gate stops casual or accidental visitors from each spinning up a full dashboard load and burning the limiter shared with you and any genuine users. The in-app retry/backoff handles transient 429s; the gate keeps the steady-state load polite.
2. **Soft "don't accidentally land here" lock.** Anyone who follows the URL has to enter the key to render anything.

It is **not** real authentication — the SHA-256 of the key is stored as a constant in `app.js`, so anyone who reads the source can see the hash. That's an acceptable trade for the use case (a personal/portfolio dashboard you share selectively).

**To set your own key:**

```bash
printf '%s' 'YOUR_NEW_KEY' | shasum -a 256
```

Paste the hex output as the value of `ACCESS_KEY_HASH` near the top of [`app.js`](app.js).

**Note on public repos:** the hash is in the source. If your repo is public and your key is weak/common, someone could brute-force it offline. Either keep the repo private, or use a strong random key. For real auth, [Netlify Identity](https://docs.netlify.com/visitor-access/identity/) + Edge Functions is the upgrade path.

---

## Deploy to Netlify

This repo includes a [`netlify.toml`](netlify.toml) with security headers and a Content-Security-Policy locked to the four origins this app actually uses (`api.openf1.org`, `media.formula1.com`, `livetiming.formula1.com`, `cdn.jsdelivr.net`).

**Option A — Netlify CLI**

```bash
npx netlify-cli login
npx netlify-cli deploy --dir=.            # preview
npx netlify-cli deploy --dir=. --prod     # ship it
```

**Option B — Drag & drop**

Zip the project folder, drop it on [app.netlify.com/drop](https://app.netlify.com/drop).

**Option C — Connected to GitHub**

In Netlify: _Add new site → Import an existing project_, point it at this repo, leave build command empty, publish dir `.`. Auto-deploys on every push.

---

## File structure

```
.
├── index.html        # Shell: sidebar, panels, dialogs (gate, palette, calendar, side panel)
├── styles.css        # Theme tokens (dark/light), layout, components, animations
├── app.js            # Single-file vanilla app — see "Architecture" below
├── netlify.toml      # Deploy config + security headers + scoped CSP
├── .gitignore
└── README.md
```

---

## Architecture

`app.js` is single-file vanilla. Top-down it's:

1. **`CONFIG`** — tunable constants (cache cap, retry counts, animation durations, GPS sample rate).
2. **State** — documented at the top with the shape of every public + internal key.
3. **API client** (`api()`) — concurrency limiter (max 3 parallel), retry-with-backoff on 429s honouring `Retry-After`, request coalescing, AbortSignal support, LRU cache (200 entries by default).
4. **Helpers** — `fmt`, `escapeHtml`, `fallbackImg` (image fallback via event delegation), `animateCounters`, `chartTheme`, focus management.
5. **Render scaffolding** — one `renderTab(tab)` that handles skeleton, min-skeleton-time, re-entrancy, error boundary, and transactional `loaded[tab]`.
6. **Per-tab renderers** — one async function per tab, each pulling from cached `api()` calls.
7. **Dialogs** — gate, command palette, calendar, driver side panel — each with focus capture/restore + Tab-trap.
8. **Routing** — `parseHash()` / `writeHash()` keep state in sync with the URL.

All endpoints used: `meetings · sessions · drivers · session_result · starting_grid · position · intervals · laps · pit · stints · race_control · weather · overtakes · car_data · location · team_radio` (16 of 16).

---

## Disclaimer

This project is **unofficial** and **not affiliated with, endorsed by, or sponsored by Formula 1**. F1, Formula 1, and FIA are registered trademarks of their respective owners. All race data is provided by [OpenF1](https://openf1.org); team logos, driver photos, and circuit images are loaded from `media.formula1.com` for personal/non-commercial display.

---

## License

[MIT](LICENSE) — do whatever you want with the code, just keep the copyright notice.
