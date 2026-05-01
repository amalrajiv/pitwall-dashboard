/* Pitwall — F1 Strategy Dashboard (data: openf1.org)
 *
 * Access gate (client-side):
 *   ACCESS_KEY_HASH below is the SHA-256 hex of the access key.
 *   Default key is "pitwall". To change:
 *     printf '%s' 'YOUR_KEY' | shasum -a 256
 *   then replace the constant below. This is a soft gate (anyone with
 *   the source can read the hash) — fine for "don't accidentally open
 *   this URL", not real authentication.
 */
const ACCESS_KEY_HASH = "1d5e77ee301c5cbbb87ed419084ef42434f9a7f8d60e38431042f68345e95a3"; // sysaccess001

const API = "https://api.openf1.org/v1";
const YEARS = [2026, 2025, 2024, 2023];

/* ------------------- Tunables (named constants) ------------------- */
const CONFIG = {
  CACHE_MAX: 200,                    // LRU cap on api() result cache
  FETCH_RETRIES: 6,                  // attempts in _fetchWithRetry
  FETCH_BACKOFF_MS: 600,             // base for retry backoff
  TELEMETRY_TRIM_MS: 50,             // tighten location window inside the lap
  HERO_TRACK_TRIM_MS: 200,           // wider window for hero outline (single fast lap)
  TRACE_OUTLIER_RATIO: 6,            // GPS outlier filter: max step / median step
  SPEED_HUE_MAX_KMH: 340,            // top of speed→color rainbow
  COUNT_ANIMATION_MS: 600,           // animateCounters default duration
  SKELETON_MIN_MS: 120,              // minimum skeleton dwell to avoid flicker
  COUNTDOWN_TICK_MS: 1000,           // status badge tick rate
};

const TAB_META = {
  overview:  { group: "Race",          label: "Overview" },
  results:   { group: "Race",          label: "Results" },
  trace:     { group: "Race",          label: "Race Trace" },
  standings: { group: "Championship",  label: "Standings" },
  drivers:   { group: "Drivers",       label: "Drivers" },
  onboard:   { group: "Drivers",       label: "Onboard" },
  compare:   { group: "Drivers",       label: "Compare" },
  laps:      { group: "Lap Analysis",  label: "Lap Times" },
  sectors:   { group: "Lap Analysis",  label: "Sectors" },
  stints:    { group: "Strategy",      label: "Stints" },
  pits:      { group: "Strategy",      label: "Pit Stops" },
  overtakes: { group: "Strategy",      label: "Overtakes" },
  control:   { group: "Communication", label: "Race Control" },
  radio:     { group: "Communication", label: "Radio" },
  weather:   { group: "Conditions",    label: "Weather" },
};

/* ------------------- LRU cache ------------------- */
class LRUMap extends Map {
  constructor(max) { super(); this.max = max; }
  get(k) {
    if (!super.has(k)) return undefined;
    const v = super.get(k);
    super.delete(k);
    super.set(k, v); // touch → most recent
    return v;
  }
  set(k, v) {
    if (super.has(k)) super.delete(k);
    else if (this.size >= this.max) super.delete(this.keys().next().value);
    super.set(k, v);
    return this;
  }
}

/* ------------------- State (shape) -------------------
 *   Public: year, meeting{,Key}, session{,Key}, meetings[], sessions[], drivers[], driversByNum{}
 *   Tab state: activeTab, loaded{tab:bool}
 *   Caches: cache (LRU), _pending (in-flight dedup)
 *   Internals (prefix _):
 *     _charts        — Chart.js instances by canvas id
 *     _onboard       — { driverNum, lapNumber } picker state
 *     _onboardCtx    — { project, locations, lap } for crosshair scrubbing
 *     _onboardCrosshairX — current scrub position (seconds into lap)
 *     _onboardAbort  — AbortController for car_data/location fetches
 *     _compare       — { a, b } selected drivers
 *     _paletteItems / _paletteFiltered / _paletteIndex — ⌘K palette state
 *     _cdTimer       — countdown ticker interval id
 *     _lastStatus    — last computed sessionStatus (to detect transitions)
 *     _renderingTab  — re-entrancy guard for renderTab
 *     _focusTrap     — { previous, root } for dialog focus restoration
 *     _skipUrl       — flag for one-shot routing operations
 * --------------------------------------------------- */
const state = {
  year: null,
  meetings: [],
  meetingKey: null,
  sessions: [],
  sessionKey: null,
  session: null,
  meeting: null,
  drivers: [],
  driversByNum: {},
  activeTab: "overview",
  loaded: {},
  cache: new LRUMap(CONFIG.CACHE_MAX),
  _skipUrl: false,
};

/* ------------------- API client ------------------- */
const MAX_CONCURRENT = 3;
let _inflight = 0;
const _queue = [];

function _acquire() {
  if (_inflight < MAX_CONCURRENT) { _inflight++; return Promise.resolve(); }
  return new Promise((resolve) => _queue.push(resolve));
}
function _release() {
  const next = _queue.shift();
  if (next) next(); else _inflight--;
}

async function _fetchWithRetry(url, opts = {}) {
  const attempts = CONFIG.FETCH_RETRIES;
  for (let i = 0; i < attempts; i++) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) {
      if (e.name === "AbortError" || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, CONFIG.FETCH_BACKOFF_MS * (i + 1) * 0.7));
      continue;
    }
    if (res.status === 429 && i < attempts - 1) {
      const retryAfter = +res.headers.get("retry-after") || 0;
      const delay = Math.max(retryAfter * 1000, CONFIG.FETCH_BACKOFF_MS * (i + 1) + Math.random() * 200);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return res;
  }
}

/**
 * Fetch from OpenF1 with caching, request coalescing, and concurrency limits.
 * Pass `_signal` in params to attach an AbortSignal — it will be stripped from the URL.
 */
async function api(path, params = {}) {
  const signal = params._signal;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "_signal") continue;
    if (v !== undefined && v !== null && v !== "") usp.set(k, v);
  }
  const url = `${API}/${path}?${usp.toString()}`;
  if (state.cache.has(url)) return state.cache.get(url);
  // Coalesce concurrent identical requests (when no signal — signals make each call its own)
  if (!signal && state._pending && state._pending.has(url)) return state._pending.get(url);
  state._pending ||= new Map();
  const promise = (async () => {
    await _acquire();
    try {
      const res = await _fetchWithRetry(url, signal ? { signal } : {});
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      const data = await res.json();
      state.cache.set(url, data);
      return data;
    } finally {
      _release();
      if (!signal) state._pending.delete(url);
    }
  })();
  if (!signal) state._pending.set(url, promise);
  return promise;
}

/* ------------------- Status ------------------- */
const statusEl = () => document.getElementById("status");
let statusJobs = 0;
function setBusy(label) {
  statusJobs++;
  statusEl().classList.remove("error");
  statusEl().innerHTML = `<span class="spin"></span>${label || "Loading…"}`;
}
function clearBusy() {
  statusJobs = Math.max(0, statusJobs - 1);
  if (statusJobs === 0) statusEl().textContent = "";
}
function setError(msg) {
  statusJobs = 0;
  statusEl().classList.add("error");
  statusEl().textContent = msg;
}

/* ------------------- Helpers ------------------- */
const $ = (sel) => document.querySelector(sel);
const panel = (key) => document.getElementById(`panel-${key}`);
const fmt = {
  time(date) {
    if (!date) return "—";
    const d = new Date(date);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  },
  dateLong(date) {
    if (!date) return "—";
    const d = new Date(date);
    return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  },
  duration(secs) {
    if (secs == null || isNaN(secs)) return "—";
    const m = Math.floor(secs / 60);
    const s = (secs - m * 60);
    if (m > 0) return `${m}:${s.toFixed(3).padStart(6, "0")}`;
    return s.toFixed(3);
  },
  delta(secs) {
    if (secs == null || isNaN(secs)) return "—";
    if (secs === 0) return "—";
    return (secs > 0 ? "+" : "") + secs.toFixed(3);
  },
  gap(g) {
    if (g == null) return "—";
    if (typeof g === "string") return g;
    return "+" + Number(g).toFixed(3);
  },
  gapValue(gap) {
    if (gap == null) return "—";
    if (typeof gap === "string") return gap;
    if (Array.isArray(gap)) {
      // Qualifying returns [Q1, Q2, Q3] — show the deepest stage reached
      for (let i = gap.length - 1; i >= 0; i--) {
        if (gap[i] != null) return "+" + Number(gap[i]).toFixed(3);
      }
      return "—";
    }
    return "+" + Number(gap).toFixed(3);
  },
  countdown(target) {
    if (!target) return "—";
    const ms = new Date(target).getTime() - Date.now();
    if (ms <= 0) return "now";
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${ss}s`;
    return `${ss}s`;
  },
};

function sessionStatus(s = state.session) {
  if (!s) return "unknown";
  if (s.is_cancelled) return "cancelled";
  const now = Date.now();
  const start = new Date(s.date_start).getTime();
  const end = new Date(s.date_end).getTime();
  if (now < start) return "upcoming";
  if (now > end) return "completed";
  return "live";
}
const teamColor = (d) => d?.team_colour ? `#${d.team_colour}` : "#666";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fallbackImg(el) {
  if (!el || el.dataset._fallbackApplied) return;
  el.dataset._fallbackApplied = "1";
  // Sanitize initials to safe XML characters (alphanumeric + space). F1 acronyms are 3 letters in practice.
  const initials = (el.dataset.initials || "?").slice(0, 3).replace(/[^A-Za-z0-9 ]/g, "");
  const bg = (el.dataset.bg || "#1d222c").replace(/[^#a-zA-Z0-9]/g, "");
  el.src = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'><rect width='80' height='80' fill='${encodeURIComponent(bg)}'/><text x='40' y='48' text-anchor='middle' font-family='Arial Black' font-size='22' fill='white'>${initials}</text></svg>`;
}

function animateCounters(root) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const els = root.querySelectorAll("[data-count-to]");
  els.forEach((el) => {
    const target = parseFloat(el.dataset.countTo);
    if (isNaN(target)) return;
    const decimals = parseInt(el.dataset.countDecimals || "0", 10);
    if (reduced) {
      el.textContent = decimals > 0 ? target.toFixed(decimals) : Math.round(target).toString();
      return;
    }
    const dur = parseInt(el.dataset.countDuration || String(CONFIG.COUNT_ANIMATION_MS), 10);
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    function frame(now) {
      const t = Math.min(1, (now - start) / dur);
      const v = target * ease(t);
      el.textContent = decimals > 0 ? v.toFixed(decimals) : Math.round(v).toString();
      if (t < 1) requestAnimationFrame(frame);
      else el.textContent = decimals > 0 ? target.toFixed(decimals) : Math.round(target).toString();
    }
    requestAnimationFrame(frame);
  });
}

/* ------------------- Theme-aware Chart.js ------------------- */
function chartTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim() || undefined;
  return {
    text: v("--text"),
    textDim: v("--text-dim"),
    textFaint: v("--text-faint"),
    line: v("--line"),
    bg1: v("--bg-1"),
    grid: "rgba(125,135,150,0.16)",
    tooltipBg: v("--bg-1"),
    tooltipBorder: v("--line"),
    isLight: document.documentElement.getAttribute("data-theme") === "light",
  };
}

function applyChartDefaults() {
  if (typeof Chart === "undefined") return;
  const t = chartTheme();
  Chart.defaults.color = t.textDim;
  Chart.defaults.borderColor = t.line;
  if (Chart.defaults.scale?.grid) Chart.defaults.scale.grid.color = t.grid;
  if (Chart.defaults.plugins?.tooltip) {
    Chart.defaults.plugins.tooltip.backgroundColor = t.tooltipBg;
    Chart.defaults.plugins.tooltip.borderColor = t.tooltipBorder;
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.titleColor = t.text;
    Chart.defaults.plugins.tooltip.bodyColor = t.textDim;
  }
}

function restyleAllCharts() {
  applyChartDefaults();
  if (!state._charts) return;
  const t = chartTheme();
  for (const id in state._charts) {
    const c = state._charts[id];
    if (!c?.options) continue;
    if (c.options.scales) {
      for (const ax of Object.values(c.options.scales)) {
        if (ax.ticks) ax.ticks.color = t.textDim;
        if (ax.grid) ax.grid.color = t.grid;
        if (ax.title) ax.title.color = t.textDim;
      }
    }
    if (c.options.plugins?.legend?.labels) c.options.plugins.legend.labels.color = t.text;
    if (c.options.plugins?.tooltip) {
      c.options.plugins.tooltip.backgroundColor = t.tooltipBg;
      c.options.plugins.tooltip.borderColor = t.tooltipBorder;
    }
    c.update("none");
  }
}

/* ------------------- Render scaffolding ------------------- */
async function withRender(tab, label, fn) {
  if (state.loaded[tab]) return;
  showSkeleton(tab);
  setBusy(label || "Loading…");
  const skeletonStart = performance.now();
  try {
    await fn();
    // Min skeleton dwell so quick fetches don't flash
    const elapsed = performance.now() - skeletonStart;
    if (elapsed < CONFIG.SKELETON_MIN_MS) {
      await new Promise((r) => setTimeout(r, CONFIG.SKELETON_MIN_MS - elapsed));
    }
    state.loaded[tab] = true;
  } catch (err) {
    if (err?.name === "AbortError") return; // user navigated away — silent
    console.error(err);
    panel(tab).innerHTML = `<div class="empty"><strong>Couldn't load ${escapeHtml(tab)}</strong>${escapeHtml(err.message || "")}</div>`;
  } finally {
    clearBusy();
  }
}

/* ------------------- Dialog focus management ------------------- */
const FOCUSABLE_SEL =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function captureFocus() { state._focusTrapPrev = document.activeElement; }
function restoreFocus() {
  const prev = state._focusTrapPrev;
  if (prev && typeof prev.focus === "function" && document.contains(prev)) {
    try { prev.focus(); } catch {}
  }
  state._focusTrapPrev = null;
}
function trapFocus(rootEl, e) {
  if (e.key !== "Tab" || !rootEl) return;
  const items = rootEl.querySelectorAll(FOCUSABLE_SEL);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ------------------- Skeletons ------------------- */
const skeletons = {
  overview: () => `
    <div class="hero skeleton" style="height:120px;animation:none;background:var(--bg-1);border:1px dashed var(--line);"></div>
    <h2 class="section-title">Podium</h2>
    <div class="podium">
      ${"<div class=\"step skeleton\" style=\"height:90px;border:0\"></div>".repeat(3)}
    </div>
    <h2 class="section-title">Insights</h2>
    <div class="insight-grid">
      ${"<div class=\"insight skeleton\" style=\"height:96px;border:0\"></div>".repeat(6)}
    </div>
  `,
  results: () => `
    <h2 class="section-title">Final classification</h2>
    <div class="card tight" style="padding:14px">
      ${"<div class=\"skel-row\"><div class=\"skeleton skel-line\" style=\"width:30px\"></div><div class=\"skeleton skel-line\" style=\"flex:1\"></div></div>".repeat(8)}
    </div>
  `,
  drivers: () => `
    <h2 class="section-title">Entry list</h2>
    <div class="driver-grid">
      ${"<div class=\"driver-card skeleton\" style=\"height:200px;border:0\"></div>".repeat(8)}
    </div>
  `,
  laps: () => `
    <h2 class="section-title">Lap times</h2>
    <div class="laps-controls">
      ${"<span class=\"chip skeleton\" style=\"width:90px;height:24px\"></span>".repeat(10)}
    </div>
    <div class="laps-chart-wrap skeleton" style="border:0"></div>
  `,
  sectors: () => `
    <h2 class="section-title">Sector & speed-trap bests</h2>
    <div class="card tight" style="padding:14px">
      ${"<div class=\"skel-row\"><div class=\"skeleton skel-line\" style=\"flex:1\"></div></div>".repeat(8)}
    </div>
  `,
  trace: () => `
    <h2 class="section-title">Race trace</h2>
    <div class="laps-controls">
      ${"<span class=\"chip skeleton\" style=\"width:80px;height:24px\"></span>".repeat(12)}
    </div>
    <div class="trace-chart-wrap skeleton" style="border:0"></div>
  `,
  standings: () => `
    <h2 class="section-title">Championship standings</h2>
    <div class="standings-grid">
      <div class="standings-card" style="height:560px"><div class="skeleton" style="height:100%;border-radius:0"></div></div>
      <div class="standings-card" style="height:560px"><div class="skeleton" style="height:100%;border-radius:0"></div></div>
    </div>
  `,
  onboard: () => `
    <div class="onboard-controls">
      <div class="skeleton" style="height:54px"></div>
      <div class="skeleton" style="height:54px"></div>
      <div></div>
    </div>
    <div class="onboard-top">
      <div class="track-card skeleton" style="height:420px;border:0"></div>
      <div class="stats-card skeleton" style="height:420px;border:0"></div>
    </div>
    <div class="telemetry-stack">
      <div class="telemetry-block skeleton" style="height:240px;border:0"></div>
      <div class="telemetry-block skeleton" style="height:200px;border:0"></div>
      <div class="telemetry-block skeleton" style="height:200px;border:0"></div>
    </div>
  `,
  compare: () => `
    <div class="compare-controls">
      <div class="skeleton" style="height:54px"></div>
      <div></div>
      <div class="skeleton" style="height:54px"></div>
    </div>
    <div class="compare-grid">
      <div class="compare-card skeleton" style="height:300px;border:0"></div>
      <div class="compare-card skeleton" style="height:300px;border:0"></div>
    </div>
    <div class="compare-laps-wrap skeleton" style="border:0"></div>
  `,
  stints: () => `
    <h2 class="section-title">Tyre stints</h2>
    <div class="card" style="padding:14px">
      ${"<div class=\"skel-row\"><div class=\"skeleton skel-line\" style=\"width:140px\"></div><div class=\"skeleton skel-line\" style=\"flex:1;height:24px\"></div></div>".repeat(10)}
    </div>
  `,
  pits: () => `
    <h2 class="section-title">Pit stops</h2>
    <div class="card tight" style="padding:14px">
      ${"<div class=\"skel-row\"><div class=\"skeleton skel-line\" style=\"flex:1\"></div></div>".repeat(8)}
    </div>
  `,
  overtakes: () => `
    <h2 class="section-title">Overtakes</h2>
    <div class="ot-summary">
      <div class="ot-leader skeleton" style="height:200px;border:0"></div>
      <div class="ot-leader skeleton" style="height:200px;border:0"></div>
      <div class="ot-leader skeleton" style="height:200px;border:0"></div>
    </div>
  `,
  control: () => `
    <h2 class="section-title">Race control</h2>
    ${"<div class=\"rc-row skeleton\" style=\"height:46px;border:0\"></div>".repeat(8)}
  `,
  radio: () => `
    <h2 class="section-title">Team radio</h2>
    <div class="radio-filter">
      ${"<span class=\"chip skeleton\" style=\"width:80px;height:22px\"></span>".repeat(8)}
    </div>
    ${"<div class=\"radio-row skeleton\" style=\"height:60px;border:0\"></div>".repeat(6)}
  `,
  weather: () => `
    <h2 class="section-title">Weather</h2>
    <div class="weather-grid">
      ${"<div class=\"card skeleton\" style=\"height:90px;border:0\"></div>".repeat(4)}
    </div>
    <div class="wx-chart-wrap skeleton" style="border:0;margin-bottom:14px"></div>
    <div class="wx-chart-wrap skeleton" style="border:0"></div>
  `,
};

function showSkeleton(tab) {
  const fn = skeletons[tab];
  if (fn) panel(tab).innerHTML = fn();
}

/* ------------------- Picker init ------------------- */
function populateYearSelect() {
  const sel = $("#year-select");
  sel.innerHTML = YEARS.map((y) => `<option value="${y}">${y}</option>`).join("");
}

async function loadMeetings(year) {
  setBusy("Loading meetings…");
  try {
    const meetings = await api("meetings", { year });
    meetings.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    state.meetings = meetings;
    const sel = $("#meeting-select");
    sel.innerHTML = meetings.length
      ? meetings.map((m) => `<option value="${m.meeting_key}">${m.country_name} — ${m.meeting_name}${m.is_cancelled ? " (cancelled)" : ""}</option>`).join("")
      : `<option value="">(no meetings)</option>`;
    return meetings;
  } finally {
    clearBusy();
  }
}

async function loadSessions(meetingKey) {
  setBusy("Loading sessions…");
  try {
    const sessions = await api("sessions", { meeting_key: meetingKey });
    sessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    state.sessions = sessions;
    const sel = $("#session-select");
    sel.innerHTML = sessions.length
      ? sessions.map((s) => `<option value="${s.session_key}">${s.session_name}${s.is_cancelled ? " (cancelled)" : ""}</option>`).join("")
      : `<option value="">(no sessions)</option>`;
    return sessions;
  } finally {
    clearBusy();
  }
}

async function loadDrivers(sessionKey) {
  setBusy("Loading drivers…");
  try {
    const drivers = await api("drivers", { session_key: sessionKey });
    drivers.sort((a, b) => a.driver_number - b.driver_number);
    state.drivers = drivers;
    state.driversByNum = Object.fromEntries(drivers.map((d) => [d.driver_number, d]));
    return drivers;
  } finally {
    clearBusy();
  }
}

function pickDefaultMeeting(meetings) {
  const now = Date.now();
  const past = meetings.filter((m) => !m.is_cancelled && new Date(m.date_end).getTime() <= now);
  if (past.length) return past[past.length - 1];
  const upcoming = meetings.filter((m) => !m.is_cancelled);
  return upcoming.length ? upcoming[upcoming.length - 1] : (meetings[meetings.length - 1] || null);
}

function pickDefaultSession(sessions) {
  const now = Date.now();
  const past = sessions.filter((s) => !s.is_cancelled && new Date(s.date_end).getTime() <= now);
  if (past.length) return past[past.length - 1];
  const noncancelled = sessions.filter((s) => !s.is_cancelled);
  return noncancelled.length ? noncancelled[noncancelled.length - 1] : (sessions[sessions.length - 1] || null);
}

/* ------------------- Topstrip + tab ------------------- */
function updateTopstrip() {
  const m = state.meeting;
  const s = state.session;
  const el = document.getElementById("topstrip-title");
  if (!m || !s) { el.innerHTML = ""; return; }
  const flag = m.country_flag ? `<img class="topstrip-flag" src="${m.country_flag}" alt="${m.country_name || ""}" />` : "";
  const sessionType = (s.session_name || "").toUpperCase();
  const status = sessionStatus(s);
  const statusBadge = {
    upcoming: `<span class="topstrip-status upcoming"><span class="dot"></span>UPCOMING · in <span data-countdown-to="${s.date_start}">${fmt.countdown(s.date_start)}</span></span>`,
    live: `<span class="topstrip-status live"><span class="dot pulse"></span>LIVE</span>`,
    cancelled: `<span class="topstrip-status cancelled">CANCELLED</span>`,
    completed: "",
    unknown: "",
  }[status];
  el.innerHTML = `
    ${flag}
    <span class="topstrip-name">${m.meeting_name}</span>
    <span class="topstrip-pill ${status}">${sessionType}</span>
    ${statusBadge}
    <span class="topstrip-date">${fmt.dateLong(s.date_start)}</span>
  `;
}

function switchTab(tab, opts = {}) {
  state.activeTab = tab;
  document.querySelectorAll(".navlist button").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${tab}`);
  });
  updateTopstrip();
  if (!opts.skipUrl) writeHash();
  closeDrawer();
  renderTab(tab);
}

async function renderTab(tab) {
  if (!state.sessionKey && tab !== "overview") return;

  // Future / cancelled sessions: short-circuit data-driven tabs with friendly state.
  // Overview, Drivers (entry list), and Standings (year-scoped) still render —
  // Overview shows the upcoming UI, Drivers is often available before lights-out,
  // and Standings depends on the year, not the selected session.
  const status = sessionStatus();
  if ((status === "upcoming" || status === "cancelled") &&
      tab !== "overview" && tab !== "drivers" && tab !== "standings") {
    panel(tab).innerHTML = futureTabEmpty(status, TAB_META[tab]?.label || tab);
    state.loaded[tab] = false; // re-render once status changes
    return;
  }

  const renderers = {
    overview: renderOverview,
    results: renderResults,
    drivers: renderDrivers,
    laps: renderLaps,
    sectors: renderSectors,
    trace: renderRaceTrace,
    standings: renderStandings,
    onboard: renderOnboard,
    compare: renderCompare,
    stints: renderStints,
    pits: renderPits,
    overtakes: renderOvertakes,
    control: renderRaceControl,
    radio: renderRadio,
    weather: renderWeather,
  };
  const fn = renderers[tab];
  if (!fn) return;

  // Re-entrancy guard: if the same tab is already rendering, skip.
  if (state._renderingTab === tab) return;
  state._renderingTab = tab;

  const showedSkeleton = !state.loaded[tab];
  if (showedSkeleton) showSkeleton(tab);
  const skeletonStart = performance.now();
  try {
    await fn();
    if (showedSkeleton) {
      const elapsed = performance.now() - skeletonStart;
      if (elapsed < CONFIG.SKELETON_MIN_MS) {
        await new Promise((r) => setTimeout(r, CONFIG.SKELETON_MIN_MS - elapsed));
      }
    }
    state.loaded[tab] = true; // transactional: only set on full success
    // Apply current theme to any newly-created charts (no-op for non-chart tabs).
    if (document.documentElement.getAttribute("data-theme") === "light") restyleAllCharts();
  } catch (err) {
    if (err?.name === "AbortError") return; // user navigated — silent
    console.error(err);
    panel(tab).innerHTML = `<div class="empty"><strong>Couldn't load ${escapeHtml(TAB_META[tab]?.label || tab)}</strong>${escapeHtml(err.message || "")}</div>`;
  } finally {
    if (state._renderingTab === tab) state._renderingTab = null;
  }
}

function futureTabEmpty(status, label) {
  const s = state.session;
  if (status === "cancelled") {
    return `
      <div class="empty cancelled">
        <strong>${label} unavailable</strong>
        <div>${s?.session_name ? `${s.session_name} was cancelled` : "This session was cancelled"} — no data is recorded.</div>
      </div>
    `;
  }
  // upcoming
  return `
    <div class="empty upcoming">
      <strong>${label} not yet available</strong>
      <div>${s?.session_name || "This session"} is scheduled for ${fmt.dateLong(s?.date_start)} at ${fmt.time(s?.date_start)}.<br/>Live data will appear once the session starts.</div>
      <div class="countdown">Starts in <span data-countdown-to="${s?.date_start || ""}" style="margin-left:8px">${fmt.countdown(s?.date_start)}</span></div>
    </div>
  `;
}

function invalidateLoaded() {
  state.loaded = {};
  state._onboard = null;
  state._compare = null;
  // Abort any in-flight Onboard fetches; they'd render against stale UI.
  if (state._onboardAbort) {
    try { state._onboardAbort.abort(); } catch {}
    state._onboardAbort = null;
  }
  // Destroy every chart instance regardless of id.
  if (state._charts) {
    for (const id of Object.keys(state._charts)) {
      try { state._charts[id]?.destroy(); } catch {}
      delete state._charts[id];
    }
  }
}

/* ------------------- Overview (with insights) ------------------- */
async function renderOverview() {
  const p = panel("overview");
  if (state.loaded.overview) return;

  const m = state.meeting;
  const s = state.session;
  if (!m || !s) {
    p.innerHTML = `<div class="empty"><strong>No session selected</strong></div>`;
    return;
  }

  const status = sessionStatus(s);
  if (status === "upcoming" || status === "cancelled") {
    return renderUpcomingOverview(p, m, s, status);
  }

  setBusy("Loading positions…");
  let positions = [];
  try { positions = await api("position", { session_key: s.session_key }); } catch {}
  clearBusy();

  const finalByDriver = {};
  for (const r of positions) finalByDriver[r.driver_number] = r;
  const ranked = Object.values(finalByDriver)
    .map((r) => ({ ...r, driver: state.driversByNum[r.driver_number] }))
    .filter((r) => r.driver)
    .sort((a, b) => a.position - b.position);
  const podium = ranked.slice(0, 3);

  // Compute insights in parallel
  const insights = await computeInsights();

  const flagUrl = m.country_flag || "";
  const circuitUrl = m.circuit_image || "";

  p.innerHTML = `
    <section class="hero">
      <div>
        <h1>${flagUrl ? `<img class="flag" src="${flagUrl}" alt=""/>` : ""}${m.meeting_name}</h1>
        <div class="sub">${escapeHtml(meetingSubtitle(m, s))}</div>
        <div class="meta">
          <span>Date <strong>${fmt.dateLong(s.date_start)}</strong></span>
          <span>Start <strong>${fmt.time(s.date_start)}</strong></span>
          <span>End <strong>${fmt.time(s.date_end)}</strong></span>
          ${s.session_type ? `<span>Type <strong>${s.session_type}</strong></span>` : ""}
        </div>
      </div>
      <div id="hero-track-slot">${circuitUrl ? `<img class="circuit" src="${circuitUrl}" alt="circuit map" onerror="this.remove()"/>` : ""}</div>
    </section>

    ${podium.length ? `
      <h2 class="section-title">Podium</h2>
      <div class="podium">
        ${podium.map((r, i) => podiumStep(r, i + 1)).join("")}
      </div>
    ` : ""}

    <h2 class="section-title">At a glance</h2>
    <div class="insight-grid">
      ${insights.map(insightCard).join("")}
    </div>
  `;

  animateCounters(p);
  state.loaded.overview = true;

  // Upgrade hero track (replace stylized PNG with a canvas drawn from real location data)
  upgradeHeroTrack().catch(() => {});
}

async function renderUpcomingOverview(p, m, s, status) {
  const isCancelled = status === "cancelled";
  const flagUrl = m.country_flag || "";
  const circuitUrl = m.circuit_image || "";
  const startMs = new Date(s.date_start).getTime();

  const ms = startMs - Date.now();
  const dd = Math.max(0, Math.floor(ms / 86400000));
  const hh = Math.max(0, Math.floor((ms % 86400000) / 3600000));
  const mm = Math.max(0, Math.floor((ms % 3600000) / 60000));
  const ss = Math.max(0, Math.floor((ms % 60000) / 1000));

  const cdBox = (label, val, dataUnit) => `
    <div class="cd-box">
      <span class="v" data-cd-unit="${dataUnit}">${val}</span>
      <span class="l">${label}</span>
    </div>
  `;

  const sessions = state.sessions || [];
  const scheduleHtml = sessions.length ? `
    <h2 class="section-title">Weekend schedule</h2>
    <div class="schedule-list">
      ${sessions.map((sx) => {
        const st = sessionStatus(sx);
        const isCurrent = sx.session_key === s.session_key;
        const badge = st === "live" ? "LIVE"
          : st === "upcoming" ? "UPCOMING"
          : st === "cancelled" ? "CANCELLED"
          : "DONE";
        const when = `${fmt.dateLong(sx.date_start)} · ${fmt.time(sx.date_start)}`;
        const switchAttrs = sx.session_key !== s.session_key
          ? `data-jump-session="${sx.session_key}" role="button" tabindex="0" style="cursor:pointer"`
          : `aria-current="true"`;
        return `
          <div class="schedule-row" data-status="${st}" ${switchAttrs} title="${isCurrent ? "Currently selected" : "Click to switch"}">
            <span class="dot"></span>
            <div>
              <div class="name">${escapeHtml(sx.session_name)}${isCurrent ? " · selected" : ""}</div>
              <div class="when" style="color:var(--text-faint);font-size:11px">${escapeHtml(sx.session_type || "")}</div>
            </div>
            <span class="when">${when}</span>
            <span class="badge">${badge}</span>
          </div>
        `;
      }).join("")}
    </div>
  ` : "";

  p.innerHTML = `
    <section class="upcoming-hero">
      <div>
        <h1>${flagUrl ? `<img class="flag" src="${flagUrl}" alt=""/>` : ""}${m.meeting_name}</h1>
        <div class="sub">${escapeHtml(meetingSubtitle(m, s, isCancelled ? " · cancelled" : ""))}</div>
        ${isCancelled ? `
          <div class="meta" style="margin-top:14px">
            <span style="color:var(--red);font-weight:700">This session has been cancelled. No data will be recorded.</span>
          </div>
        ` : `
          <div class="upcoming-countdown">
            ${cdBox("days", dd, "d")}
            ${cdBox("hours", hh, "h")}
            ${cdBox("minutes", mm, "m")}
            ${cdBox("seconds", ss, "s")}
          </div>
          <div class="meta" style="margin-top:14px">
            <span>Starts <strong data-countdown-to="${s.date_start}">${fmt.countdown(s.date_start)}</strong></span>
            <span>Local <strong>${fmt.time(s.date_start)}</strong></span>
            <span>Date <strong>${fmt.dateLong(s.date_start)}</strong></span>
            ${s.session_type ? `<span>Type <strong>${s.session_type}</strong></span>` : ""}
          </div>
        `}
      </div>
      <div id="hero-track-slot">${circuitUrl ? `<img class="circuit" src="${circuitUrl}" alt="circuit map" onerror="this.remove()"/>` : ""}</div>
    </section>

    ${scheduleHtml}

    ${!isCancelled ? `
      <h2 class="section-title" style="margin-top:18px">What you'll see here</h2>
      <div class="insight-grid">
        ${[
          { label: "Final classification", v: "Pos · Gap · Best lap", ctx: "Once the chequered flag falls" },
          { label: "Live tyre stints", v: "Per driver", ctx: "Compound + lap range timeline" },
          { label: "Onboard telemetry", v: "Speed · Throttle · Brake", ctx: "Track map with racing line" },
          { label: "Race control", v: "Flags · Penalties", ctx: "FIA messages live" },
          { label: "Team radio", v: "Driver ↔ pit", ctx: "Filterable + playable clips" },
          { label: "Weather", v: "Air · Track · Wind", ctx: "Time series during the session" },
        ].map(insightCard).join("")}
      </div>
    ` : ""}
  `;

  state.loaded.overview = true;

  // Replace the stylized PNG with a real outline drawn from a previous race at this circuit.
  upgradeHeroTrack().catch(() => {});
}

/**
 * Find a usable fast lap for a session: fastest non-pit-out lap with start time + duration.
 * Returns { sessionKey, lap } or null.
 */
async function findUsableLap(sessionKey) {
  const laps = await api("laps", { session_key: sessionKey }).catch(() => []);
  const candidates = laps.filter((l) =>
    l.lap_duration != null && l.date_start != null && !l.is_pit_out_lap
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.lap_duration - b.lap_duration);
  return { sessionKey, lap: candidates[0] };
}

/**
 * For a meeting that has no lap data yet (upcoming/cancelled or session still in flight),
 * find the most recent COMPLETED race at the same circuit in a previous year so we can
 * reuse its GPS data to render an accurate outline.
 */
async function findHistoricalRaceLap(meeting) {
  if (!meeting) return null;
  const cYear = meeting.year;
  for (let y = cYear - 1; y >= Math.max(cYear - 4, 2018); y--) {
    const yearMeetings = await api("meetings", { year: y }).catch(() => []);
    if (!Array.isArray(yearMeetings) || !yearMeetings.length) continue;
    // Multiple meetings may share a circuit (e.g. Pre-Season Testing + Grand Prix at Sakhir);
    // walk all of them and pick the first that has a usable Race session.
    const sameCircuitMeetings = yearMeetings.filter((m) =>
      !m.is_cancelled &&
      (m.circuit_key === meeting.circuit_key ||
        (m.circuit_short_name && m.circuit_short_name === meeting.circuit_short_name))
    );
    for (const sameCircuit of sameCircuitMeetings) {
      const sessions = await api("sessions", { meeting_key: sameCircuit.meeting_key }).catch(() => []);
      const race = sessions.find((s) =>
        s.session_name === "Race" && !s.is_cancelled &&
        new Date(s.date_end).getTime() < Date.now()
      );
      if (!race) continue;
      const result = await findUsableLap(race.session_key);
      if (result) return result;
    }
  }
  return null;
}

async function upgradeHeroTrack() {
  const slot = document.getElementById("hero-track-slot");
  if (!slot) return;

  // 1) Try the current session
  let result = await findUsableLap(state.sessionKey);
  // 2) Fall back to a previous race at the same circuit (handles upcoming + cancelled + new circuits)
  if (!result) result = await findHistoricalRaceLap(state.meeting);
  if (!result) {
    // No GPS data found for this circuit (new venue) — clear the F1 stylized PNG so the hero
    // doesn't show a misleading thick outline. The header text alone communicates the circuit.
    slot.innerHTML = "";
    return;
  }

  const { sessionKey, lap } = result;
  const startMs = new Date(lap.date_start).getTime();
  const endMs = startMs + lap.lap_duration * 1000;
  const trim = CONFIG.TELEMETRY_TRIM_MS;
  const startStr = new Date(startMs + trim).toISOString();
  const endStr = new Date(endMs - trim).toISOString();

  let location = [];
  try {
    location = await api("location", {
      session_key: sessionKey,
      driver_number: lap.driver_number,
      "date>": startStr,
      "date<": endStr,
    });
  } catch { return; }
  location = location.filter((p) => !(p.x === 0 && p.y === 0) && p.x != null && p.y != null);
  if (location.length < 30) return;
  location.sort((a, b) => new Date(a.date) - new Date(b.date));
  location = cleanLocationPath(location);
  if (location.length < 30) return;

  slot.innerHTML = `<canvas class="hero-track" id="hero-track-canvas"></canvas>`;
  const canvas = document.getElementById("hero-track-canvas");
  drawHeroTrack(canvas, location);
}

/** Build a deduped subtitle for the hero: location · circuit · session — collapsed when location == circuit. */
function meetingSubtitle(m, s, suffix = "") {
  const parts = [];
  const place = m.location || m.country_name;
  if (place) parts.push(place);
  if (m.circuit_short_name && m.circuit_short_name !== place) parts.push(m.circuit_short_name);
  if (s?.session_name) parts.push(s.session_name);
  return parts.join(" · ") + suffix;
}

// Drop outlier samples (GPS noise spikes) by comparing inter-sample distance to median.
function cleanLocationPath(points) {
  if (points.length < 4) return points;
  const dists = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    dists.push(Math.hypot(dx, dy));
  }
  const sorted = dists.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const limit = median * 6;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - out[out.length - 1].x;
    const dy = points[i].y - out[out.length - 1].y;
    if (Math.hypot(dx, dy) <= limit) out.push(points[i]);
  }
  return out;
}

function drawHeroTrack(canvas, locations) {
  if (!canvas || !locations.length) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  canvas.width = Math.floor(cw * dpr);
  canvas.height = Math.floor(ch * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const xs = locations.map((p) => p.x);
  const ys = locations.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = maxX - minX || 1, bh = maxY - minY || 1;
  const pad = 8;
  const sx = (cw - 2 * pad) / bw;
  const sy = (ch - 2 * pad) / bh;
  const s = Math.min(sx, sy);
  const ox = (cw - bw * s) / 2 - minX * s;
  const oy = (ch - bh * s) / 2 - minY * s;

  const tracePath = () => {
    ctx.beginPath();
    for (let i = 0; i < locations.length; i++) {
      const p = locations[i];
      const x = p.x * s + ox;
      const y = ch - (p.y * s + oy);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); // bridge the small gap from last sample back to S/F
  };

  // Outer glow stroke
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(225, 6, 0, 0.18)";
  tracePath();
  ctx.stroke();

  // Solid stroke (uses theme text color)
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = isLight ? "rgba(15, 23, 42, 0.85)" : "rgba(255, 255, 255, 0.9)";
  tracePath();
  ctx.stroke();

  // Start dot (the white S/F marker)
  const sp = locations[0];
  const sx0 = sp.x * s + ox;
  const sy0 = ch - (sp.y * s + oy);
  ctx.fillStyle = "var(--red)";
  ctx.fillStyle = "#e10600";
  ctx.beginPath();
  ctx.arc(sx0, sy0, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = isLight ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function podiumStep(r, n) {
  const d = r.driver;
  const tc = teamColor(d);
  return `
    <div class="step p${n}" style="--team:${tc}" data-driver="${d.driver_number}">
      <div class="pos">P${n}</div>
      <img src="${d.headshot_url || ""}" alt="" data-initials="${d.name_acronym || ""}" data-bg="${tc}" />
      <div>
        <div class="name">${d.full_name || d.broadcast_name}</div>
        <div class="team">${d.team_name || ""}</div>
      </div>
    </div>
  `;
}

function insightCard(c) {
  return `
    <div class="insight" style="--insight:${c.color || "var(--red)"};${c.team ? `--team:${c.team};` : ""}">
      <div class="label">${c.label}</div>
      <div class="v">${c.v ?? "—"}${c.unit ? `<span class="u">${c.unit}</span>` : ""}</div>
      ${c.who ? `<div class="who">${c.who}</div>` : ""}
      ${c.ctx ? `<div class="ctx">${c.ctx}</div>` : ""}
    </div>
  `;
}

async function computeInsights() {
  const sk = state.sessionKey;
  const out = [];

  // Drivers / teams count
  out.push({
    label: "Cars on track",
    v: `<span data-count-to="${state.drivers.length}" data-count-duration="500">0</span>`,
    ctx: `${new Set(state.drivers.map((d) => d.team_name)).size} teams`,
    color: "var(--blue)",
  });

  // Fastest pit + fastest lap from existing endpoints (parallel fetches; cached)
  let pits = [], laps = [], overtakes = [], weather = [];
  await Promise.all([
    api("pit", { session_key: sk }).then((r) => { pits = r; }).catch(() => {}),
    api("laps", { session_key: sk }).then((r) => { laps = r; }).catch(() => {}),
    api("overtakes", { session_key: sk }).then((r) => { overtakes = r; }).catch(() => {}),
    api("weather", { session_key: sk }).then((r) => { weather = r; }).catch(() => {}),
  ]);

  if (laps && laps.length) {
    let best = { lap_duration: Infinity };
    for (const l of laps) if (l.lap_duration != null && l.lap_duration < best.lap_duration) best = l;
    if (isFinite(best.lap_duration)) {
      const d = state.driversByNum[best.driver_number];
      const tc = teamColor(d);
      out.push({
        label: "Fastest lap",
        v: fmt.duration(best.lap_duration),
        who: d ? `<span class="num-badge" style="--team:${tc}" data-driver="${best.driver_number}">${best.driver_number}</span><strong>${d.name_acronym || ""}</strong> · ${d.team_name || ""}` : "",
        ctx: `Lap ${best.lap_number || "?"}`,
        color: tc,
        team: tc,
      });
    }
  }

  if (pits && pits.length) {
    let fastest = null;
    for (const p of pits) if (p.pit_duration != null && (!fastest || p.pit_duration < fastest.pit_duration)) fastest = p;
    if (fastest) {
      const d = state.driversByNum[fastest.driver_number];
      const tc = teamColor(d);
      out.push({
        label: "Fastest pit stop",
        v: `<span data-count-to="${fastest.pit_duration}" data-count-decimals="2">0</span>`,
        unit: " s",
        who: d ? `<span class="num-badge" style="--team:${tc}" data-driver="${fastest.driver_number}">${fastest.driver_number}</span><strong>${d.name_acronym || ""}</strong>` : "",
        ctx: `Lap ${fastest.lap_number ?? "?"} · ${pits.length} stops total`,
        color: "var(--accent)",
        team: tc,
      });
    }
  }

  if (overtakes && overtakes.length) {
    const made = {};
    for (const ot of overtakes) made[ot.overtaking_driver_number] = (made[ot.overtaking_driver_number] || 0) + 1;
    const top = Object.entries(made).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const d = state.driversByNum[+top[0]];
      const tc = teamColor(d);
      out.push({
        label: "Most overtakes",
        v: `<span data-count-to="${top[1]}" data-count-duration="700">0</span>`,
        unit: " moves",
        who: d ? `<span class="num-badge" style="--team:${tc}" data-driver="${d.driver_number}">${d.driver_number}</span><strong>${d.name_acronym || ""}</strong>` : "",
        ctx: `${overtakes.length} overtakes total`,
        color: tc,
        team: tc,
      });
    }
  }

  if (weather && weather.length) {
    const t = weather.map((w) => w.track_temperature).filter((v) => v != null);
    if (t.length) {
      const peak = Math.max(...t).toFixed(1);
      const low = Math.min(...t).toFixed(1);
      out.push({
        label: "Track temp",
        v: `<span data-count-to="${peak}" data-count-decimals="1">0</span>`,
        unit: " °C peak",
        ctx: `swung ${low} → ${peak} °C`,
        color: "var(--red)",
      });
    }
    const rainAny = weather.some((w) => w.rainfall && w.rainfall > 0);
    if (rainAny) {
      out.push({
        label: "Conditions",
        v: "Wet",
        ctx: "Rainfall recorded during session",
        color: "var(--blue)",
      });
    }
  }

  // Biggest grid jumper: starting_grid → session_result delta (Race / Sprint only)
  let usedGridDelta = false;
  try {
    const isRaceLike = state.session?.session_name === "Race" || state.session?.session_name === "Sprint";
    const gridSession = isRaceLike ? findGridSession(state.session, state.sessions) : null;
    if (gridSession) {
      const [grid, results] = await Promise.all([
        api("starting_grid", { session_key: gridSession.session_key }).catch(() => []),
        api("session_result", { session_key: sk }).catch(() => []),
      ]);
      if (grid.length && results.length) {
        const gridByDriver = {};
        for (const g of grid) gridByDriver[g.driver_number] = g.position;
        let best = { gain: -Infinity };
        for (const r of results) {
          if (r.dnf || r.dns || r.dsq || r.position == null) continue;
          const gp = gridByDriver[r.driver_number];
          if (gp == null) continue;
          const gain = gp - r.position;
          if (gain > best.gain) best = { gain, num: r.driver_number, from: gp, to: r.position };
        }
        if (best.gain > 0) {
          const d = state.driversByNum[best.num];
          const tc = teamColor(d);
          out.push({
            label: "Biggest grid jumper",
            v: `<span data-count-to="${best.gain}">0</span>`,
            unit: " places",
            who: d ? `<span class="num-badge" style="--team:${tc}" data-driver="${best.num}">${best.num}</span><strong>${d.name_acronym || ""}</strong>` : "",
            ctx: `P${best.from} → P${best.to}`,
            color: "var(--green)",
            team: tc,
          });
          usedGridDelta = true;
        }
      }
    }
  } catch {}

  // Fallback: comeback from position time-series (when grid data isn't available)
  if (!usedGridDelta) {
    try {
      const positions = await api("position", { session_key: sk });
      const byDriver = {};
      for (const r of positions) {
        const d = (byDriver[r.driver_number] ||= { first: r, last: r });
        d.last = r;
      }
      let bestGain = { gain: -Infinity };
      for (const num in byDriver) {
        const d = byDriver[num];
        const gain = d.first.position - d.last.position;
        if (gain > bestGain.gain) bestGain = { gain, num: +num };
      }
      if (bestGain.gain > 0) {
        const d = state.driversByNum[bestGain.num];
        const tc = teamColor(d);
        out.push({
          label: "Biggest gain",
          v: `<span data-count-to="${bestGain.gain}">0</span>`,
          unit: " positions",
          who: d ? `<span class="num-badge" style="--team:${tc}" data-driver="${bestGain.num}">${bestGain.num}</span><strong>${d.name_acronym || ""}</strong>` : "",
          ctx: "from start to finish",
          color: "var(--green)",
          team: tc,
        });
      }
    } catch {}
  }

  return out;
}

/* ------------------- Results ------------------- */
function findGridSession(currentSession, allSessions) {
  if (!currentSession || !allSessions) return null;
  const name = currentSession.session_name;
  if (name === "Race") return allSessions.find((s) => s.session_name === "Qualifying") || null;
  if (name === "Sprint") {
    return allSessions.find((s) =>
      s.session_name === "Sprint Qualifying" || s.session_name === "Sprint Shootout"
    ) || null;
  }
  return null;
}

async function renderResults() {
  const p = panel("results");
  if (state.loaded.results) return;

  setBusy("Loading classification…");
  let results = [], laps = [], grid = [], intervals = [];
  try {
    [results, laps, intervals] = await Promise.all([
      api("session_result", { session_key: state.sessionKey }).catch(() => []),
      api("laps", { session_key: state.sessionKey }).catch(() => []),
      api("intervals", { session_key: state.sessionKey }).catch(() => []),
    ]);
    const gridSession = findGridSession(state.session, state.sessions);
    if (gridSession) {
      try { grid = await api("starting_grid", { session_key: gridSession.session_key }); }
      catch {}
    }
  } catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load results</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  // Fallback: if session_result has nothing, derive from position+intervals (older behavior)
  if (!results.length) {
    let positions = [];
    try { positions = await api("position", { session_key: state.sessionKey }); } catch {}
    if (!positions.length) {
      p.innerHTML = `<div class="empty"><strong>No results yet</strong>This session may not have started, or position data isn't available.</div>`;
      state.loaded.results = true;
      return;
    }
    const finalPos = {};
    for (const r of positions) finalPos[r.driver_number] = r;
    const finalInt = {};
    for (const r of intervals) finalInt[r.driver_number] = r;
    results = Object.values(finalPos).map((r) => ({
      position: r.position,
      driver_number: r.driver_number,
      gap_to_leader: finalInt[r.driver_number]?.gap_to_leader ?? null,
      _interval: finalInt[r.driver_number]?.interval ?? null,
      points: null, dnf: false, dns: false, dsq: false, number_of_laps: null,
    }));
  } else {
    // Augment session_result with interval for next-driver gaps in the live view
    const finalInt = {};
    for (const r of intervals) finalInt[r.driver_number] = r;
    for (const r of results) r._interval = finalInt[r.driver_number]?.interval ?? null;
  }

  // Sort: numeric positions first, then DNF/DSQ/DNS last
  results.sort((a, b) => {
    const aOut = a.dnf || a.dsq || a.dns;
    const bOut = b.dnf || b.dsq || b.dns;
    if (aOut !== bOut) return aOut ? 1 : -1;
    return (a.position || 99) - (b.position || 99);
  });

  // Best lap per driver from laps endpoint
  const fastestLapByDriver = {};
  let fastestOverall = { lap_duration: Infinity, driver_number: null };
  for (const lap of laps) {
    if (lap.lap_duration == null) continue;
    const cur = fastestLapByDriver[lap.driver_number];
    if (!cur || lap.lap_duration < cur.lap_duration) fastestLapByDriver[lap.driver_number] = lap;
    if (lap.lap_duration < fastestOverall.lap_duration) fastestOverall = lap;
  }

  // Grid position by driver
  const gridByDriver = {};
  for (const g of grid) gridByDriver[g.driver_number] = g.position;
  const hasGrid = Object.keys(gridByDriver).length > 0;
  const isRaceLike = state.session?.session_name === "Race" || state.session?.session_name === "Sprint";
  const showPoints = results.some((r) => r.points != null && r.points > 0);

  const visible = results.filter((r) => state.driversByNum[r.driver_number]);

  if (!visible.length) {
    p.innerHTML = `<div class="empty"><strong>No classification yet</strong>This session has no result data.</div>`;
    state.loaded.results = true;
    return;
  }

  const colCount = 4 + (hasGrid && isRaceLike ? 2 : 0) + 1 + 1 + 1 + (showPoints ? 1 : 0);

  p.innerHTML = `
    <h2 class="section-title">Final classification</h2>
    <div class="card tight" style="padding:0;overflow:auto">
      <table class="f1">
        <thead>
          <tr>
            <th class="num">Pos</th>
            <th>Driver</th>
            <th>Team</th>
            ${hasGrid && isRaceLike ? `<th class="num">Grid</th><th class="num">Δ</th>` : ""}
            <th class="num">Laps</th>
            <th class="num">Best Lap</th>
            <th class="num">Gap</th>
            ${showPoints ? `<th class="num">Pts</th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${visible.map((r) => {
            const d = state.driversByNum[r.driver_number];
            const tc = teamColor(d);
            const isFastest = fastestOverall.driver_number === r.driver_number && fastestLapByDriver[r.driver_number];
            const best = fastestLapByDriver[r.driver_number]?.lap_duration ?? null;
            const status = r.dnf ? "DNF" : r.dsq ? "DSQ" : r.dns ? "DNS" : null;
            const posCell = status
              ? `<span class="result-status status-${status}">${status}</span>`
              : `<span class="pos">${r.position ?? "—"}</span>`;
            const gridPos = gridByDriver[r.driver_number];
            const delta = (gridPos != null && r.position != null && !status) ? gridPos - r.position : null;
            const deltaCell = delta == null ? "—"
              : delta === 0 ? `<span style="color:var(--text-faint)">0</span>`
              : delta > 0 ? `<span style="color:var(--green);font-weight:700">+${delta}</span>`
              : `<span style="color:var(--red);font-weight:700">${delta}</span>`;
            const gap = r.gap_to_leader;
            const gapCell = (status || r.position === 1) ? "—" : fmt.gapValue(gap);
            return `
              <tr style="--team:${tc}" data-driver="${r.driver_number}" ${status ? `class="row-${status}"` : ""}>
                <td class="num">${posCell}</td>
                <td>
                  <div class="driver-cell">
                    <span class="num-badge">${r.driver_number}</span>
                    <div>
                      <div class="acr">${d.name_acronym || ""}</div>
                      <div class="full">${d.full_name || d.broadcast_name}</div>
                    </div>
                  </div>
                </td>
                <td><span class="team-bar"></span>${d.team_name || ""}</td>
                ${hasGrid && isRaceLike ? `
                  <td class="num">${gridPos != null ? gridPos : "—"}</td>
                  <td class="num">${deltaCell}</td>
                ` : ""}
                <td class="num">${r.number_of_laps ?? (laps.filter(l=>l.driver_number===r.driver_number).reduce((m,l)=>Math.max(m, l.lap_number||0), 0) || "—")}</td>
                <td class="num ${isFastest ? "fast-pit" : ""}">${best != null ? fmt.duration(best) : "—"}</td>
                <td class="num">${gapCell}</td>
                ${showPoints ? `<td class="num"><strong style="color:${(r.points||0)>0?"var(--accent)":"var(--text-faint)"}">${r.points != null ? r.points : "—"}</strong></td>` : ""}
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
  state.loaded.results = true;
}

/* ------------------- Drivers ------------------- */
async function renderDrivers() {
  const p = panel("drivers");
  if (state.loaded.drivers) return;
  if (!state.drivers.length) {
    p.innerHTML = `<div class="empty"><strong>No drivers</strong></div>`;
    return;
  }
  p.innerHTML = `
    <h2 class="section-title">Entry list (${state.drivers.length})</h2>
    <div class="driver-grid">
      ${state.drivers.map((d) => {
        const tc = teamColor(d);
        return `
          <div class="driver-card" style="--team:${tc}" data-driver="${d.driver_number}" tabindex="0" role="button" aria-label="Open ${d.full_name || d.name_acronym} details">
            <div class="num">${d.driver_number}</div>
            <img src="${d.headshot_url || ""}" alt="" data-initials="${d.name_acronym || ""}" data-bg="${tc}" />
            <div class="name">${d.full_name || d.broadcast_name}</div>
            <div class="team">${d.team_name || ""}</div>
            <div class="acr">${d.name_acronym || ""}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  state.loaded.drivers = true;
}

/* ------------------- Lap times ------------------- */
async function renderLaps() {
  const p = panel("laps");
  if (state.loaded.laps) return;

  setBusy("Loading laps…");
  let laps = [];
  try { laps = await api("laps", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load laps</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  const valid = laps.filter((l) => l.lap_duration != null && l.lap_number != null);
  if (!valid.length) {
    p.innerHTML = `<div class="empty"><strong>No lap data</strong></div>`;
    state.loaded.laps = true;
    return;
  }

  const byDriver = {};
  for (const l of valid) (byDriver[l.driver_number] ||= []).push(l);
  for (const d in byDriver) byDriver[d].sort((a, b) => a.lap_number - b.lap_number);

  const driverList = Object.entries(byDriver).map(([num, lapsArr]) => {
    const best = Math.min(...lapsArr.map((l) => l.lap_duration));
    return { num: +num, best, laps: lapsArr };
  }).sort((a, b) => a.best - b.best);

  const initiallyOn = new Set(driverList.slice(0, 5).map((d) => d.num));

  p.innerHTML = `
    <h2 class="section-title">Lap times</h2>
    <div class="laps-controls" id="laps-chips"></div>
    <div class="laps-chart-wrap"><canvas id="laps-chart"></canvas></div>
  `;

  const chipsEl = document.getElementById("laps-chips");
  chipsEl.innerHTML = driverList.map((dx) => {
    const d = state.driversByNum[dx.num];
    const tc = teamColor(d);
    const on = initiallyOn.has(dx.num);
    return `
      <span class="chip ${on ? "active" : ""}" data-num="${dx.num}" style="--team:${tc}">
        <span class="dot" style="background:${tc}"></span>
        <span data-driver="${dx.num}">${d?.name_acronym || dx.num}</span>
        <span style="color:var(--text-faint);font-weight:600">${fmt.duration(dx.best)}</span>
      </span>
    `;
  }).join("");

  const ctx = document.getElementById("laps-chart").getContext("2d");
  state._charts ||= {};

  function makeDatasets() {
    return driverList
      .filter((dx) => initiallyOn.has(dx.num))
      .map((dx) => {
        const d = state.driversByNum[dx.num];
        const tc = teamColor(d);
        return {
          label: d?.name_acronym || `#${dx.num}`,
          data: dx.laps.map((l) => ({ x: l.lap_number, y: l.lap_duration, isPitOut: l.is_pit_out_lap })),
          borderColor: tc,
          backgroundColor: tc,
          borderWidth: 2,
          pointRadius: (ctx) => ctx.raw?.isPitOut ? 4 : 2,
          pointStyle: (ctx) => ctx.raw?.isPitOut ? "rect" : "circle",
          pointBackgroundColor: (ctx) => ctx.raw?.isPitOut ? "rgba(255,255,255,0.5)" : tc,
          pointHoverRadius: 5,
          tension: 0.15,
          spanGaps: true,
          segment: {
            borderDash: (ctx) => ctx.p1.raw?.isPitOut ? [3, 3] : undefined,
          },
        };
      });
  }

  state._charts["laps-chart"] = new Chart(ctx, {
    type: "line",
    data: { datasets: makeDatasets() },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Lap", color: "#9aa3b2" },
          ticks: { color: "#9aa3b2", precision: 0 },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          title: { display: true, text: "Lap time (s)", color: "#9aa3b2" },
          ticks: { color: "#9aa3b2", callback: (v) => fmt.duration(v) },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e7e9ee", boxWidth: 12, boxHeight: 3 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmt.duration(ctx.parsed.y)}${ctx.raw?.isPitOut ? " (out)" : ""}`,
            title: (items) => `Lap ${items[0].parsed.x}`,
          },
          backgroundColor: "#11141a",
          borderColor: "#2a2f3a",
          borderWidth: 1,
        },
      },
    },
  });

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || e.target.closest("[data-driver]")) return;
    const num = +chip.dataset.num;
    if (initiallyOn.has(num)) initiallyOn.delete(num); else initiallyOn.add(num);
    chip.classList.toggle("active");
    state._charts["laps-chart"].data.datasets = makeDatasets();
    state._charts["laps-chart"].update();
  });

  state.loaded.laps = true;
}

/* ------------------- Sectors ------------------- */
async function renderSectors() {
  const p = panel("sectors");
  if (state.loaded.sectors) return;

  setBusy("Loading laps…");
  let laps = [];
  try { laps = await api("laps", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load sectors</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  const valid = laps.filter((l) =>
    l.duration_sector_1 != null || l.duration_sector_2 != null || l.duration_sector_3 != null
  );
  if (!valid.length) {
    p.innerHTML = `<div class="empty"><strong>No sector data</strong></div>`;
    state.loaded.sectors = true;
    return;
  }

  const byDriver = {};
  for (const l of valid) {
    const num = l.driver_number;
    const d = byDriver[num] ||= {
      num, s1: Infinity, s2: Infinity, s3: Infinity,
      trap: 0, best: Infinity, lapForBest: null,
    };
    if (l.duration_sector_1 != null && l.duration_sector_1 < d.s1) d.s1 = l.duration_sector_1;
    if (l.duration_sector_2 != null && l.duration_sector_2 < d.s2) d.s2 = l.duration_sector_2;
    if (l.duration_sector_3 != null && l.duration_sector_3 < d.s3) d.s3 = l.duration_sector_3;
    const trap = Math.max(l.i1_speed || 0, l.i2_speed || 0, l.st_speed || 0);
    if (trap > d.trap) d.trap = trap;
    if (l.lap_duration != null && l.lap_duration < d.best) {
      d.best = l.lap_duration; d.lapForBest = l.lap_number;
    }
  }

  const rows = Object.values(byDriver).map((r) => ({
    ...r,
    s1: isFinite(r.s1) ? r.s1 : null,
    s2: isFinite(r.s2) ? r.s2 : null,
    s3: isFinite(r.s3) ? r.s3 : null,
    best: isFinite(r.best) ? r.best : null,
    trap: r.trap > 0 ? r.trap : null,
    ideal: (isFinite(r.s1) && isFinite(r.s2) && isFinite(r.s3)) ? r.s1 + r.s2 + r.s3 : null,
  })).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity));

  const sb = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? Math.min(...vals) : null;
  };
  const sbMax = (key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? Math.max(...vals) : null;
  };
  const best = {
    s1: sb("s1"), s2: sb("s2"), s3: sb("s3"),
    best: sb("best"), ideal: sb("ideal"), trap: sbMax("trap"),
  };

  p.innerHTML = `
    <h2 class="section-title">Sector & speed-trap bests</h2>
    <div class="legend-row"><strong>Purple</strong> = session best per column. Ideal lap = sum of each driver's best sectors.</div>
    <div class="card tight" style="padding:0;overflow:auto">
      <table class="f1">
        <thead>
          <tr>
            <th class="num">#</th><th>Driver</th><th>Team</th>
            <th class="num">S1</th><th class="num">S2</th><th class="num">S3</th>
            <th class="num">Trap (km/h)</th><th class="num">Best lap</th><th class="num">Ideal lap</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const d = state.driversByNum[r.num];
            if (!d) return "";
            const tc = teamColor(d);
            const cls = (val, sb) => (val != null && val === sb ? "num sb" : "num");
            return `
              <tr style="--team:${tc}" data-driver="${r.num}">
                <td class="num">${i + 1}</td>
                <td>
                  <div class="driver-cell">
                    <span class="num-badge">${r.num}</span>
                    <span class="acr">${d.name_acronym || ""}</span>
                  </div>
                </td>
                <td><span class="team-bar"></span>${d.team_name || ""}</td>
                <td class="${cls(r.s1, best.s1)}">${r.s1 != null ? r.s1.toFixed(3) : "—"}</td>
                <td class="${cls(r.s2, best.s2)}">${r.s2 != null ? r.s2.toFixed(3) : "—"}</td>
                <td class="${cls(r.s3, best.s3)}">${r.s3 != null ? r.s3.toFixed(3) : "—"}</td>
                <td class="${cls(r.trap, best.trap)}">${r.trap != null ? r.trap : "—"}</td>
                <td class="${cls(r.best, best.best)}">${r.best != null ? fmt.duration(r.best) : "—"}</td>
                <td class="${cls(r.ideal, best.ideal)}">${r.ideal != null ? fmt.duration(r.ideal) : "—"}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
  state.loaded.sectors = true;
}

/* ------------------- Championship standings ------------------- */
/**
 * Build drivers' + constructors' standings for a year by walking each meeting's
 * Race + Sprint sessions and summing session_result.points by driver_number,
 * rolled up to teams via the per-session drivers list.
 *
 * Cached per-year on state._standings.
 */
async function computeStandings(year) {
  state._standings ||= {};
  if (state._standings[year]) return state._standings[year];

  const meetings = await api("meetings", { year }).catch(() => []);
  const completedMeetings = (Array.isArray(meetings) ? meetings : [])
    .filter((m) => !m.is_cancelled && new Date(m.date_end).getTime() < Date.now())
    .sort((a, b) => new Date(a.date_end) - new Date(b.date_end));

  // Resolve sessions for each completed meeting (parallel-ish, throttled by api()).
  const meetingSessions = await Promise.all(
    completedMeetings.map((m) =>
      api("sessions", { meeting_key: m.meeting_key })
        .catch(() => [])
        .then((sessions) => ({ m, sessions: Array.isArray(sessions) ? sessions : [] }))
    )
  );

  // Pick out completed Race + Sprint sessions only.
  const pointsBearingSessions = [];
  let lastRaceMeeting = null;
  for (const { m, sessions } of meetingSessions) {
    let hasCompletedRace = false;
    for (const s of sessions) {
      if (s.is_cancelled) continue;
      if (new Date(s.date_end).getTime() >= Date.now()) continue;
      if (s.session_name === "Race" || s.session_name === "Sprint") {
        pointsBearingSessions.push({ meeting: m, session: s });
        if (s.session_name === "Race") hasCompletedRace = true;
      }
    }
    if (hasCompletedRace) lastRaceMeeting = m;
  }

  // Fetch session_result + drivers for each session.
  const sessionData = await Promise.all(
    pointsBearingSessions.map(async (entry) => {
      const sk = entry.session.session_key;
      const [results, drivers] = await Promise.all([
        api("session_result", { session_key: sk }).catch(() => []),
        api("drivers", { session_key: sk }).catch(() => []),
      ]);
      return {
        meeting: entry.meeting,
        session: entry.session,
        results: Array.isArray(results) ? results : [],
        drivers: Array.isArray(drivers) ? drivers : [],
      };
    })
  );

  // Sequential retry pass: any session that came back empty under rate-limit pressure
  // gets one more shot with the cache & limiter cooled down. This avoids silently
  // dropping races (which would understate winners' totals).
  for (const entry of sessionData) {
    if (!entry.results.length) {
      const r = await api("session_result", { session_key: entry.session.session_key }).catch(() => []);
      if (Array.isArray(r) && r.length) entry.results = r;
    }
    if (!entry.drivers.length) {
      const d = await api("drivers", { session_key: entry.session.session_key }).catch(() => []);
      if (Array.isArray(d) && d.length) entry.drivers = d;
    }
  }

  const driverTotals = {}; // driver_number → totals
  const teamTotals = {};   // team_name → totals

  for (const { session, results, drivers } of sessionData) {
    const isRace = session.session_name === "Race";
    const driversByNum = {};
    for (const d of drivers) driversByNum[d.driver_number] = d;

    for (const r of results) {
      if (r.points == null) continue;
      const dr = driversByNum[r.driver_number];
      if (!dr) continue;
      const tc = dr.team_colour ? `#${dr.team_colour}` : "#666";

      const dt = driverTotals[r.driver_number] ||= {
        num: r.driver_number,
        name: dr.full_name || dr.broadcast_name,
        acronym: dr.name_acronym || String(r.driver_number),
        team: dr.team_name || "",
        color: tc,
        points: 0, wins: 0, podiums: 0, sprintWins: 0,
      };
      dt.points += r.points || 0;
      // keep latest team/color (handles mid-season swaps)
      dt.team = dr.team_name || dt.team;
      dt.color = tc;
      if (r.position === 1 && isRace) dt.wins++;
      if (r.position === 1 && !isRace) dt.sprintWins++;
      if (r.position && r.position <= 3 && isRace) dt.podiums++;

      const team = dr.team_name;
      if (team) {
        const tt = teamTotals[team] ||= {
          team, color: tc,
          points: 0, wins: 0, podiums: 0,
        };
        tt.points += r.points || 0;
        tt.color = tc;
        if (r.position === 1 && isRace) tt.wins++;
        if (r.position && r.position <= 3 && isRace) tt.podiums++;
      }
    }
  }

  const driversArr = Object.values(driverTotals).sort(
    (a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums
  );
  const constructorsArr = Object.values(teamTotals).sort(
    (a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums
  );

  const result = {
    year,
    asOf: lastRaceMeeting,
    drivers: driversArr,
    constructors: constructorsArr,
    raceCount: pointsBearingSessions.filter((e) => e.session.session_name === "Race").length,
    sprintCount: pointsBearingSessions.filter((e) => e.session.session_name === "Sprint").length,
  };
  state._standings[year] = result;
  return result;
}

async function renderStandings() {
  const p = panel("standings");
  const year = state.year;
  if (!year) {
    p.innerHTML = `<div class="empty"><strong>No year selected</strong></div>`;
    return;
  }

  // Show progressive status while we compute (first visit per year is many fetches).
  if (!state._standings || !state._standings[year]) {
    p.innerHTML = `<div class="empty spin-only"><span class="spin"></span> Computing championship totals for ${escapeHtml(String(year))}…</div>`;
  }
  setBusy(`Computing ${year} standings…`);
  let standings;
  try { standings = await computeStandings(year); }
  finally { clearBusy(); }

  if (!standings.drivers.length && !standings.constructors.length) {
    p.innerHTML = `
      <div class="empty">
        <strong>No completed races yet</strong>
        <div>${escapeHtml(String(year))} hasn't run any points-bearing sessions yet.</div>
      </div>
    `;
    return;
  }

  const fmtPts = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  const leader = standings.drivers[0];
  const leaderTeam = standings.constructors[0];

  const driverRow = (r, i) => {
    const trail = i === 0 ? "" : `<span class="pts-trail">−${fmtPts(leader.points - r.points)}</span>`;
    return `
      <tr style="--team:${r.color}" data-driver="${r.num}" class="${i === 0 ? "leader" : ""}">
        <td class="num"><span class="pos">${i + 1}</span></td>
        <td>
          <div class="driver-cell">
            <span class="num-badge">${r.num}</span>
            <div>
              <div class="acr">${escapeHtml(r.acronym)}</div>
              <div class="full">${escapeHtml(r.name)}</div>
            </div>
          </div>
        </td>
        <td><span class="team-bar"></span>${escapeHtml(r.team)}</td>
        <td class="num">${r.wins}${r.sprintWins ? ` <span style="color:var(--text-faint)">+${r.sprintWins}s</span>` : ""}</td>
        <td class="num">${r.podiums}</td>
        <td class="pts">${fmtPts(r.points)}${trail}</td>
      </tr>
    `;
  };

  const teamRow = (r, i) => {
    const trail = i === 0 ? "" : `<span class="pts-trail">−${fmtPts(leaderTeam.points - r.points)}</span>`;
    return `
      <tr style="--team:${r.color}" class="${i === 0 ? "leader" : ""}">
        <td class="num"><span class="pos">${i + 1}</span></td>
        <td><span class="team-bar"></span>${escapeHtml(r.team)}</td>
        <td class="num">${r.wins}</td>
        <td class="num">${r.podiums}</td>
        <td class="pts">${fmtPts(r.points)}${trail}</td>
      </tr>
    `;
  };

  const asOfText = standings.asOf
    ? `after ${escapeHtml(standings.asOf.meeting_name)} · ${escapeHtml(standings.asOf.country_name || "")}`
    : "no races completed yet";
  const sessionsLine = `${standings.raceCount} race${standings.raceCount === 1 ? "" : "s"}${standings.sprintCount ? ` · ${standings.sprintCount} sprint${standings.sprintCount === 1 ? "" : "s"}` : ""}`;

  p.innerHTML = `
    <h2 class="section-title">Championship · ${escapeHtml(String(year))}</h2>
    <div class="standings-asof">
      <strong>${escapeHtml(String(year))}</strong> · ${asOfText} · ${sessionsLine}
    </div>
    <div class="standings-grid">
      <div class="standings-card">
        <div class="head">
          <h3>Drivers</h3>
          <span class="scope">${standings.drivers.length} scoring · top ${Math.min(20, standings.drivers.length)}</span>
        </div>
        <div style="overflow:auto">
          <table class="f1">
            <thead>
              <tr>
                <th class="num">Pos</th>
                <th>Driver</th>
                <th>Team</th>
                <th class="num">Wins</th>
                <th class="num">Podiums</th>
                <th class="num">Pts</th>
              </tr>
            </thead>
            <tbody>${standings.drivers.slice(0, 20).map(driverRow).join("")}</tbody>
          </table>
        </div>
      </div>
      <div class="standings-card">
        <div class="head">
          <h3>Constructors</h3>
          <span class="scope">${standings.constructors.length} scoring</span>
        </div>
        <div style="overflow:auto">
          <table class="f1">
            <thead>
              <tr>
                <th class="num">Pos</th>
                <th>Team</th>
                <th class="num">Wins</th>
                <th class="num">Podiums</th>
                <th class="num">Pts</th>
              </tr>
            </thead>
            <tbody>${standings.constructors.map(teamRow).join("")}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/* ------------------- Race trace ------------------- */
async function renderRaceTrace() {
  const p = panel("trace");
  if (state.loaded.trace) return;

  setBusy("Loading race trace…");
  let positions = [], laps = [];
  try {
    [positions, laps] = await Promise.all([
      api("position", { session_key: state.sessionKey }),
      api("laps", { session_key: state.sessionKey }),
    ]);
  } catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load race trace</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  const lapsByDriver = {};
  let maxLap = 0;
  for (const l of laps) {
    if (l.lap_number == null || l.date_start == null) continue;
    (lapsByDriver[l.driver_number] ||= []).push(l);
    if (l.lap_number > maxLap) maxLap = l.lap_number;
  }
  for (const d in lapsByDriver) lapsByDriver[d].sort((a, b) => a.lap_number - b.lap_number);

  const posByDriver = {};
  for (const r of positions) (posByDriver[r.driver_number] ||= []).push(r);
  for (const d in posByDriver) posByDriver[d].sort((a, b) => new Date(a.date) - new Date(b.date));

  const traceByDriver = {};
  for (const numStr of Object.keys(lapsByDriver)) {
    const num = +numStr;
    const lapsArr = lapsByDriver[num];
    const posArr = posByDriver[num] || [];
    if (!posArr.length) continue;
    let posIdx = 0;
    let lastPos = posArr[0].position;
    const trace = [];
    for (const lap of lapsArr) {
      const lapStart = new Date(lap.date_start).getTime();
      const lapEnd = lap.lap_duration != null ? lapStart + lap.lap_duration * 1000 : lapStart + 120 * 1000;
      while (posIdx < posArr.length && new Date(posArr[posIdx].date).getTime() <= lapEnd) {
        lastPos = posArr[posIdx].position;
        posIdx++;
      }
      if (lastPos != null) trace.push({ x: lap.lap_number, y: lastPos });
    }
    if (trace.length) traceByDriver[num] = trace;
  }

  const driverList = Object.entries(traceByDriver).map(([num, pts]) => {
    const finalPos = pts[pts.length - 1].y;
    return { num: +num, finalPos, pts };
  }).sort((a, b) => a.finalPos - b.finalPos);

  if (!driverList.length || !maxLap) {
    p.innerHTML = `<div class="empty"><strong>Not enough data for a race trace</strong></div>`;
    state.loaded.trace = true;
    return;
  }

  const initiallyOn = new Set(driverList.map((d) => d.num));

  p.innerHTML = `
    <h2 class="section-title">Race trace &middot; position by lap</h2>
    <div class="laps-controls" id="trace-chips"></div>
    <div class="trace-chart-wrap"><canvas id="trace-chart"></canvas></div>
  `;

  const chipsEl = document.getElementById("trace-chips");
  chipsEl.innerHTML = driverList.map((dx) => {
    const d = state.driversByNum[dx.num];
    const tc = teamColor(d);
    return `
      <span class="chip active" data-num="${dx.num}" style="--team:${tc}">
        <span class="dot" style="background:${tc}"></span>
        <span data-driver="${dx.num}">${d?.name_acronym || dx.num}</span>
        <span style="color:var(--text-faint);font-weight:600">P${dx.finalPos}</span>
      </span>
    `;
  }).join("");

  const ctx = document.getElementById("trace-chart").getContext("2d");
  state._charts ||= {};

  function makeDatasets() {
    return driverList
      .filter((dx) => initiallyOn.has(dx.num))
      .map((dx) => {
        const d = state.driversByNum[dx.num];
        const tc = teamColor(d);
        return {
          label: d?.name_acronym || `#${dx.num}`,
          data: dx.pts,
          borderColor: tc, backgroundColor: tc,
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
          tension: 0,
        };
      });
  }

  const numDrivers = driverList.length;
  state._charts["trace-chart"] = new Chart(ctx, {
    type: "line",
    data: { datasets: makeDatasets() },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Lap", color: "#9aa3b2" },
          ticks: { color: "#9aa3b2", precision: 0 },
          grid: { color: "rgba(255,255,255,0.05)" },
          min: 1, max: maxLap,
        },
        y: {
          reverse: true, min: 1, max: numDrivers,
          title: { display: true, text: "Position", color: "#9aa3b2" },
          ticks: { color: "#9aa3b2", stepSize: 1, precision: 0, callback: (v) => `P${v}` },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e7e9ee", boxWidth: 12, boxHeight: 3 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: P${ctx.parsed.y}`,
            title: (items) => `Lap ${items[0].parsed.x}`,
          },
          backgroundColor: "#11141a", borderColor: "#2a2f3a", borderWidth: 1,
        },
      },
    },
  });

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || e.target.closest("[data-driver]")) return;
    const num = +chip.dataset.num;
    if (initiallyOn.has(num)) initiallyOn.delete(num); else initiallyOn.add(num);
    chip.classList.toggle("active");
    state._charts["trace-chart"].data.datasets = makeDatasets();
    state._charts["trace-chart"].update();
  });

  state.loaded.trace = true;
}

/* ------------------- Onboard (telemetry + track map) ------------------- */
function speedToColor(speed) {
  const t = Math.max(0, Math.min(1, (speed || 0) / 340));
  const hue = (1 - t) * 240;
  return `hsl(${hue.toFixed(0)}, 90%, 55%)`;
}

function buildTimeIndex(arr) {
  const sorted = arr.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const times = sorted.map((r) => new Date(r.date).getTime());
  return { sorted, times };
}

function nearestByTime(idx, t) {
  const { times, sorted } = idx;
  if (!times.length) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) lo--;
  return sorted[lo];
}

async function renderOnboard() {
  const p = panel("onboard");

  setBusy("Loading laps…");
  let laps = [];
  try { laps = await api("laps", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load lap data</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  const bestByDriver = {};
  for (const l of laps) {
    if (l.lap_duration == null || l.date_start == null) continue;
    const cur = bestByDriver[l.driver_number];
    if (!cur || l.lap_duration < cur.lap_duration) bestByDriver[l.driver_number] = l;
  }
  const driverList = Object.values(bestByDriver)
    .map((l) => ({ num: l.driver_number, best: l.lap_duration, bestLap: l.lap_number }))
    .filter((d) => state.driversByNum[d.num])
    .sort((a, b) => a.best - b.best);

  if (!driverList.length) {
    p.innerHTML = `<div class="empty"><strong>No telemetry available</strong></div>`;
    state.loaded.onboard = true;
    return;
  }

  if (!state._onboard) state._onboard = { driverNum: null, lapNumber: null };
  if (!state._onboard.driverNum || !driverList.find((d) => d.num === state._onboard.driverNum)) {
    state._onboard.driverNum = driverList[0].num;
    state._onboard.lapNumber = driverList[0].bestLap;
  }

  if (!state.loaded.onboard) {
    p.innerHTML = `
      <div class="onboard-controls">
        <label>
          <span>Driver</span>
          <select id="onboard-driver"></select>
        </label>
        <label>
          <span>Lap (sorted by time)</span>
          <select id="onboard-lap"></select>
        </label>
        <div style="font-size:11px;color:var(--text-faint);align-self:end;padding-bottom:10px">
          Telemetry samples ~3.7 Hz from <strong>car_data</strong> + <strong>location</strong>. Hover charts to scrub the racing line.
        </div>
      </div>
      <div id="onboard-content"></div>
    `;

    const dSel = document.getElementById("onboard-driver");
    dSel.innerHTML = driverList.map((d) => {
      const dr = state.driversByNum[d.num];
      return `<option value="${d.num}">${dr?.name_acronym || d.num} — ${dr?.team_name || ""} (${fmt.duration(d.best)})</option>`;
    }).join("");
    dSel.value = state._onboard.driverNum;
    dSel.addEventListener("change", async (e) => {
      state._onboard.driverNum = +e.target.value;
      state._onboard.lapNumber = null;
      await drawOnboardForDriver(laps);
    });

    const lSel = document.getElementById("onboard-lap");
    lSel.addEventListener("change", async (e) => {
      state._onboard.lapNumber = +e.target.value;
      await drawOnboardForLap(laps);
    });

    state.loaded.onboard = true;
  }

  await drawOnboardForDriver(laps);
}

async function drawOnboardForDriver(laps) {
  const driverNum = state._onboard.driverNum;
  const driverLaps = laps
    .filter((l) => l.driver_number === driverNum && l.lap_duration != null && l.date_start != null)
    .sort((a, b) => a.lap_duration - b.lap_duration);
  const lSel = document.getElementById("onboard-lap");
  if (!lSel) return;
  lSel.innerHTML = driverLaps.map((l) =>
    `<option value="${l.lap_number}">L${l.lap_number} — ${fmt.duration(l.lap_duration)}${l.is_pit_out_lap ? " (out)" : ""}</option>`
  ).join("");
  if (!state._onboard.lapNumber || !driverLaps.find((l) => l.lap_number === state._onboard.lapNumber)) {
    state._onboard.lapNumber = driverLaps[0]?.lap_number;
  }
  if (state._onboard.lapNumber != null) lSel.value = state._onboard.lapNumber;

  await drawOnboardForLap(laps);
}

async function drawOnboardForLap(laps) {
  const content = document.getElementById("onboard-content");
  if (!content) return;
  const driverNum = state._onboard.driverNum;
  const lapNum = state._onboard.lapNumber;
  const lap = laps.find((l) => l.driver_number === driverNum && l.lap_number === lapNum);
  if (!lap) {
    content.innerHTML = `<div class="empty"><strong>No lap data</strong></div>`;
    return;
  }

  content.innerHTML = `<div class="empty spin-only"><span class="spin"></span> Loading telemetry…</div>`;

  // Cancel any previous in-flight Onboard fetches (user changed driver/lap fast)
  if (state._onboardAbort) {
    try { state._onboardAbort.abort(); } catch {}
  }
  const controller = new AbortController();
  state._onboardAbort = controller;
  const signal = controller.signal;

  const startMs = new Date(lap.date_start).getTime();
  const endMs = startMs + lap.lap_duration * 1000;
  const trim = CONFIG.TELEMETRY_TRIM_MS;
  const startStr = new Date(startMs - trim).toISOString();
  const endStr = new Date(endMs + trim).toISOString();

  setBusy("Loading telemetry & GPS…");
  let carData = [], location = [];
  try {
    [carData, location] = await Promise.all([
      api("car_data", { session_key: state.sessionKey, driver_number: driverNum, "date>": startStr, "date<": endStr, _signal: signal }).catch((e) => { if (e?.name === "AbortError") throw e; return []; }),
      api("location", { session_key: state.sessionKey, driver_number: driverNum, "date>": startStr, "date<": endStr, _signal: signal }).catch((e) => { if (e?.name === "AbortError") throw e; return []; }),
    ]);
  } catch (e) {
    if (e?.name === "AbortError") return; // a newer selection took over
    throw e;
  } finally {
    clearBusy();
    if (state._onboardAbort === controller) state._onboardAbort = null;
  }

  location = location.filter((p) => !(p.x === 0 && p.y === 0) && p.x != null && p.y != null);

  if (!carData.length && !location.length) {
    content.innerHTML = `<div class="empty"><strong>No telemetry for this lap</strong>The car_data and location endpoints are empty for this driver/lap window.</div>`;
    return;
  }

  carData.sort((a, b) => new Date(a.date) - new Date(b.date));
  location.sort((a, b) => new Date(a.date) - new Date(b.date));
  location = cleanLocationPath(location);

  renderOnboardLapContent(content, lap, carData, location);
}

function renderOnboardLapContent(container, lap, carData, location) {
  const driver = state.driversByNum[lap.driver_number];
  const tc = teamColor(driver);

  const speeds = carData.map((r) => r.speed).filter((v) => v != null);
  const topSpeed = speeds.length ? Math.max(...speeds) : null;
  const minSpeed = speeds.length ? Math.min(...speeds) : null;
  const fullThrottle = carData.filter((r) => (r.throttle ?? 0) >= 99).length;
  const onBrake = carData.filter((r) => (r.brake ?? 0) > 0).length;
  const drsOpen = carData.filter((r) => (r.drs ?? 0) >= 8).length;
  const gears = carData.map((r) => r.n_gear).filter((g) => g != null && g > 0);
  const maxGear = gears.length ? Math.max(...gears) : null;
  const total = carData.length || 1;
  const pct = (n) => Math.round((n / total) * 100);

  container.innerHTML = `
    <div class="onboard-top">
      <div class="track-card">
        <div class="head">
          <h3>${state.meeting?.circuit_short_name || "Track"}</h3>
          <span class="pill">racing line · colored by speed</span>
        </div>
        <div class="track-canvas-wrap">
          <canvas class="track-canvas" id="track-canvas"></canvas>
          <canvas class="track-overlay" id="track-overlay"></canvas>
          <div class="track-cursor" id="track-cursor"></div>
        </div>
        <div class="track-legend">
          <span style="color:var(--text-faint)">slow</span>
          <span class="bar"></span>
          <span style="color:var(--text-faint)">fast</span>
        </div>
      </div>
      <div class="stats-card">
        <div class="stats-driver" style="--team:${tc}" data-driver="${driver.driver_number}">
          <img src="${driver.headshot_url || ""}" alt="" data-initials="${driver.name_acronym || ""}" data-bg="${tc}" />
          <div>
            <div class="name">${driver.full_name || driver.broadcast_name}</div>
            <div class="sub">${driver.team_name || ""}</div>
          </div>
          <div class="lap-info">
            <div class="lap-time">${fmt.duration(lap.lap_duration)}</div>
            <div class="sub">Lap ${lap.lap_number}${lap.is_pit_out_lap ? " · out lap" : ""}</div>
          </div>
        </div>
        <div class="stats-grid">
          <div class="stat-tile red"><span class="label">Top speed</span><span class="v"><span data-count-to="${topSpeed ?? 0}" data-count-duration="700">0</span><span class="u"> km/h</span></span></div>
          <div class="stat-tile blue"><span class="label">Min speed</span><span class="v"><span data-count-to="${minSpeed ?? 0}">0</span><span class="u"> km/h</span></span></div>
          <div class="stat-tile green"><span class="label">Full throttle</span><span class="v"><span data-count-to="${pct(fullThrottle)}">0</span><span class="u">%</span></span></div>
          <div class="stat-tile red"><span class="label">On brake</span><span class="v"><span data-count-to="${pct(onBrake)}">0</span><span class="u">%</span></span></div>
          <div class="stat-tile accent"><span class="label">DRS open</span><span class="v"><span data-count-to="${pct(drsOpen)}">0</span><span class="u">%</span></span></div>
          <div class="stat-tile"><span class="label">Top gear</span><span class="v">${maxGear ?? "—"}</span></div>
        </div>
      </div>
    </div>

    <div class="telemetry-stack">
      <div class="telemetry-block">
        <div class="head"><h4>Speed (km/h)</h4><span class="summary">peak ${topSpeed ?? "—"} · min ${minSpeed ?? "—"}</span></div>
        <div class="telemetry-canvas-wrap tall"><canvas id="speed-chart"></canvas></div>
      </div>
      <div class="telemetry-block">
        <div class="head"><h4>Throttle &amp; Brake</h4><span class="summary">throttle ${pct(carData.filter((r)=>(r.throttle??0)>0).length)}% · brake ${pct(onBrake)}%</span></div>
        <div class="telemetry-canvas-wrap"><canvas id="tb-chart"></canvas></div>
      </div>
      <div class="telemetry-block">
        <div class="head"><h4>Gear &amp; DRS</h4><span class="summary">DRS open ${pct(drsOpen)}% of lap</span></div>
        <div class="telemetry-canvas-wrap"><canvas id="gear-chart"></canvas></div>
        <div class="drs-strip" id="drs-strip"></div>
      </div>
    </div>
  `;

  drawTrackMap(document.getElementById("track-canvas"), location, carData, lap);
  drawTelemetryCharts(carData, lap, location);
  drawDrsStrip(document.getElementById("drs-strip"), carData);
  animateCounters(container);
}

function projectLocations(canvas, locations) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const xs = locations.map((p) => p.x);
  const ys = locations.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  const pad = 28;
  const sx = (cw - 2 * pad) / bw;
  const sy = (ch - 2 * pad) / bh;
  const s = Math.min(sx, sy);
  const ox = (cw - bw * s) / 2 - minX * s;
  const oy = (ch - bh * s) / 2 - minY * s;
  return (p) => ({ x: p.x * s + ox, y: ch - (p.y * s + oy) });
}

function drawTrackMap(canvas, locations, carData, lap) {
  if (!canvas || !locations.length) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  canvas.width = Math.floor(cw * dpr);
  canvas.height = Math.floor(ch * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const project = projectLocations(canvas, locations);

  // Faint full-track outline (subtle base layer)
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.beginPath();
  for (let i = 0; i < locations.length; i++) {
    const p = project(locations[i]);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.stroke();

  // Speed-colored line
  const idx = buildTimeIndex(carData);
  ctx.lineWidth = 4;
  for (let i = 1; i < locations.length; i++) {
    const a = project(locations[i - 1]);
    const b = project(locations[i]);
    const t = new Date(locations[i].date).getTime();
    const cd = idx.times.length ? nearestByTime(idx, t) : null;
    const speed = cd?.speed ?? null;
    ctx.strokeStyle = speed != null ? speedToColor(speed) : "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Sector boundary markers (using lap timing)
  if (lap.duration_sector_1 != null && lap.duration_sector_2 != null) {
    const lapStartMs = new Date(lap.date_start).getTime();
    const locIdx = buildTimeIndex(locations);
    const sectorMarks = [
      { time: lapStartMs + lap.duration_sector_1 * 1000, label: "S2" },
      { time: lapStartMs + (lap.duration_sector_1 + lap.duration_sector_2) * 1000, label: "S3" },
    ];
    for (const m of sectorMarks) {
      const loc = nearestByTime(locIdx, m.time);
      if (!loc) continue;
      const p = project(loc);
      // tick mark perpendicular to direction of travel (small chord around point)
      const i = locations.indexOf(loc);
      const prev = locations[Math.max(0, i - 2)];
      const next = locations[Math.min(locations.length - 1, i + 2)];
      const dx = next.x - prev.x;
      const dy = -(next.y - prev.y); // canvas Y inverted
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len; // perpendicular
      const r = 12;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(p.x - nx * r, p.y - ny * r);
      ctx.lineTo(p.x + nx * r, p.y + ny * r);
      ctx.stroke();
      // label
      ctx.font = "700 10px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(m.label, p.x + nx * (r + 10), p.y + ny * (r + 10));
    }
  }

  // Start dot + S/F label
  const startP = project(locations[0]);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(startP.x, startP.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
  ctx.font = "700 10px 'JetBrains Mono', monospace";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.textAlign = "left";
  ctx.fillText("S/F", startP.x + 8, startP.y - 8);

  // Save projection + locations for crosshair scrubbing
  state._onboardCtx = { project, locations, lap };
}

function drawTelemetryCharts(carData, lap, location) {
  const lapStartMs = new Date(lap.date_start).getTime();
  const toX = (d) => (new Date(d).getTime() - lapStartMs) / 1000;
  state._charts ||= {};

  const speedPoints = carData.filter((r) => r.speed != null).map((r) => ({ x: toX(r.date), y: r.speed }));
  const throttlePoints = carData.filter((r) => r.throttle != null).map((r) => ({ x: toX(r.date), y: r.throttle }));
  const brakePoints = carData.filter((r) => r.brake != null).map((r) => ({ x: toX(r.date), y: r.brake > 0 ? 100 : 0 }));
  const gearPoints = carData.filter((r) => r.n_gear != null).map((r) => ({ x: toX(r.date), y: r.n_gear }));

  // Crosshair plugin shared across charts
  const crosshairPlugin = {
    id: "crosshair",
    afterDraw(chart) {
      const xVal = state._onboardCrosshairX;
      if (xVal == null) return;
      const x = chart.scales.x.getPixelForValue(xVal);
      const top = chart.chartArea.top;
      const bottom = chart.chartArea.bottom;
      if (x < chart.chartArea.left || x > chart.chartArea.right) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = "rgba(225, 6, 0, 0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  const baseOpts = (yMin, yMax, yLabel, stepSize) => ({
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
    interaction: { mode: "nearest", intersect: false, axis: "x" },
    scales: {
      x: {
        type: "linear",
        ticks: { color: "#9aa3b2", callback: (v) => `${v.toFixed(0)}s` },
        grid: { color: "rgba(255,255,255,0.04)" },
        title: { display: true, text: "Lap time (s)", color: "#9aa3b2" },
      },
      y: {
        suggestedMin: yMin, suggestedMax: yMax,
        ticks: { color: "#9aa3b2", stepSize },
        grid: { color: "rgba(255,255,255,0.04)" },
        title: { display: true, text: yLabel, color: "#9aa3b2" },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => `t = ${items[0].parsed.x.toFixed(2)}s`,
          label: (ctx) => `${ctx.dataset.label}: ${typeof ctx.parsed.y === "number" ? ctx.parsed.y.toFixed(0) : ctx.parsed.y}`,
        },
        backgroundColor: "#11141a", borderColor: "#2a2f3a", borderWidth: 1,
      },
    },
  });

  // Speed chart with segment colors
  state._charts["speed-chart"] = new Chart(
    document.getElementById("speed-chart").getContext("2d"),
    {
      type: "line",
      data: { datasets: [{
        label: "Speed", data: speedPoints,
        borderColor: "#888", borderWidth: 2, pointRadius: 0, tension: 0.15,
        segment: { borderColor: (ctx) => speedToColor((ctx.p0.parsed.y + ctx.p1.parsed.y) / 2) },
      }] },
      options: baseOpts(0, 360, "km/h"),
      plugins: [crosshairPlugin],
    }
  );

  state._charts["tb-chart"] = new Chart(
    document.getElementById("tb-chart").getContext("2d"),
    {
      type: "line",
      data: { datasets: [
        { label: "Throttle %", data: throttlePoints, borderColor: "#2ecc71", backgroundColor: "rgba(46,204,113,0.18)", fill: true, tension: 0.1, pointRadius: 0, borderWidth: 1.5 },
        { label: "Brake", data: brakePoints, borderColor: "#e10600", backgroundColor: "rgba(225,6,0,0.20)", fill: true, stepped: true, pointRadius: 0, borderWidth: 1.5 },
      ] },
      options: baseOpts(0, 100, "%"),
      plugins: [crosshairPlugin],
    }
  );

  state._charts["gear-chart"] = new Chart(
    document.getElementById("gear-chart").getContext("2d"),
    {
      type: "line",
      data: { datasets: [{ label: "Gear", data: gearPoints, borderColor: "#ffd60a", backgroundColor: "rgba(255,214,10,0.15)", fill: true, stepped: true, pointRadius: 0, borderWidth: 1.5 }] },
      options: baseOpts(0, 8, "gear", 1),
      plugins: [crosshairPlugin],
    }
  );

  // Wire mouse hover on each canvas to update crosshairs + track cursor
  const onHover = (chart) => (e) => {
    const rect = chart.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const x = chart.scales.x.getValueForPixel(px);
    if (x == null) return;
    state._onboardCrosshairX = x;
    syncCrosshairs();
    updateTrackCursor(x);
  };
  const onLeave = () => {
    state._onboardCrosshairX = null;
    syncCrosshairs();
    const cur = document.getElementById("track-cursor");
    if (cur) cur.classList.remove("show");
  };
  for (const id of ["speed-chart", "tb-chart", "gear-chart"]) {
    const c = state._charts[id];
    c.canvas.addEventListener("mousemove", onHover(c));
    c.canvas.addEventListener("mouseleave", onLeave);
  }

  function syncCrosshairs() {
    for (const id of ["speed-chart", "tb-chart", "gear-chart"]) {
      const c = state._charts[id]; if (c) c.draw();
    }
  }

  function updateTrackCursor(secondsIntoLap) {
    const ctxData = state._onboardCtx;
    const cur = document.getElementById("track-cursor");
    if (!ctxData || !cur) return;
    const tMs = lapStartMs + secondsIntoLap * 1000;
    const locIdx = buildTimeIndex(ctxData.locations);
    const loc = nearestByTime(locIdx, tMs);
    if (!loc) { cur.classList.remove("show"); return; }
    const p = ctxData.project(loc);
    cur.style.left = p.x + "px";
    cur.style.top = p.y + "px";
    cur.classList.add("show");
  }
}

function drawDrsStrip(el, carData) {
  if (!el) return;
  const filtered = carData.filter((r) => r.drs != null);
  if (!filtered.length) {
    el.innerHTML = `<div class="label">no DRS data</div>`;
    return;
  }
  const total = filtered.length;
  const segs = [];
  let curOn = (filtered[0].drs ?? 0) >= 8;
  let curStart = 0;
  for (let i = 1; i < filtered.length; i++) {
    const on = (filtered[i].drs ?? 0) >= 8;
    if (on !== curOn) {
      segs.push({ on: curOn, w: i - curStart });
      curOn = on; curStart = i;
    }
  }
  segs.push({ on: curOn, w: filtered.length - curStart });
  el.innerHTML = segs.map((s) => `<div class="seg ${s.on ? "on" : ""}" style="width:${(s.w / total) * 100}%"></div>`).join("") + `<div class="label">DRS</div>`;
}

/* ------------------- Compare ------------------- */
async function renderCompare() {
  const p = panel("compare");
  if (!state.drivers.length) {
    p.innerHTML = `<div class="empty"><strong>No drivers</strong></div>`;
    return;
  }

  setBusy("Loading laps for compare…");
  let laps = [], stints = [], pits = [], overtakes = [];
  try {
    [laps, stints, pits, overtakes] = await Promise.all([
      api("laps", { session_key: state.sessionKey }).catch(() => []),
      api("stints", { session_key: state.sessionKey }).catch(() => []),
      api("pit", { session_key: state.sessionKey }).catch(() => []),
      api("overtakes", { session_key: state.sessionKey }).catch(() => []),
    ]);
  } finally { clearBusy(); }

  const byDriver = {};
  for (const l of laps) {
    if (l.lap_duration == null || l.lap_number == null) continue;
    (byDriver[l.driver_number] ||= []).push(l);
  }
  for (const k in byDriver) byDriver[k].sort((a, b) => a.lap_number - b.lap_number);

  const driverList = Object.entries(byDriver)
    .map(([num, arr]) => ({ num: +num, best: Math.min(...arr.map((l) => l.lap_duration)) }))
    .filter((d) => state.driversByNum[d.num])
    .sort((a, b) => a.best - b.best);

  if (driverList.length < 2) {
    p.innerHTML = `<div class="empty"><strong>Need at least 2 drivers with laps for compare</strong></div>`;
    state.loaded.compare = true;
    return;
  }

  if (!state._compare) state._compare = { a: driverList[0].num, b: driverList[1].num };
  if (!driverList.find((d) => d.num === state._compare.a)) state._compare.a = driverList[0].num;
  if (!driverList.find((d) => d.num === state._compare.b)) state._compare.b = driverList[1].num;

  if (!state.loaded.compare) {
    p.innerHTML = `
      <div class="compare-controls">
        <label>
          <span>Driver A</span>
          <select id="cmp-a"></select>
        </label>
        <div class="compare-vs">vs</div>
        <label>
          <span>Driver B</span>
          <select id="cmp-b"></select>
        </label>
      </div>
      <div id="compare-content"></div>
    `;
    const optionHtml = (selected) => driverList.map((d) => {
      const dr = state.driversByNum[d.num];
      return `<option value="${d.num}" ${d.num === selected ? "selected" : ""}>${dr?.name_acronym || d.num} — ${dr?.team_name || ""} (${fmt.duration(d.best)})</option>`;
    }).join("");
    document.getElementById("cmp-a").innerHTML = optionHtml(state._compare.a);
    document.getElementById("cmp-b").innerHTML = optionHtml(state._compare.b);
    document.getElementById("cmp-a").addEventListener("change", (e) => {
      state._compare.a = +e.target.value;
      drawCompare(byDriver, stints, pits, overtakes);
    });
    document.getElementById("cmp-b").addEventListener("change", (e) => {
      state._compare.b = +e.target.value;
      drawCompare(byDriver, stints, pits, overtakes);
    });
    state.loaded.compare = true;
  }

  drawCompare(byDriver, stints, pits, overtakes);
}

function drawCompare(byDriver, stints, pits, overtakes) {
  const content = document.getElementById("compare-content");
  if (!content) return;

  const summarize = (num) => {
    const arr = byDriver[num] || [];
    if (!arr.length) return null;
    let best = arr[0], s1 = Infinity, s2 = Infinity, s3 = Infinity, trap = 0;
    for (const l of arr) {
      if (l.lap_duration < best.lap_duration) best = l;
      if (l.duration_sector_1 != null && l.duration_sector_1 < s1) s1 = l.duration_sector_1;
      if (l.duration_sector_2 != null && l.duration_sector_2 < s2) s2 = l.duration_sector_2;
      if (l.duration_sector_3 != null && l.duration_sector_3 < s3) s3 = l.duration_sector_3;
      const t = Math.max(l.i1_speed || 0, l.i2_speed || 0, l.st_speed || 0);
      if (t > trap) trap = t;
    }
    return {
      best: best.lap_duration,
      bestLap: best.lap_number,
      laps: arr.length,
      s1: isFinite(s1) ? s1 : null,
      s2: isFinite(s2) ? s2 : null,
      s3: isFinite(s3) ? s3 : null,
      trap: trap > 0 ? trap : null,
      stops: pits.filter((p) => p.driver_number === num).length,
      stints: stints.filter((s) => s.driver_number === num).length,
      ot_made: overtakes.filter((o) => o.overtaking_driver_number === num).length,
      ot_lost: overtakes.filter((o) => o.overtaken_driver_number === num).length,
    };
  };

  const A = summarize(state._compare.a);
  const B = summarize(state._compare.b);
  const dA = state.driversByNum[state._compare.a];
  const dB = state.driversByNum[state._compare.b];

  const mkDelta = (av, bv, lowerIsBetter = true) => {
    if (av == null || bv == null) return ["", ""];
    const d = av - bv;
    if (d === 0) return ["", ""];
    const aClass = (lowerIsBetter ? d < 0 : d > 0) ? "faster" : "slower";
    const bClass = (lowerIsBetter ? d > 0 : d < 0) ? "faster" : "slower";
    const aMag = lowerIsBetter ? (d < 0 ? Math.abs(d) : d) : Math.abs(d);
    const bMag = aMag;
    const sign = (cls) => cls === "faster" ? "−" : "+";
    return [
      `<span class="delta ${aClass}">${sign(aClass)}${aMag.toFixed(3)}</span>`,
      `<span class="delta ${bClass}">${sign(bClass)}${bMag.toFixed(3)}</span>`,
    ];
  };

  const cardHtml = (driver, summary, deltas) => {
    if (!driver || !summary) return `<div class="compare-card"><div class="empty">No data</div></div>`;
    const tc = teamColor(driver);
    return `
      <div class="compare-card" style="--team:${tc}" data-driver="${driver.driver_number}">
        <div class="compare-head">
          <img src="${driver.headshot_url || ""}" alt="" data-initials="${driver.name_acronym || ""}" data-bg="${tc}" />
          <div>
            <div class="name">${driver.full_name || driver.broadcast_name}</div>
            <div class="team">${driver.team_name || ""}</div>
          </div>
        </div>
        <div class="compare-row"><span class="label">Best lap</span><span><span class="v">${fmt.duration(summary.best)}</span>${deltas.best || ""}</span></div>
        <div class="compare-row"><span class="label">Sector 1</span><span><span class="v">${summary.s1 != null ? summary.s1.toFixed(3) : "—"}</span>${deltas.s1 || ""}</span></div>
        <div class="compare-row"><span class="label">Sector 2</span><span><span class="v">${summary.s2 != null ? summary.s2.toFixed(3) : "—"}</span>${deltas.s2 || ""}</span></div>
        <div class="compare-row"><span class="label">Sector 3</span><span><span class="v">${summary.s3 != null ? summary.s3.toFixed(3) : "—"}</span>${deltas.s3 || ""}</span></div>
        <div class="compare-row"><span class="label">Speed trap</span><span><span class="v">${summary.trap ?? "—"} <span style="color:var(--text-faint);font-size:11px;font-weight:600">km/h</span></span>${deltas.trap || ""}</span></div>
        <div class="compare-row"><span class="label">Laps</span><span class="v">${summary.laps}</span></div>
        <div class="compare-row"><span class="label">Pit stops</span><span class="v">${summary.stops}</span></div>
        <div class="compare-row"><span class="label">Stints</span><span class="v">${summary.stints}</span></div>
        <div class="compare-row"><span class="label">Overtakes made</span><span class="v">${summary.ot_made}</span></div>
        <div class="compare-row"><span class="label">Positions lost</span><span class="v">${summary.ot_lost}</span></div>
      </div>
    `;
  };

  const [bestA, bestB] = mkDelta(A?.best, B?.best);
  const [s1A, s1B] = mkDelta(A?.s1, B?.s1);
  const [s2A, s2B] = mkDelta(A?.s2, B?.s2);
  const [s3A, s3B] = mkDelta(A?.s3, B?.s3);
  const [trapA, trapB] = mkDelta(A?.trap, B?.trap, false); // higher trap is better

  content.innerHTML = `
    <div class="compare-grid">
      ${cardHtml(dA, A, { best: bestA, s1: s1A, s2: s2A, s3: s3A, trap: trapA })}
      ${cardHtml(dB, B, { best: bestB, s1: s1B, s2: s2B, s3: s3B, trap: trapB })}
    </div>
    <h2 class="section-title">Lap-by-lap</h2>
    <div class="compare-laps-wrap"><canvas id="compare-laps-chart"></canvas></div>
  `;

  const tcA = teamColor(dA), tcB = teamColor(dB);
  const ds = [
    { num: state._compare.a, color: tcA, name: dA?.name_acronym || `#${state._compare.a}` },
    { num: state._compare.b, color: tcB, name: dB?.name_acronym || `#${state._compare.b}` },
  ].map((spec) => ({
    label: spec.name,
    data: (byDriver[spec.num] || []).map((l) => ({ x: l.lap_number, y: l.lap_duration, isPitOut: l.is_pit_out_lap })),
    borderColor: spec.color, backgroundColor: spec.color,
    borderWidth: 2.5, tension: 0.15,
    pointRadius: (ctx) => ctx.raw?.isPitOut ? 4 : 2,
    pointStyle: (ctx) => ctx.raw?.isPitOut ? "rect" : "circle",
  }));

  state._charts ||= {};
  if (state._charts["compare-laps-chart"]) state._charts["compare-laps-chart"].destroy();
  state._charts["compare-laps-chart"] = new Chart(
    document.getElementById("compare-laps-chart").getContext("2d"),
    {
      type: "line",
      data: { datasets: ds },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: "nearest", intersect: false },
        scales: {
          x: { type: "linear", title: { display: true, text: "Lap", color: "#9aa3b2" }, ticks: { color: "#9aa3b2", precision: 0 }, grid: { color: "rgba(255,255,255,0.05)" } },
          y: { title: { display: true, text: "Lap time (s)", color: "#9aa3b2" }, ticks: { color: "#9aa3b2", callback: (v) => fmt.duration(v) }, grid: { color: "rgba(255,255,255,0.05)" } },
        },
        plugins: {
          legend: { labels: { color: "#e7e9ee", boxWidth: 12, boxHeight: 3 } },
          tooltip: {
            callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt.duration(ctx.parsed.y)}`, title: (i) => `Lap ${i[0].parsed.x}` },
            backgroundColor: "#11141a", borderColor: "#2a2f3a", borderWidth: 1,
          },
        },
      },
    }
  );
}

/* ------------------- Stints ------------------- */
async function renderStints() {
  const p = panel("stints");
  if (state.loaded.stints) return;

  setBusy("Loading stints…");
  let stints = [];
  try { stints = await api("stints", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load stints</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  if (!stints.length) {
    p.innerHTML = `<div class="empty"><strong>No stint data</strong></div>`;
    state.loaded.stints = true;
    return;
  }

  const byDriver = {};
  let maxLap = 0;
  for (const s of stints) {
    (byDriver[s.driver_number] ||= []).push(s);
    if (s.lap_end > maxLap) maxLap = s.lap_end;
  }
  for (const d in byDriver) byDriver[d].sort((a, b) => a.stint_number - b.stint_number);

  const driverNums = Object.keys(byDriver).map(Number).sort((a, b) => {
    const la = Math.max(...byDriver[a].map((s) => s.lap_end));
    const lb = Math.max(...byDriver[b].map((s) => s.lap_end));
    return lb - la;
  });

  p.innerHTML = `
    <h2 class="section-title">Tyre stints &middot; ${maxLap} laps</h2>
    <div class="tyre-legend">
      <span><span class="swatch" style="background:var(--tyre-soft)"></span>Soft</span>
      <span><span class="swatch" style="background:var(--tyre-medium)"></span>Medium</span>
      <span><span class="swatch" style="background:var(--tyre-hard)"></span>Hard</span>
      <span><span class="swatch" style="background:var(--tyre-inter)"></span>Intermediate</span>
      <span><span class="swatch" style="background:var(--tyre-wet)"></span>Wet</span>
    </div>
    <div class="card" style="padding:14px 18px">
      <div class="stints-table">
        ${driverNums.map((num) => {
          const d = state.driversByNum[num];
          const tc = teamColor(d);
          const driverStints = byDriver[num];
          return `
            <div class="stints-row">
              <div class="stints-driver" data-driver="${num}">
                <span class="num-badge" style="--team:${tc}">${num}</span>
                <strong>${d?.name_acronym || num}</strong>
                <span style="color:var(--text-faint);font-size:11px">${d?.team_name || ""}</span>
              </div>
              <div class="stints-track" title="${driverStints.length} stint(s)">
                ${driverStints.map((s) => {
                  const compound = (s.compound || "UNKNOWN").toUpperCase();
                  const start = (s.lap_start - 1) / maxLap * 100;
                  const width = (s.lap_end - s.lap_start + 1) / maxLap * 100;
                  return `<div class="stint ${compound}" style="left:${start}%;width:${width}%"
                      title="${compound} · laps ${s.lap_start}–${s.lap_end}${s.tyre_age_at_start != null ? ` · age ${s.tyre_age_at_start}` : ""}">${
                        width > 6 ? compound[0] : ""
                      }</div>`;
                }).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
  state.loaded.stints = true;
}

/* ------------------- Pit stops ------------------- */
async function renderPits() {
  const p = panel("pits");
  if (state.loaded.pits) return;

  setBusy("Loading pit stops…");
  let pits = [];
  try { pits = await api("pit", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load pit stops</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  if (!pits.length) {
    p.innerHTML = `<div class="empty"><strong>No pit stops recorded</strong></div>`;
    state.loaded.pits = true;
    return;
  }

  pits.sort((a, b) => new Date(a.date) - new Date(b.date));
  let fastestStop = Infinity;
  for (const r of pits) if (r.pit_duration != null && r.pit_duration < fastestStop) fastestStop = r.pit_duration;

  p.innerHTML = `
    <h2 class="section-title">Pit stops &middot; ${pits.length}</h2>
    <div class="card tight" style="padding:0;overflow:auto">
      <table class="f1">
        <thead>
          <tr>
            <th class="num">#</th><th class="num">Lap</th>
            <th>Driver</th><th>Team</th>
            <th class="num">Pit duration</th><th class="num">Stop</th><th class="num">Lane</th><th>When</th>
          </tr>
        </thead>
        <tbody>
          ${pits.map((r, i) => {
            const d = state.driversByNum[r.driver_number];
            if (!d) return "";
            const tc = teamColor(d);
            const fast = r.pit_duration === fastestStop;
            return `
              <tr style="--team:${tc}" data-driver="${r.driver_number}">
                <td class="num">${i + 1}</td>
                <td class="num">${r.lap_number ?? "—"}</td>
                <td>
                  <div class="driver-cell">
                    <span class="num-badge">${r.driver_number}</span>
                    <span class="acr">${d.name_acronym || ""}</span>
                  </div>
                </td>
                <td><span class="team-bar"></span>${d.team_name || ""}</td>
                <td class="num ${fast ? "fast-pit" : ""}">${r.pit_duration != null ? r.pit_duration.toFixed(2) + "s" : "—"}</td>
                <td class="num">${r.stop_duration != null ? r.stop_duration.toFixed(2) + "s" : "—"}</td>
                <td class="num">${r.lane_duration != null ? r.lane_duration.toFixed(2) + "s" : "—"}</td>
                <td>${fmt.time(r.date)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
  state.loaded.pits = true;
}

/* ------------------- Overtakes ------------------- */
async function renderOvertakes() {
  const p = panel("overtakes");
  if (state.loaded.overtakes) return;

  setBusy("Loading overtakes…");
  let overtakes = [];
  try { overtakes = await api("overtakes", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>No overtake data for this session</strong></div>`;
    state.loaded.overtakes = true;
    clearBusy();
    return;
  }
  clearBusy();

  if (!overtakes.length) {
    p.innerHTML = `<div class="empty"><strong>No overtakes recorded</strong></div>`;
    state.loaded.overtakes = true;
    return;
  }

  overtakes.sort((a, b) => new Date(a.date) - new Date(b.date));

  const made = {}, lost = {};
  for (const ot of overtakes) {
    made[ot.overtaking_driver_number] = (made[ot.overtaking_driver_number] || 0) + 1;
    lost[ot.overtaken_driver_number] = (lost[ot.overtaken_driver_number] || 0) + 1;
  }
  const topMade = Object.entries(made).map(([n, c]) => ({ num: +n, count: c })).sort((a, b) => b.count - a.count).slice(0, 5);
  const topLost = Object.entries(lost).map(([n, c]) => ({ num: +n, count: c })).sort((a, b) => b.count - a.count).slice(0, 5);

  const driverChip = (num) => {
    const d = state.driversByNum[num];
    if (!d) return `<span class="num-badge" data-driver="${num}">${num}</span>`;
    const tc = teamColor(d);
    return `<span class="num-badge" style="--team:${tc}" data-driver="${num}">${num}</span> <strong>${d.name_acronym || ""}</strong>`;
  };

  const leaderRow = (r, i) => {
    const d = state.driversByNum[r.num];
    const tc = d ? teamColor(d) : "#666";
    return `
      <li style="--team:${tc}" data-driver="${r.num}">
        <span class="rank">${i + 1}.</span>
        <span class="who">${driverChip(r.num)}<span style="color:var(--text-faint);font-size:11px">${d?.team_name || ""}</span></span>
        <span class="count">${r.count}</span>
      </li>
    `;
  };

  p.innerHTML = `
    <h2 class="section-title">Overtakes &middot; ${overtakes.length} total</h2>
    <div class="ot-summary">
      <div class="ot-leader">
        <h4>Total</h4>
        <div class="stat" style="display:flex;align-items:baseline;gap:8px">
          <span class="v" style="font-size:28px;font-weight:800;font-family:var(--font-mono)"><span data-count-to="${overtakes.length}">0</span></span>
          <span class="u" style="color:var(--text-dim)">overtakes</span>
        </div>
        <div class="label" style="margin-top:6px">Across ${Object.keys(made).length} drivers</div>
      </div>
      <div class="ot-leader">
        <h4>Most overtakes made</h4>
        <ol>${topMade.map(leaderRow).join("")}</ol>
      </div>
      <div class="ot-leader">
        <h4>Most positions lost</h4>
        <ol>${topLost.map(leaderRow).join("")}</ol>
      </div>
    </div>

    <h2 class="section-title">Timeline</h2>
    <div class="ot-list">
      ${overtakes.map((ot) => `
        <div class="ot-row">
          <div class="ts" style="color:var(--text-faint);font-variant-numeric:tabular-nums;font-family:var(--font-mono)">${fmt.time(ot.date)}</div>
          <div class="ot-pair">
            ${driverChip(ot.overtaking_driver_number)}
            <span class="arrow">▶</span>
            ${driverChip(ot.overtaken_driver_number)}
          </div>
          <div style="color:var(--text-faint);font-size:11px;font-variant-numeric:tabular-nums;font-family:var(--font-mono)">→ P${ot.position}</div>
        </div>
      `).join("")}
    </div>
  `;
  animateCounters(p);
  state.loaded.overtakes = true;
}

/* ------------------- Race control ------------------- */
async function renderRaceControl() {
  const p = panel("control");
  if (state.loaded.control) return;

  setBusy("Loading race control…");
  let msgs = [];
  try { msgs = await api("race_control", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load race control</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  if (!msgs.length) {
    p.innerHTML = `<div class="empty"><strong>No race control messages</strong></div>`;
    state.loaded.control = true;
    return;
  }

  msgs.sort((a, b) => new Date(a.date) - new Date(b.date));

  p.innerHTML = `
    <h2 class="section-title">Race control &middot; ${msgs.length} messages</h2>
    <div class="rc-list">
      ${msgs.map((m) => {
        const flagCls = m.flag ? `flag-${m.flag.replace(/\s+/g, "_")}` : "";
        const catCls = m.category ? `cat-${(m.category + "").replace(/\s+/g, "")}` : "";
        const driver = m.driver_number ? state.driversByNum[m.driver_number] : null;
        const driverTag = driver
          ? `<span class="num-badge" style="--team:${teamColor(driver)};margin-right:6px" data-driver="${driver.driver_number}">${driver.driver_number}</span>${driver.name_acronym || ""} `
          : "";
        return `
          <div class="rc-row ${flagCls} ${catCls}">
            <div class="ts">${fmt.time(m.date)}</div>
            <div class="cat">${m.flag || m.category || ""}${m.lap_number ? ` · L${m.lap_number}` : ""}</div>
            <div class="msg">${driverTag}${escapeHtml(m.message || "")}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  state.loaded.control = true;
}

/* ------------------- Radio ------------------- */
async function renderRadio() {
  const p = panel("radio");
  if (state.loaded.radio) return;

  setBusy("Loading team radio…");
  let clips = [];
  try { clips = await api("team_radio", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>No radio for this session</strong></div>`;
    state.loaded.radio = true;
    clearBusy();
    return;
  }
  clearBusy();

  if (!clips.length) {
    p.innerHTML = `<div class="empty"><strong>No team radio recorded</strong></div>`;
    state.loaded.radio = true;
    return;
  }

  clips.sort((a, b) => new Date(a.date) - new Date(b.date));

  const counts = {};
  for (const c of clips) counts[c.driver_number] = (counts[c.driver_number] || 0) + 1;
  const driverNums = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);

  p.innerHTML = `
    <h2 class="section-title">Team radio &middot; ${clips.length} clips</h2>
    <div class="radio-filter" id="radio-filter">
      <span class="chip active" data-num="all">
        <span class="dot" style="background:var(--text)"></span>
        <span>All</span>
        <span style="color:var(--text-faint);font-weight:600">${clips.length}</span>
      </span>
      ${driverNums.map((num) => {
        const d = state.driversByNum[num];
        const tc = teamColor(d);
        return `
          <span class="chip" data-num="${num}" style="--team:${tc}">
            <span class="dot" style="background:${tc}"></span>
            <span data-driver="${num}">${d?.name_acronym || num}</span>
            <span style="color:var(--text-faint);font-weight:600">${counts[num]}</span>
          </span>
        `;
      }).join("")}
    </div>
    <div class="radio-list" id="radio-list">
      ${clips.map(radioRow).join("")}
    </div>
  `;

  const filter = document.getElementById("radio-filter");
  const list = document.getElementById("radio-list");
  filter.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip || e.target.closest("[data-driver]")) return;
    filter.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    const num = chip.dataset.num;
    const filtered = num === "all" ? clips : clips.filter((c) => String(c.driver_number) === num);
    list.innerHTML = filtered.map(radioRow).join("");
  });

  state.loaded.radio = true;
}

function radioRow(c) {
  const d = state.driversByNum[c.driver_number];
  const tc = teamColor(d);
  const initials = d?.name_acronym || String(c.driver_number);
  return `
    <div class="radio-row" style="--team:${tc}">
      <div class="radio-driver" data-driver="${c.driver_number}">
        <img src="${d?.headshot_url || ""}" alt="" data-initials="${initials}" data-bg="${tc}" />
        <div>
          <div class="name">${d?.name_acronym || c.driver_number}</div>
          <div class="sub">${d?.team_name || ""}</div>
        </div>
      </div>
      <div class="radio-audio">
        <span class="ts">${fmt.time(c.date)}</span>
        <audio controls preload="none" src="${c.recording_url}"></audio>
      </div>
    </div>
  `;
}

/* ------------------- Weather ------------------- */
async function renderWeather() {
  const p = panel("weather");
  if (state.loaded.weather) return;

  setBusy("Loading weather…");
  let wx = [];
  try { wx = await api("weather", { session_key: state.sessionKey }); }
  catch (e) {
    p.innerHTML = `<div class="empty"><strong>Couldn't load weather</strong>${e.message}</div>`;
    clearBusy();
    return;
  }
  clearBusy();

  if (!wx.length) {
    p.innerHTML = `<div class="empty"><strong>No weather data</strong></div>`;
    state.loaded.weather = true;
    return;
  }

  wx.sort((a, b) => new Date(a.date) - new Date(b.date));
  const last = wx[wx.length - 1];
  const avg = (key) => {
    const vals = wx.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const max = (key) => {
    const vals = wx.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? Math.max(...vals) : null;
  };
  const rainAny = wx.some((r) => r.rainfall && r.rainfall > 0);

  p.innerHTML = `
    <h2 class="section-title">Weather summary</h2>
    <div class="weather-grid">
      <div class="card">
        <div class="label">Air temp</div>
        <div class="stat"><span class="v">${last.air_temperature?.toFixed(1) ?? "—"}</span><span class="u">°C now</span></div>
        <div class="label" style="margin-top:6px">Avg ${avg("air_temperature")?.toFixed(1) ?? "—"}°C</div>
      </div>
      <div class="card">
        <div class="label">Track temp</div>
        <div class="stat"><span class="v">${last.track_temperature?.toFixed(1) ?? "—"}</span><span class="u">°C now</span></div>
        <div class="label" style="margin-top:6px">Peak ${max("track_temperature")?.toFixed(1) ?? "—"}°C</div>
      </div>
      <div class="card">
        <div class="label">Humidity</div>
        <div class="stat"><span class="v">${last.humidity?.toFixed(0) ?? "—"}</span><span class="u">% now</span></div>
        <div class="label" style="margin-top:6px">Avg ${avg("humidity")?.toFixed(0) ?? "—"}%</div>
      </div>
      <div class="card">
        <div class="label">Rainfall</div>
        <div class="stat"><span class="v" style="color:${rainAny ? "var(--blue)" : "var(--text)"}">${rainAny ? "Yes" : "No"}</span></div>
        <div class="label" style="margin-top:6px">Wind ${last.wind_speed?.toFixed(1) ?? "—"} m/s</div>
      </div>
    </div>

    <h2 class="section-title">Temperature</h2>
    <div class="wx-chart-wrap"><canvas id="wx-temp-chart"></canvas></div>

    <h2 class="section-title" style="margin-top:18px">Humidity & wind</h2>
    <div class="wx-chart-wrap"><canvas id="wx-wind-chart"></canvas></div>
  `;

  state._charts ||= {};
  const labels = wx.map((r) => new Date(r.date));

  state._charts["wx-temp-chart"] = new Chart(document.getElementById("wx-temp-chart").getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Air (°C)", data: wx.map((r) => r.air_temperature), borderColor: "#4cc9f0", backgroundColor: "rgba(76,201,240,0.15)", fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 },
        { label: "Track (°C)", data: wx.map((r) => r.track_temperature), borderColor: "#e10600", backgroundColor: "rgba(225,6,0,0.15)", fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: weatherChartOpts("°C"),
  });

  state._charts["wx-wind-chart"] = new Chart(document.getElementById("wx-wind-chart").getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Humidity (%)", data: wx.map((r) => r.humidity), borderColor: "#b388ff", backgroundColor: "rgba(179,136,255,0.10)", fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2, yAxisID: "y" },
        { label: "Wind (m/s)", data: wx.map((r) => r.wind_speed), borderColor: "#ffd60a", backgroundColor: "rgba(255,214,10,0.08)", tension: 0.25, pointRadius: 0, borderWidth: 2, yAxisID: "y1" },
      ],
    },
    options: weatherChartOpts(null, true),
  });

  state.loaded.weather = true;
}

function weatherChartOpts(unit, dual = false) {
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "nearest", intersect: false },
    scales: {
      x: {
        type: "category",
        ticks: {
          color: "#9aa3b2", maxTicksLimit: 8,
          callback: function (val) {
            const d = this.getLabelForValue(val);
            const dt = d instanceof Date ? d : new Date(d);
            return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          },
        },
        grid: { color: "rgba(255,255,255,0.04)" },
      },
      y: { ticks: { color: "#9aa3b2" }, grid: { color: "rgba(255,255,255,0.05)" }, title: unit ? { display: true, text: unit, color: "#9aa3b2" } : undefined },
    },
    plugins: {
      legend: { labels: { color: "#e7e9ee", boxWidth: 12, boxHeight: 3 } },
      tooltip: { backgroundColor: "#11141a", borderColor: "#2a2f3a", borderWidth: 1 },
    },
  };
  if (dual) base.scales.y1 = { position: "right", ticks: { color: "#9aa3b2" }, grid: { drawOnChartArea: false } };
  return base;
}

/* ------------------- Driver side panel ------------------- */
async function openDriverPanel(num) {
  const driver = state.driversByNum[num];
  if (!driver) return;
  captureFocus();
  const tc = teamColor(driver);
  const body = document.getElementById("side-panel-body");
  document.getElementById("side-panel-title").textContent = driver.name_acronym || `#${num}`;
  body.innerHTML = `
    <div class="sp-hero" style="--team:${tc}">
      <img src="${driver.headshot_url || ""}" alt="" data-initials="${driver.name_acronym || ""}" data-bg="${tc}" />
      <div>
        <div class="name">${driver.full_name || driver.broadcast_name}</div>
        <div class="team">${driver.team_name || ""}</div>
      </div>
      <div class="num">${num}</div>
    </div>
    <div class="sp-section sp-loading">
      <div class="skeleton skel-line" style="margin:6px 0"></div>
      <div class="skeleton skel-line" style="margin:6px 0;width:80%"></div>
      <div class="skeleton skel-line" style="margin:6px 0;width:60%"></div>
    </div>
  `;
  document.body.classList.add("side-panel-open");
  document.getElementById("side-panel").setAttribute("aria-hidden", "false");
  setTimeout(() => document.getElementById("side-panel-close")?.focus(), 80);

  // Compute summary from cached data + on-demand fetches
  let laps = [], stints = [], pits = [], overtakes = [], radio = [];
  try {
    [laps, stints, pits, overtakes, radio] = await Promise.all([
      api("laps", { session_key: state.sessionKey }).catch(() => []),
      api("stints", { session_key: state.sessionKey }).catch(() => []),
      api("pit", { session_key: state.sessionKey }).catch(() => []),
      api("overtakes", { session_key: state.sessionKey }).catch(() => []),
      api("team_radio", { session_key: state.sessionKey }).catch(() => []),
    ]);
  } catch {}

  const myLaps = laps.filter((l) => l.driver_number === num);
  let best = null, s1 = Infinity, s2 = Infinity, s3 = Infinity, trap = 0;
  for (const l of myLaps) {
    if (l.lap_duration != null && (!best || l.lap_duration < best.lap_duration)) best = l;
    if (l.duration_sector_1 != null && l.duration_sector_1 < s1) s1 = l.duration_sector_1;
    if (l.duration_sector_2 != null && l.duration_sector_2 < s2) s2 = l.duration_sector_2;
    if (l.duration_sector_3 != null && l.duration_sector_3 < s3) s3 = l.duration_sector_3;
    const tr = Math.max(l.i1_speed || 0, l.i2_speed || 0, l.st_speed || 0);
    if (tr > trap) trap = tr;
  }
  const myStints = stints.filter((s) => s.driver_number === num);
  const myPits = pits.filter((p) => p.driver_number === num);
  const made = overtakes.filter((o) => o.overtaking_driver_number === num).length;
  const lost = overtakes.filter((o) => o.overtaken_driver_number === num).length;
  const myRadio = radio.filter((r) => r.driver_number === num);

  const section = (title, rows) => `
    <div class="sp-section">
      <h4>${title}</h4>
      ${rows.map((r) => `<div class="sp-row"><span class="k">${r[0]}</span><span class="v">${r[1]}</span></div>`).join("")}
    </div>
  `;

  body.innerHTML = `
    <div class="sp-hero" style="--team:${tc}">
      <img src="${driver.headshot_url || ""}" alt="" data-initials="${driver.name_acronym || ""}" data-bg="${tc}" />
      <div>
        <div class="name">${driver.full_name || driver.broadcast_name}</div>
        <div class="team">${driver.team_name || ""}</div>
      </div>
      <div class="num">${num}</div>
    </div>
    ${section("Pace", [
      ["Best lap", best ? `${fmt.duration(best.lap_duration)} <span style="color:var(--text-faint);font-weight:600">L${best.lap_number}</span>` : "—"],
      ["Sector 1", isFinite(s1) ? s1.toFixed(3) + " s" : "—"],
      ["Sector 2", isFinite(s2) ? s2.toFixed(3) + " s" : "—"],
      ["Sector 3", isFinite(s3) ? s3.toFixed(3) + " s" : "—"],
      ["Top speed", trap > 0 ? trap + " km/h" : "—"],
      ["Laps completed", myLaps.length || "—"],
    ])}
    ${section("Strategy", [
      ["Stints", myStints.length || "—"],
      ["Compounds", myStints.length ? myStints.map((s) => (s.compound || "?")[0]).join(" / ") : "—"],
      ["Pit stops", myPits.length || "—"],
      ["Fastest stop", myPits.length ? Math.min(...myPits.filter(p => p.pit_duration != null).map((p) => p.pit_duration)).toFixed(2) + " s" : "—"],
    ])}
    ${section("Battle", [
      ["Overtakes made", made],
      ["Positions lost", lost],
      ["Net change", `${made - lost > 0 ? "+" : ""}${made - lost}`],
      ["Radio clips", myRadio.length],
    ])}
  `;
}

function closeDriverPanel() {
  document.body.classList.remove("side-panel-open");
  document.getElementById("side-panel").setAttribute("aria-hidden", "true");
  restoreFocus();
}

/* ------------------- Calendar slide-over ------------------- */
function meetingStatus(m) {
  if (!m) return "unknown";
  if (m.is_cancelled) return "cancelled";
  const now = Date.now();
  const start = new Date(m.date_start).getTime();
  const end = new Date(m.date_end).getTime();
  if (now < start) return "upcoming";
  if (now > end) return "completed";
  return "live";
}

function openCalendar() {
  captureFocus();
  document.body.classList.add("calendar-open");
  const panel = document.getElementById("calendar-panel");
  panel.setAttribute("aria-hidden", "false");
  renderCalendar();
  // Move focus to close button after the slide-in completes
  setTimeout(() => document.getElementById("calendar-close")?.focus(), 80);
}
function closeCalendar() {
  document.body.classList.remove("calendar-open");
  document.getElementById("calendar-panel").setAttribute("aria-hidden", "true");
  restoreFocus();
}

function renderCalendar() {
  document.getElementById("calendar-year").textContent = state.year || "";
  const body = document.getElementById("calendar-body");
  const meetings = (state.meetings || []).slice().sort(
    (a, b) => new Date(a.date_start) - new Date(b.date_start)
  );
  if (!meetings.length) {
    body.innerHTML = `<div class="cal-empty">No meetings for this season.</div>`;
    return;
  }

  const nextIdx = meetings.findIndex((m) => meetingStatus(m) === "upcoming");

  const past = [];
  const upcoming = [];
  for (const m of meetings) {
    const st = meetingStatus(m);
    if (st === "completed" || st === "cancelled" || st === "live") past.push(m);
    else upcoming.push(m);
  }

  const rowHtml = (m) => {
    const st = meetingStatus(m);
    const isCurrent = m.meeting_key === state.meetingKey;
    const isNext = nextIdx >= 0 && meetings[nextIdx].meeting_key === m.meeting_key;
    const date = new Date(m.date_end);
    const day = date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const flag = m.country_flag
      ? `<img class="cal-flag" src="${m.country_flag}" alt="" onerror="this.style.visibility='hidden'" />`
      : `<span class="cal-flag" aria-hidden="true"></span>`;
    const badgeText = st === "completed" ? "DONE"
      : st === "cancelled" ? "CANCELLED"
      : st === "live" ? "LIVE"
      : "UPCOMING";
    const dot = st === "live" ? `<span class="dot"></span>` : "";
    return `
      <div class="cal-row ${isCurrent ? "current" : ""} ${isNext ? "next" : ""}"
           data-meeting-key="${m.meeting_key}"
           data-status="${st}"
           role="button" tabindex="0">
        ${flag}
        <div class="cal-info">
          <div class="cal-name">${m.meeting_name}</div>
          <div class="cal-loc">${m.country_name}${m.circuit_short_name ? ` · ${m.circuit_short_name}` : ""}</div>
        </div>
        <div class="cal-when">
          <div class="cal-day">${day}</div>
          <div class="cal-time">${time}</div>
        </div>
        <span class="cal-status ${st}">${dot}${badgeText}</span>
      </div>
    `;
  };

  let html = "";
  if (upcoming.length) {
    html += `<div class="cal-divider">Upcoming</div>`;
    html += upcoming.map(rowHtml).join("");
  }
  if (past.length) {
    html += `<div class="cal-divider">Past · This season</div>`;
    html += past.reverse().map(rowHtml).join("");
  }
  body.innerHTML = html;
}

/* ------------------- Command palette ------------------- */
function buildPaletteItems() {
  const items = [];
  for (const [key, meta] of Object.entries(TAB_META)) {
    items.push({ kind: "section", label: meta.label, ctx: meta.group, action: () => switchTab(key) });
  }
  for (const d of state.drivers) {
    items.push({
      kind: "driver", label: `${d.name_acronym || d.driver_number} — ${d.full_name || d.broadcast_name}`,
      ctx: d.team_name || "",
      tc: teamColor(d),
      action: () => openDriverPanel(d.driver_number),
    });
  }
  for (const m of state.meetings) {
    items.push({
      kind: "meeting", label: `${m.country_name} — ${m.meeting_name}`,
      ctx: `${m.year}`,
      action: async () => { document.getElementById("meeting-select").value = m.meeting_key; await selectMeeting(m.meeting_key); },
    });
  }
  for (const y of YEARS) {
    items.push({ kind: "year", label: `${y}`, ctx: "switch year", action: async () => { document.getElementById("year-select").value = y; await selectYear(y); } });
  }
  return items;
}

function openPalette() {
  captureFocus();
  document.body.classList.add("cmdk-open");
  const cmd = document.getElementById("cmdk");
  cmd.setAttribute("aria-hidden", "false");
  const input = document.getElementById("cmdk-input");
  input.value = "";
  state._paletteItems = buildPaletteItems();
  state._paletteIndex = 0;
  renderPaletteResults("");
  setTimeout(() => input.focus(), 30);
}

function closePalette() {
  document.body.classList.remove("cmdk-open");
  document.getElementById("cmdk").setAttribute("aria-hidden", "true");
  restoreFocus();
}

function renderPaletteResults(query) {
  const list = document.getElementById("cmdk-results");
  const q = query.trim().toLowerCase();
  let items = state._paletteItems || [];
  if (q) {
    items = items.filter((it) => (it.label + " " + (it.ctx || "")).toLowerCase().includes(q));
  } else {
    items = items.slice(0, 30);
  }
  state._paletteFiltered = items;
  state._paletteIndex = 0;
  if (!items.length) {
    list.innerHTML = `<li class="cmdk-empty">No results</li>`;
    return;
  }
  list.innerHTML = items.map((it, i) => `
    <li role="option" data-i="${i}" class="${i === 0 ? "active" : ""}" style="${it.tc ? `--team:${it.tc};` : ""}">
      <span class="kind">${it.kind}</span>
      ${it.tc ? `<span class="swatch"></span>` : ""}
      <span class="label">${escapeHtml(it.label)}</span>
      <span class="ctx">${escapeHtml(it.ctx || "")}</span>
    </li>
  `).join("");
}

function paletteMove(delta) {
  const items = state._paletteFiltered || [];
  if (!items.length) return;
  state._paletteIndex = (state._paletteIndex + delta + items.length) % items.length;
  const list = document.getElementById("cmdk-results");
  list.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("active", i === state._paletteIndex);
    if (i === state._paletteIndex) li.scrollIntoView({ block: "nearest" });
  });
}

function paletteActivate() {
  const items = state._paletteFiltered || [];
  const it = items[state._paletteIndex];
  if (it) {
    closePalette();
    it.action();
  }
}

/* ------------------- Theme + Drawer ------------------- */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("pitwall.theme", t); } catch {}
  applyChartDefaults();
  restyleAllCharts();
  // aria-pressed on the toggle reflects current state
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.setAttribute("aria-pressed", String(t === "light"));
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
}
function loadTheme() {
  let t = "dark";
  try {
    t = localStorage.getItem("pitwall.theme") ||
        localStorage.getItem("openf1.theme") || // legacy
        (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  } catch {}
  applyTheme(t);
}

function openDrawer() {
  document.body.classList.add("drawer-open");
  document.getElementById("drawer-toggle").setAttribute("aria-expanded", "true");
}
function closeDrawer() {
  document.body.classList.remove("drawer-open");
  document.getElementById("drawer-toggle").setAttribute("aria-expanded", "false");
}

/* ------------------- URL routing ------------------- */
function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return {
    year: params.get("year") ? +params.get("year") : null,
    meeting: params.get("meeting") ? +params.get("meeting") : null,
    session: params.get("session") ? +params.get("session") : null,
    tab: params.get("tab") || null,
    driver: params.get("driver") ? +params.get("driver") : null,
  };
}

function writeHash() {
  if (state._skipUrl) return;
  const params = new URLSearchParams();
  if (state.year) params.set("year", state.year);
  if (state.meetingKey) params.set("meeting", state.meetingKey);
  if (state.sessionKey) params.set("session", state.sessionKey);
  if (state.activeTab) params.set("tab", state.activeTab);
  const hash = "#" + params.toString();
  if (hash !== location.hash) {
    history.replaceState(null, "", hash);
  }
}

/* ------------------- Wiring ------------------- */
async function selectSession(sessionKey) {
  state.sessionKey = +sessionKey;
  state.session = state.sessions.find((s) => s.session_key == sessionKey);
  invalidateLoaded();
  await loadDrivers(sessionKey);
  updateTopstrip();
  writeHash();
  await renderTab(state.activeTab);
}

async function selectMeeting(meetingKey) {
  state.meetingKey = +meetingKey;
  state.meeting = state.meetings.find((m) => m.meeting_key == meetingKey);
  const sessions = await loadSessions(meetingKey);
  if (sessions.length) {
    const def = pickDefaultSession(sessions);
    $("#session-select").value = def.session_key;
    await selectSession(def.session_key);
  }
}

async function selectYear(year) {
  state.year = +year;
  const meetings = await loadMeetings(year);
  if (!meetings.length) { setError(`No meetings found for ${year}`); return; }
  const def = pickDefaultMeeting(meetings);
  $("#meeting-select").value = def.meeting_key;
  await selectMeeting(def.meeting_key);
}

function bindEvents() {
  $("#year-select").addEventListener("change", (e) => selectYear(e.target.value));
  $("#meeting-select").addEventListener("change", (e) => selectMeeting(e.target.value));
  $("#session-select").addEventListener("change", (e) => selectSession(e.target.value));

  document.querySelectorAll(".navlist button").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });

  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);

  document.getElementById("drawer-toggle").addEventListener("click", () => {
    document.body.classList.contains("drawer-open") ? closeDrawer() : openDrawer();
  });
  document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);

  // Universal driver click handler
  document.body.addEventListener("click", (e) => {
    const target = e.target.closest("[data-driver]");
    if (!target) return;
    const num = +target.dataset.driver;
    if (!Number.isFinite(num)) return;
    e.stopPropagation();
    openDriverPanel(num);
  });

  // Image load-fallback delegation (replaces inline onerror=)
  document.body.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.dataset && t.dataset.initials) {
      fallbackImg(t);
    }
  }, true);

  // Schedule-row jump-to-session delegation (replaces inline onclick=)
  document.body.addEventListener("click", (e) => {
    const row = e.target.closest("[data-jump-session]");
    if (!row) return;
    const key = +row.dataset.jumpSession;
    if (!Number.isFinite(key)) return;
    const sel = document.getElementById("session-select");
    if (sel) {
      sel.value = key;
      selectSession(key);
    }
  });
  document.body.addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-jump-session]");
    if (!row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
    }
  });

  document.getElementById("side-panel-close").addEventListener("click", closeDriverPanel);
  document.getElementById("side-panel-overlay").addEventListener("click", closeDriverPanel);

  // Calendar
  document.getElementById("calendar-btn").addEventListener("click", openCalendar);
  document.getElementById("calendar-close").addEventListener("click", closeCalendar);
  document.getElementById("calendar-overlay").addEventListener("click", closeCalendar);
  const calendarBody = document.getElementById("calendar-body");
  const jumpToMeeting = (row) => {
    const key = +row.dataset.meetingKey;
    if (!Number.isFinite(key)) return;
    const sel = document.getElementById("meeting-select");
    sel.value = key;
    selectMeeting(key);
    closeCalendar();
  };
  calendarBody.addEventListener("click", (e) => {
    const row = e.target.closest("[data-meeting-key]");
    if (row) jumpToMeeting(row);
  });
  calendarBody.addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-meeting-key]");
    if (!row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      jumpToMeeting(row);
    }
  });

  // Command palette
  document.getElementById("cmdk-trigger").addEventListener("click", openPalette);
  document.getElementById("cmdk-overlay").addEventListener("click", closePalette);
  const cInput = document.getElementById("cmdk-input");
  cInput.addEventListener("input", (e) => renderPaletteResults(e.target.value));
  cInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); paletteMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteMove(-1); }
    else if (e.key === "Enter") { e.preventDefault(); paletteActivate(); }
  });
  document.getElementById("cmdk-results").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    state._paletteIndex = +li.dataset.i;
    paletteActivate();
  });

  // Global keyboard
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      document.body.classList.contains("cmdk-open") ? closePalette() : openPalette();
      return;
    }
    if (e.key === "Escape") {
      if (document.body.classList.contains("cmdk-open")) closePalette();
      else if (document.body.classList.contains("calendar-open")) closeCalendar();
      else if (document.body.classList.contains("side-panel-open")) closeDriverPanel();
      else if (document.body.classList.contains("drawer-open")) closeDrawer();
      return;
    }
    // Focus trap: keep Tab cycling within the active dialog
    if (e.key === "Tab") {
      const root =
        document.body.classList.contains("cmdk-open") ? document.getElementById("cmdk") :
        document.body.classList.contains("calendar-open") ? document.getElementById("calendar-panel") :
        document.body.classList.contains("side-panel-open") ? document.getElementById("side-panel") :
        null;
      if (root) trapFocus(root, e);
    }
  });

  window.addEventListener("hashchange", applyHashRoute);
}

async function applyHashRoute() {
  const r = parseHash();
  state._skipUrl = true;
  try {
    if (r.year && r.year !== state.year) {
      $("#year-select").value = r.year;
      await selectYear(r.year);
    }
    if (r.meeting && r.meeting !== state.meetingKey) {
      $("#meeting-select").value = r.meeting;
      await selectMeeting(r.meeting);
    }
    if (r.session && r.session !== state.sessionKey) {
      $("#session-select").value = r.session;
      await selectSession(r.session);
    }
    if (r.tab && r.tab in TAB_META && r.tab !== state.activeTab) {
      switchTab(r.tab, { skipUrl: true });
    }
    if (r.driver && state.driversByNum[r.driver]) {
      openDriverPanel(r.driver);
    }
  } finally {
    state._skipUrl = false;
    writeHash();
  }
}

function startCountdownTicker() {
  if (state._cdTimer) return;
  const tick = () => {
    // Compact countdowns sprinkled in the topstrip / empty states.
    document.querySelectorAll("[data-countdown-to]").forEach((el) => {
      el.textContent = fmt.countdown(el.dataset.countdownTo);
    });
    // Per-unit boxes inside the upcoming hero.
    const target = state.session?.date_start;
    if (target) {
      const ms = Math.max(0, new Date(target).getTime() - Date.now());
      const d = Math.floor(ms / 86400000);
      const h = Math.floor((ms % 86400000) / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const map = { d, h, m, s };
      document.querySelectorAll("[data-cd-unit]").forEach((el) => {
        const u = el.dataset.cdUnit;
        if (map[u] != null) el.textContent = map[u];
      });
      // If a session just transitioned (upcoming → live → completed), re-render
      // — but only when no render is currently in flight, to avoid clobbering.
      const newStatus = sessionStatus();
      if (state._lastStatus && state._lastStatus !== newStatus && !state._renderingTab) {
        invalidateLoaded();
        updateTopstrip();
        renderTab(state.activeTab);
      }
      state._lastStatus = newStatus;
    }
  };
  state._cdTimer = setInterval(tick, CONFIG.COUNTDOWN_TICK_MS);
  state._lastStatus = sessionStatus();
}

async function init() {
  loadTheme();
  populateYearSelect();
  bindEvents();
  updateTopstrip();
  startCountdownTicker();

  const r = parseHash();
  state._skipUrl = true;

  // Decide year
  let year = r.year && YEARS.includes(r.year) ? r.year : null;
  if (!year) {
    for (const y of YEARS) {
      try {
        const meetings = await api("meetings", { year: y });
        if (meetings.length) { year = y; break; }
      } catch {}
    }
  }
  if (!year) { setError("Couldn't reach the OpenF1 API."); state._skipUrl = false; return; }

  $("#year-select").value = year;
  state.year = year;
  const meetings = await loadMeetings(year);
  let meeting = r.meeting && meetings.find((m) => m.meeting_key === r.meeting) ? meetings.find((m) => m.meeting_key === r.meeting) : pickDefaultMeeting(meetings);
  if (!meeting) { setError("No meetings found"); state._skipUrl = false; return; }
  $("#meeting-select").value = meeting.meeting_key;
  state.meetingKey = meeting.meeting_key;
  state.meeting = meeting;
  const sessions = await loadSessions(meeting.meeting_key);
  let session = r.session && sessions.find((s) => s.session_key === r.session) ? sessions.find((s) => s.session_key === r.session) : pickDefaultSession(sessions);
  if (!session) { setError("No sessions found"); state._skipUrl = false; return; }
  $("#session-select").value = session.session_key;
  state.sessionKey = session.session_key;
  state.session = session;
  invalidateLoaded();
  await loadDrivers(session.session_key);

  if (r.tab && r.tab in TAB_META) state.activeTab = r.tab;
  document.querySelectorAll(".navlist button").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === state.activeTab ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${state.activeTab}`);
  });
  updateTopstrip();

  state._skipUrl = false;
  writeHash();
  await renderTab(state.activeTab);

  if (r.driver && state.driversByNum[r.driver]) openDriverPanel(r.driver);
}

window.fallbackImg = fallbackImg;

/* ------------------- Access gate ------------------- */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unlock() {
  document.body.classList.remove("locked");
  document.body.classList.add("unlocked");
  // After CSS transition, fully remove the gate from layout
  setTimeout(() => {
    const gate = document.getElementById("gate");
    if (gate) gate.style.display = "none";
  }, 400);
}

function lock() {
  try { localStorage.removeItem("pitwall.access"); } catch {}
  location.reload();
}

async function safeInit() {
  try {
    await init();
  } catch (err) {
    console.error("init failed", err);
    setError("Failed to load — refresh the page.");
  }
}

async function bootstrapGate() {
  let stored = null;
  try { stored = localStorage.getItem("pitwall.access"); } catch {}
  if (stored === ACCESS_KEY_HASH) {
    unlock();
    safeInit();
    return;
  }

  const form = document.getElementById("gate-form");
  const input = document.getElementById("gate-input");
  const error = document.getElementById("gate-error");
  const submit = form.querySelector(".gate-submit");
  const gate = document.getElementById("gate");

  setTimeout(() => input?.focus(), 80);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = input.value.trim();
    if (!val) return;
    submit.disabled = true;
    error.textContent = "";
    try {
      const h = await sha256Hex(val);
      if (h === ACCESS_KEY_HASH) {
        try { localStorage.setItem("pitwall.access", h); } catch {}
        unlock();
        safeInit();
      } else {
        gate.classList.remove("shake");
        // force reflow so the animation can replay
        void gate.offsetWidth;
        gate.classList.add("shake");
        error.textContent = "Wrong access key — try again";
        input.select();
      }
    } finally {
      submit.disabled = false;
    }
  });

  // Bind lock button (works once unlocked)
  const lockBtn = document.getElementById("lock-btn");
  if (lockBtn) lockBtn.addEventListener("click", lock);
}

// Lock button needs to bind after init runs (it lives in the sidebar).
// Add a deferred binding for safety.
document.addEventListener("click", (e) => {
  if (e.target.closest("#lock-btn") && document.body.classList.contains("unlocked")) {
    e.preventDefault();
    lock();
  }
});

bootstrapGate();
