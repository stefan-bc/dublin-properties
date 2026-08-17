import { shortSize } from './lib.js';

// Plain fetch against PostgREST instead of @supabase/supabase-js — this
// dashboard only ever runs simple SELECTs with the public anon key. The SDK
// bundles Auth, Realtime (a WebSocket client), and Storage, none of which
// anything here touches; that's dead weight worth cutting.
const REST_URL = `${SUPABASE_URL}/rest/v1`;
const REST_HEADERS = { apikey: SUPABASE_ANON_KEY };

// exactCount asks PostgREST for the true total matching the filter (via a
// Content-Range response header) in the same request as the capped page of
// rows — one round trip, not two. Needed so a capped result set can still
// show its real total instead of just the page size (see runFilteredView).
// `signal` lets a caller abort a superseded request (an older search is still
// hogging a browser connection slot while the newest keystroke's query is
// queued behind it); an aborted request resolves to a silent no-op so no
// caller has to special-case it — the viewRequestId guards already make
// stale results harmless.
async function pg(table, params, { exactCount = false, signal, range } = {}) {
  // URLSearchParams stringifies a JS `null` as the literal text "null"
  // rather than omitting it — e.g. runFilteredView's `p_term: term || null`
  // would otherwise send p_term=null as a real search term, which
  // sales_stats' `coalesce(p_term, '') <> ''` treats as non-empty and
  // filters every row out. Drop null/undefined entries so an absent filter
  // is actually absent, letting the RPC's own `default null` apply.
  const definedParams = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
  const qs = new URLSearchParams(definedParams).toString();
  const headers = { ...REST_HEADERS };
  if (exactCount) headers.Prefer = 'count=exact';
  // Fetches exactly one row at a known sorted index (e.g. a median point)
  // via the Range header instead of pulling every row to compute it
  // client-side — same technique analysis/generate-report.mjs uses.
  if (range) headers.Range = range;
  try {
    const res = await fetch(`${REST_URL}/${table}?${qs}`, { headers, signal });
    if (!res.ok) return { data: null, error: await res.text(), count: null };
    const data = await res.json();
    if (!exactCount) return { data, error: null, count: null };
    const total = res.headers.get('content-range')?.split('/')[1];
    return { data, error: null, count: total && total !== '*' ? Number.parseInt(total, 10) : data.length };
  } catch (e) {
    if (e.name === 'AbortError') return { data: null, error: null, count: null };
    throw e;
  }
}

const eur = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const eurCompact = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const quarterFmt = (isoDate) => {
  const d = new Date(isoDate);
  return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

// Matches Postgres's date_trunc('quarter', sale_date): first day of the
// quarter the date falls in, as an ISO date string — the same key
// district_quarterly/sales_quarterly group their rows by.
const quarterKey = (isoDate) => {
  const d = new Date(isoDate);
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)).toISOString().slice(0, 10);
};

// A quarter with too few sales gives a noisy median — a single sale in a
// quiet quarter/district makes that quarter's "median" just that one price,
// which can swing the estimate a long way from a real trend.
const ESTIMATE_MIN_SAMPLE = 5;

// Projects a past sale's price forward using how much prices in its area have
// moved since. Prefers the sold district's own trend; falls back to the
// Dublin-wide trend when the district doesn't have enough sales in the
// relevant quarter(s) to trust. Returns null if neither series has enough
// data to say anything.
function estimateCurrentValue(latestSale, districtQuarters, cityQuarters) {
  if (!latestSale?.price || !latestSale.sale_date) return null;
  const saleQuarter = quarterKey(latestSale.sale_date);

  const pick = (series) => {
    if (!series.length) return null;
    const base = series.find((r) => r.quarter === saleQuarter);
    const current = series[series.length - 1]; // series ordered by quarter asc
    if (!base || !current) return null;
    if (base.sale_count < ESTIMATE_MIN_SAMPLE || current.sale_count < ESTIMATE_MIN_SAMPLE) return null;
    return { base, current };
  };

  const districtPick = pick(districtQuarters);
  const picked = districtPick ?? pick(cityQuarters);
  if (!picked) return null;

  const growth = picked.current.median_price / picked.base.median_price;
  return {
    value: latestSale.price * growth,
    growthPct: (growth - 1) * 100,
    basis: picked === districtPick ? latestSale.postal_district : 'Dublin-wide',
    saleQuarter,
    asOfQuarter: picked.current.quarter,
  };
}

// The PPR source register mostly uses "New/Second-Hand Dwelling house
// /Apartment", but a handful of rows (~23 out of 249k) record the same two
// categories in Irish instead ("Teach/Árasán Cónaithe Nua/Atháimhe"), plus
// one row where the source CSV itself has mis-encoded characters. All of
// these fold into the same two plain-English labels everywhere.
const PROPERTY_TYPE_LABELS = {
  'New Dwelling house /Apartment': 'New Build',
  'Second-Hand Dwelling house /Apartment': 'Resale',
  'Teach/Árasán Cónaithe Nua': 'New Build',
  'Teach/?ras?n C?naithe Nua': 'New Build',
  'Teach/Árasán Cónaithe Atháimhe': 'Resale',
};
function propertyTypeLabel(raw) {
  return PROPERTY_TYPE_LABELS[raw] || raw;
}

// Groups aggregate-view rows (raw property_type, one row per source string)
// into the merged English labels above. The median is a count-weighted mean
// of the sub-medians — not a true recomputed median, but with the Irish-
// language variants at <0.1% of rows the difference is immaterial, and this
// only runs against ~4 pre-aggregated rows, not the full dataset.
function mergeTypeRows(rows) {
  const byLabel = new Map();
  for (const r of rows) {
    const label = propertyTypeLabel(r.property_type);
    if (!byLabel.has(label)) byLabel.set(label, { property_type: label, totalPrice: 0, sale_count: 0 });
    const entry = byLabel.get(label);
    entry.totalPrice += r.median_price * r.sale_count;
    entry.sale_count += r.sale_count;
  }
  return [...byLabel.values()].map((e) => ({
    property_type: e.property_type,
    median_price: e.totalPrice / e.sale_count,
  }));
}

// Same merge, but keeps the underlying raw source strings per label so the
// property-type <select> can filter on all of them at once (see runFilteredView).
function buildTypeOptions(rows) {
  const byLabel = new Map();
  for (const r of rows) {
    const label = propertyTypeLabel(r.property_type);
    if (!byLabel.has(label)) byLabel.set(label, { label, values: [], sale_count: 0 });
    const entry = byLabel.get(label);
    entry.values.push(r.property_type);
    entry.sale_count += r.sale_count;
  }
  return [...byLabel.values()].sort((a, b) => b.sale_count - a.sale_count);
}

// % of sales that are new-builds — from pre-aggregated {property_type,
// sale_count} rows (the default view's fast path).
function newBuildShareFromCounts(typeRows) {
  let newCount = 0;
  let total = 0;
  for (const r of typeRows) {
    total += r.sale_count;
    if (propertyTypeLabel(r.property_type) === 'New Build') newCount += r.sale_count;
  }
  return total ? Math.round((newCount / total) * 100) : 0;
}

const NEW_BUILD_RAW_TYPES = Object.entries(PROPERTY_TYPE_LABELS)
  .filter(([, label]) => label === 'New Build')
  .map(([raw]) => raw);

// Median price and new-build share, computed live over the same trailing
// window as the "Sales past 12 months" count tile, rather than the all-time
// register (sales_summary/sales_by_type cover 2010-present). An all-time
// median blends 2010 prices in with 2026 ones and would read as "today's
// typical price" when it isn't — the same reasoning loadDefaultView already
// applies to the total-sales tile, extended to the other two so all three
// describe the same period instead of silently mixing timeframes. Cheap
// regardless of table size: two exact-count requests (Content-Range header
// only, ?limit=1 keeps the body trivial) plus one indexed point-fetch for
// the median itself, via pg()'s `range` option — no full-table pull.
async function trailingWindowStats(sinceDate) {
  const base = { sale_date: `gte.${sinceDate}`, not_full_market_price: 'eq.false' };
  const [totalRes, newBuildRes] = await Promise.all([
    pg('sales', { ...base, select: 'id', limit: '1' }, { exactCount: true }),
    pg('sales', {
      ...base,
      select: 'id',
      limit: '1',
      property_type: `in.(${NEW_BUILD_RAW_TYPES.map((t) => `"${t}"`).join(',')})`,
    }, { exactCount: true }),
  ]);
  const total = totalRes.count || 0;
  const newBuildCount = newBuildRes.count || 0;
  if (!total) return { medianPrice: null, newBuildSharePct: 0 };
  const midIdx = Math.floor((total - 1) / 2);
  const priceRes = await pg(
    'sales',
    { ...base, select: 'price', order: 'price.asc' },
    { range: `${midIdx}-${midIdx}` },
  );
  return {
    medianPrice: priceRes.data?.[0]?.price != null ? Number(priceRes.data[0].price) : null,
    newBuildSharePct: Math.round((newBuildCount / total) * 100),
  };
}

// The four stat tiles mean different things depending on the view, so their
// labels are set with the values. Overview: the whole register since 2010.
// Filtered: whatever matches the active search/filters. Address: that single
// property's own record — where "New build share" is meaningless (a house is
// either new-built once or not) and an estimate of today's value says what
// actually matters.
function setStatLabels(mode) {
  const labels = {
    total: document.getElementById('stat-total-label'),
    median: document.getElementById('stat-median-label'),
    newbuild: document.getElementById('stat-newbuild-label'),
    latest: document.getElementById('stat-latest-label'),
  };
  if (mode === 'address') {
    labels.total.textContent = 'Sales recorded';
    labels.median.textContent = 'Latest sale price';
    labels.newbuild.textContent = 'Estimated value today';
    labels.latest.textContent = 'Latest sale recorded';
  } else if (mode === 'filtered') {
    labels.total.textContent = 'Matches';
    labels.median.textContent = 'Median price';
    labels.newbuild.textContent = 'New build share';
    labels.latest.textContent = 'Latest sale recorded';
  } else {
    labels.total.textContent = 'Sales since 2010';
    labels.median.textContent = 'Median price';
    labels.newbuild.textContent = 'New build share';
    labels.latest.textContent = 'Latest sale recorded';
  }
  // The address view hides "Latest sale recorded" (already in the table
  // below) and starts "Estimated value today" hidden too — renderValueEstimate
  // reveals it once the estimate for this address has actually loaded, so a
  // stale figure from whatever address was open before never flashes up.
  document.getElementById('stat-newbuild-tile').hidden = mode === 'address';
  document.getElementById('stat-latest-tile').hidden = mode === 'address';
}

const palette = {
  gridline: '#2c2c2a',
  baseline: '#383835',
  textSecondary: '#c3c2b7',
  textMuted: '#898781',
  series1: '#3987e5',
  series2: '#199e70',
  // Sequential choropleth scale — mirrors the --scale-low/--scale-high CSS
  // vars in style.css (same duplication pattern as the rest of this object;
  // Chart.js/SVG colour options need real values, not custom-property refs).
  scaleLow: '#1e3a5c',
  scaleHigh: '#5fa8f5',
  scaleNoData: '#2c2c2a',
};

// Linear RGB interpolation between two hex colours, t in [0, 1]. Good enough
// for a small sequential ramp between two blues (not spanning hues, so no
// need for perceptual/OKLCH interpolation here).
function lerpColor(hexA, hexB, t) {
  const a = [1, 3, 5].map((i) => parseInt(hexA.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(hexB.slice(i, i + 2), 16));
  const rgb = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${rgb.join(',')})`;
}

Chart.defaults.font.family = '"JetBrains Mono", ui-monospace, monospace';
Chart.defaults.font.size = 12;
Chart.defaults.color = palette.textMuted;
// Object.assign, not a wholesale reassignment: Chart.js's defaults.animation
// object carries internal keys (type/fn/from/to/delay/loop) that its own
// animation-resolution code reads by iterating Object.keys(defaults.animation)
// — replacing the object drops those keys, so any hover colour-transition
// animation (e.g. pointHoverBackgroundColor) resolves with no interpolator
// function, throws on its first tick, and permanently kills Chart.js's one
// shared animation loop for every chart on the page, not just the one
// hovered (confirmed live: this was the cause of tooltips silently dying
// page-wide after the very first hover).
Object.assign(Chart.defaults.animation, { duration: 450, easing: 'easeOutQuart' }); // subtle, quick — not a gimmick

const SALE_ROW_SELECT = 'sale_date,address,postal_district,eircode,property_type,price,size_description,vat_exclusive,not_full_market_price';
const RESULT_LIMIT = 200;
const RECENT_LIMIT = 50;
const RECENT_PAGE_SIZE = 50;

let quarterlyChart, districtChart, typeChart, rateChart;
let recentScrollObserver = null;
let recentOffset = 0;
let recentExhausted = false;
let recentLoadingMore = false;
// (offset) => params object for pg('sales', params) — set per view by
// setupRecentInfiniteScroll, so the same loader/eviction machinery below
// works for both the unfiltered default table and a filtered search's.
let tableFetchParams = null;
let tableTrueTotal = null;
let districtOptions = [];
let typeOptions = [];
let addressMatches = [];
let activeSuggestionIndex = -1;
let suggestionRequestId = 0;
// loadDefaultView / runFilteredView / runAddressHistory can all be in flight
// at once (e.g. typing a search term, then clicking an address suggestion
// before the search's own query has returned) — whichever started LAST wins;
// an older response that resolves later is discarded rather than clobbering
// the screen with stale data.
let viewRequestId = 0;
// AbortControllers for the two request families (the view queries and the
// address-suggestion query). A new keystroke aborts the previous in-flight
// request of its family so a slow stale one can't hold a connection slot or
// queue the newest query behind it (browsers cap ~6 concurrent requests per
// origin) — see pg()'s signal handling.
let viewAbort = null;
let suggestAbort = null;
// The default view's payload is cached after the first load — it only changes
// on the weekly ingest, and clearing a search (or clicking the title) calls
// loadDefaultView again, so re-fetching five views each time is pure waste.
let defaultViewCache = null;
// Address shown by the current address-history view, if any — it shapes the
// URL (and thus Back/Forward), see viewToUrl().
let viewAddress = null;
// History wiring. The page is a single-URL SPA, so Back/Forward would bounce
// straight out of the site; instead each view (default / filtered / address)
// writes its state to the URL via pushState and restores it on popstate.
// `allowHistoryPush` turns the first URL write of a navigation gesture into a
// pushState (so Back returns to the previous view) and collapses every
// subsequent keystroke into replaceState (so typing doesn't stack a history
// entry per character). `restoringView` suppresses URL writes entirely while
// a popstate restore is in flight — the URL already points where we're going.
let allowHistoryPush = false;
let restoringView = 0;
// "Searching…" state for the search box — a search is pending from the moment
// a keystroke schedules one until the latest view's results land.
let searchPending = false;
// Ref-count for in-flight address-suggestion RPCs (see setSuggestionsPending).
let suggestionsRefs = 0;

function districtSynonyms(label) {
  const syns = [label.toLowerCase()];
  const m = label.match(/^Dublin (\d{1,2}W?)$/i);
  if (m) {
    const suffix = m[1].toUpperCase();
    syns.push(`d${suffix}`.toLowerCase()); // what people actually type: "D6"
    if (suffix.length === 1) syns.push(`d0${suffix}`.toLowerCase()); // Eircode form: "D06"
  } else {
    syns.push(label.replace('.', '').toLowerCase());
  }
  return syns;
}

// Maps a "Dublin N"/"Dublin NW" label to its Eircode routing key ("D01",
// "D6W", ...) to look it up in DUBLIN_DISTRICT_GEOMETRY. Returns null for
// anything that isn't one of the 22 core districts (i.e. "Co. Dublin") —
// that bucket has no single shape and is deliberately not drawn, see
// renderMap().
function districtRoutingKey(label) {
  const m = label.match(/^Dublin (\d{1,2}W?)$/i);
  if (!m) return null;
  const suffix = m[1].toUpperCase();
  return suffix.endsWith('W') ? `D${suffix}` : `D${suffix.padStart(2, '0')}`;
}

function districtLabelFromKey(key) {
  const suffix = key.slice(1);
  return suffix.endsWith('W') ? `Dublin ${suffix}` : `Dublin ${parseInt(suffix, 10)}`;
}

function baseScales(extra = {}) {
  return {
    x: {
      grid: { color: palette.gridline, display: false },
      border: { color: palette.baseline },
      ticks: { color: palette.textMuted },
      ...extra.x,
    },
    y: {
      grid: { color: palette.gridline },
      border: { display: false },
      ticks: { color: palette.textMuted, callback: (v) => eurCompact.format(v) },
      beginAtZero: true,
      ...extra.y,
    },
  };
}

function tooltipBase() {
  return {
    backgroundColor: '#0d0d0d',
    borderColor: palette.baseline,
    borderWidth: 1,
    titleColor: '#ffffff',
    bodyColor: '#ffffff',
    padding: 10,
    boxPadding: 4,
    // 'nearest' (not the default 'average') keeps the tooltip anchored to
    // whichever point/bar is actually closest to the cursor, so it appears
    // next to where you're hovering rather than at a position averaged
    // across every active element.
    position: 'nearest',
  };
}

// Updates an existing Chart instance in place instead of destroying it and
// building a new one from scratch. Destroy+recreate is the dominant cost of a
// search render (canvas teardown + full re-layout + reanimation of every
// chart) — reuse + an animation-free update makes a keystroke's new results
// snap in. Only the very first render of each chart animates (the default
// 450ms), which keeps the initial-load flourish without taxing every search.
function upsertChart(existing, ctx, config) {
  if (existing) {
    existing.data = config.data;
    existing.options = config.options;
    existing.update('none');
    return existing;
  }
  return new Chart(ctx, config);
}

function renderQuarterly(rows) {
  const ctx = document.getElementById('chart-quarterly');
  quarterlyChart = upsertChart(quarterlyChart, ctx, {
    type: 'line',
    data: {
      labels: rows.map((r) => quarterFmt(r.quarter)),
      datasets: [
        {
          data: rows.map((r) => Math.round(r.median_price)),
          borderColor: palette.series1,
          backgroundColor: palette.series1 + '1a',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: palette.series1,
          pointHoverBorderColor: '#1a1a19',
          pointHoverBorderWidth: 2,
          fill: true,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipBase(),
          callbacks: { label: (ctx) => eur.format(ctx.parsed.y) },
        },
      },
      scales: baseScales({ x: { ticks: { maxTicksLimit: 10, color: palette.textMuted } } }),
    },
  });
}

function renderDistrict(rows) {
  const ctx = document.getElementById('chart-district');
  const sorted = [...rows].sort((a, b) => b.median_price - a.median_price);
  districtChart = upsertChart(districtChart, ctx, {
    type: 'bar',
    data: {
      labels: sorted.map((r) => r.postal_district),
      datasets: [
        {
          data: sorted.map((r) => Math.round(r.median_price)),
          backgroundColor: palette.series1,
          borderRadius: 4,
          maxBarThickness: 18,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      // Chart.js bar charts default to intersect: true — hovering anywhere
      // in a bar's row except the coloured bar itself shows nothing.
      // 'index' + intersect: false makes the whole row hoverable instead.
      // axis: 'y' is required here specifically: Chart.js's interaction axis
      // defaults to 'x' regardless of indexAxis, so on this horizontal bar
      // chart it would otherwise match the "index" by horizontal mouse
      // position instead of which row you're actually over — causing the
      // tooltip to jump to a seemingly random bar as the cursor moves.
      interaction: { mode: 'index', intersect: false, axis: 'y' },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipBase(),
          callbacks: { label: (ctx) => eur.format(ctx.parsed.x) },
        },
      },
      scales: {
        x: {
          grid: { color: palette.gridline },
          border: { display: false },
          ticks: { color: palette.textMuted, callback: (v) => eurCompact.format(v) },
          beginAtZero: true,
        },
        y: {
          grid: { display: false },
          border: { color: palette.baseline },
          ticks: { color: palette.textMuted },
        },
      },
    },
  });
}

// Builds the "M x,y L x,y ... Z" path data for one district's geometry,
// converting from Irish Transverse Mercator metres to SVG user units: shift
// by the shared bbox origin, and flip Y (northing increases upward; SVG
// increases downward). fill-rule="evenodd" on the <path> handles any ring
// that turns out to be a hole rather than a separate landmass correctly
// either way, so this doesn't need to know which case it is.
function districtPathData(polys, bbox) {
  const [minX, , , maxY] = bbox;
  const subpaths = [];
  for (const poly of polys) {
    for (const ring of poly) {
      const pts = ring.map(([x, y]) => `${x - minX},${maxY - y}`);
      subpaths.push(`M${pts.join('L')}Z`);
    }
  }
  return subpaths.join(' ');
}

let mapTooltipEl, mapWrapEl;

// Touch devices have no hover, so a tap fires straight to `click` with no
// preview — the median-price/sale-count tooltip mouse users get for free is
// never seen. Below this, taps preview-then-commit instead: first tap on a
// district shows its tooltip, a second tap on the same one activates it.
const supportsHover = matchMedia('(hover: hover)').matches;
let touchPreviewKey = null;

function positionMapTooltip(evt) {
  const wrapRect = mapWrapEl.getBoundingClientRect();
  mapTooltipEl.style.left = `${evt.clientX - wrapRect.left}px`;
  mapTooltipEl.style.top = `${evt.clientY - wrapRect.top}px`;
}

function showMapTooltip(evt, label, medianPrice, saleCount) {
  mapTooltipEl.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'tooltip-title';
  title.textContent = label;
  const meta = document.createElement('div');
  meta.className = 'tooltip-meta';
  meta.textContent =
    medianPrice == null
      ? 'No sales recorded'
      : `${eur.format(medianPrice)} median · ${saleCount.toLocaleString()} sale${saleCount === 1 ? '' : 's'}`;
  mapTooltipEl.appendChild(title);
  mapTooltipEl.appendChild(meta);
  mapTooltipEl.hidden = false;
  positionMapTooltip(evt);
}

function hideMapTooltip() {
  mapTooltipEl.hidden = true;
}

// Clicking a map district (or the "Co. Dublin" note) is an explicit "show me
// this district" — clear any lingering search text first. Otherwise a term
// left in the box from a previous search (or an opened address) gets AND-ed
// with the district, matches almost nothing, and every click reads as "0
// results" with the map blanked out.
function districtFilterActivate(label) {
  allowHistoryPush = true;
  searchInput.value = '';
  toggleClearButton();
  hideSuggestions();
  districtSelect.value = label;
  runFilteredView();
}

// Colours, draws, and wires up the choropleth. `rows` is the same
// {postal_district, median_price, sale_count} shape renderDistrict gets —
// whatever's driving the bar chart also drives the map, so they can never
// disagree. Districts not present in `rows` (no sales matching the current
// filter) render in the flat "no data" grey rather than being hidden.
function renderMap(rows) {
  const svg = document.getElementById('map-svg');
  const byKey = new Map();
  for (const r of rows) {
    const key = districtRoutingKey(r.postal_district);
    if (key) byKey.set(key, r);
  }

  const mapped = [...byKey.values()];
  const prices = mapped.map((r) => r.median_price);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;

  document.getElementById('map-legend-low').textContent = prices.length ? eurCompact.format(minPrice) : '—';
  document.getElementById('map-legend-high').textContent = prices.length ? eurCompact.format(maxPrice) : '—';

  // "Co. Dublin" sales are real but don't correspond to one of the 22
  // mapped shapes — noted honestly rather than silently dropped from the map.
  const coDublinRow = rows.find((r) => r.postal_district === 'Co. Dublin');
  const note = document.getElementById('map-co-dublin-note');
  if (coDublinRow) {
    note.hidden = false;
    note.replaceChildren();
    note.append(`${coDublinRow.sale_count.toLocaleString()} sale${coDublinRow.sale_count === 1 ? '' : 's'} in `);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Co. Dublin';
    btn.title = 'Filter by Co. Dublin';
    btn.addEventListener('click', () => {
      districtFilterActivate('Co. Dublin');
    });
    note.appendChild(btn);
    note.append(' fall outside the 22 mapped districts and aren’t shown geographically.');
  } else {
    note.hidden = true;
  }

  const { bbox, districts } = DUBLIN_DISTRICT_GEOMETRY;
  const [minX, minY, maxX, maxY] = bbox;
  svg.setAttribute('viewBox', `0 0 ${maxX - minX} ${maxY - minY}`);
  svg.replaceChildren();

  // District geometry never changes — compute each path's `d` string once
  // instead of re-serialising every polygon on every search re-render.
  const pathDataCache = renderMap.pathDataCache ?? (renderMap.pathDataCache = {});

  for (const [key, polys] of Object.entries(districts)) {
    const row = byKey.get(key);
    const label = districtLabelFromKey(key);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', (pathDataCache[key] ??= districtPathData(polys, bbox)));
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('tabindex', '0');
    path.setAttribute('class', 'district-path');

    if (row) {
      const t = maxPrice === minPrice ? 1 : (row.median_price - minPrice) / (maxPrice - minPrice);
      path.setAttribute('fill', lerpColor(palette.scaleLow, palette.scaleHigh, t));
      path.setAttribute('aria-label', `${label}: ${eur.format(row.median_price)} median, ${row.sale_count} sales`);
    } else {
      path.classList.add('no-data');
      path.setAttribute('fill', palette.scaleNoData);
      path.setAttribute('aria-label', `${label}: no sales recorded`);
    }

    // Click-to-filter was removed: selecting a district here had no way to
    // deselect from the map itself (no toggle, no "click again" undo) —
    // only the district dropdown could clear it, which read as the map
    // being stuck once you'd clicked one. Hover/focus still shows the
    // tooltip; the map is look-only now.
    if (supportsHover) {
      path.addEventListener('mouseenter', (e) => showMapTooltip(e, label, row?.median_price, row?.sale_count));
      path.addEventListener('mousemove', positionMapTooltip);
      path.addEventListener('mouseleave', hideMapTooltip);
    } else {
      path.addEventListener('click', (e) => {
        e.preventDefault();
        if (touchPreviewKey === key) {
          touchPreviewKey = null;
          hideMapTooltip();
        } else {
          touchPreviewKey = key;
          showMapTooltip(e, label, row?.median_price, row?.sale_count);
        }
      });
    }
    path.addEventListener('focus', (e) => showMapTooltip(e, label, row?.median_price, row?.sale_count));
    path.addEventListener('blur', hideMapTooltip);

    svg.appendChild(path);
  }
}

function renderType(rows) {
  const ctx = document.getElementById('chart-type');
  typeChart = upsertChart(typeChart, ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => propertyTypeLabel(r.property_type)),
      datasets: [
        {
          data: rows.map((r) => Math.round(r.median_price)),
          backgroundColor: [palette.series1, palette.series2],
          borderRadius: 4,
          maxBarThickness: 48,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipBase(),
          callbacks: { label: (ctx) => eur.format(ctx.parsed.y) },
        },
      },
      scales: baseScales(),
    },
  });
}

// Fetched once and shared by both loadDefaultView and runFilteredView — it's
// a national rate, not a per-view value, and both paths need it (including
// loadInitialView's deep-link case, which can reach runFilteredView directly
// on first load without loadDefaultView ever running, so this can't be read
// off defaultViewCache without risking a null dereference there). Cached by
// resolved value, not by promise-tied-to-an-abortable-request — a request
// this small isn't worth wiring into the view AbortController family, and
// caching an in-flight promise across an abort would risk permanently
// caching an empty result.
let rateSeriesCache = null;
let rateSeriesFetch = null;
async function getRateSeries() {
  if (rateSeriesCache) return rateSeriesCache;
  if (!rateSeriesFetch) {
    rateSeriesFetch = pg('mortgage_rates', { select: 'quarter,rate_type,rate_pct,source', order: 'quarter.asc' })
      .then((res) => {
        rateSeriesCache = buildRateSeries(res.data || []);
        return rateSeriesCache;
      })
      .finally(() => { rateSeriesFetch = null; });
  }
  return rateSeriesFetch;
}

// Splices the PDH mortgage rate into one representative per-quarter series:
// the Central Bank's own new-business variable rate where it exists
// (source='cbi', 2014 Q4 onward), falling back to the ECB blended-composite
// backfill for 2010-2014 Q3 (source='ecb') — see supabase/schema.sql's
// mortgage_rates comment for why these are two different methodologies
// rather than one continuous series. Returns a Map keyed by quarter (ISO
// date string) to {rate_pct, source}.
function buildRateSeries(rateRows) {
  const byQuarter = new Map();
  for (const r of rateRows) {
    if (r.rate_type !== 'pdh_variable' && r.rate_type !== 'pdh_blended_backfill') continue;
    if (!byQuarter.has(r.quarter) || r.rate_type === 'pdh_variable') {
      byQuarter.set(r.quarter, { rate_pct: Number(r.rate_pct), source: r.source });
    }
  }
  return byQuarter;
}

// Sales volume (left axis) against the mortgage rate (right axis) — two
// series on genuinely different scales, so they need independent y-axes
// rather than one shared one flattening whichever has the smaller range.
// `quarterlyRows` reflects whatever filter is active (same rows driving the
// "Median price by quarter" chart); `rateSeries` is the module-wide splice
// from buildRateSeries, which doesn't change with filters — it's a national
// rate, not a per-district or per-type one.
function renderRateOverlay(quarterlyRows, rateSeries) {
  const rows = quarterlyRows.filter((r) => rateSeries.has(r.quarter));
  const ctx = document.getElementById('chart-rate');
  rateChart = upsertChart(rateChart, ctx, {
    type: 'line',
    data: {
      labels: rows.map((r) => quarterFmt(r.quarter)),
      datasets: [
        {
          label: 'Sales volume',
          data: rows.map((r) => r.sale_count),
          yAxisID: 'y',
          borderColor: palette.series1,
          backgroundColor: palette.series1 + '1a',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: palette.series1,
          pointHoverBorderColor: '#1a1a19',
          pointHoverBorderWidth: 2,
          fill: true,
          tension: 0.15,
        },
        {
          label: 'PDH mortgage rate',
          data: rows.map((r) => rateSeries.get(r.quarter).rate_pct),
          yAxisID: 'y1',
          borderColor: palette.series2,
          borderWidth: 2,
          borderDash: [4, 3],
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: palette.series2,
          pointHoverBorderColor: '#1a1a19',
          pointHoverBorderWidth: 2,
          fill: false,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: palette.textMuted, boxWidth: 12, boxHeight: 2, padding: 12 },
        },
        tooltip: {
          ...tooltipBase(),
          callbacks: {
            label: (ctx) => (ctx.dataset.yAxisID === 'y1' ? `${ctx.parsed.y.toFixed(2)}%` : `${ctx.parsed.y.toLocaleString()} sales`),
          },
        },
      },
      scales: {
        x: {
          grid: { color: palette.gridline, display: false },
          border: { color: palette.baseline },
          ticks: { color: palette.textMuted, maxTicksLimit: 10 },
        },
        y: {
          position: 'left',
          grid: { color: palette.gridline },
          border: { display: false },
          ticks: { color: palette.textMuted },
          beginAtZero: true,
        },
        y1: {
          position: 'right',
          grid: { display: false },
          border: { display: false },
          ticks: { color: palette.textMuted, callback: (v) => `${v}%` },
          beginAtZero: true,
        },
      },
    },
  });
}

// A single address is always exactly one district and one property type, so
// those two charts are structurally meaningless there — hide them rather than
// show a one-bar "chart" that isn't telling the reader anything. The quarterly
// chart is repurposed into that address's own raw price history (or hidden
// too, honestly, if there's only one sale to plot).
function setChartsMode(mode, rows = []) {
  const districtCard = document.getElementById('card-district');
  const typeCard = document.getElementById('card-type');
  const mapCard = document.getElementById('card-map');
  const rateCard = document.getElementById('card-rate');
  const quarterlyCard = document.getElementById('card-quarterly');
  const quarterlyHeading = document.getElementById('chart-quarterly-heading');
  const emptyNote = document.getElementById('charts-empty-note');

  if (mode === 'address') {
    districtCard.hidden = true;
    typeCard.hidden = true;
    mapCard.hidden = true; // same reasoning as the district bar chart — one address is one district
    rateCard.hidden = true; // the national mortgage rate isn't meaningful next to one address's own history
    quarterlyHeading.textContent = 'Price history for this address';
    if (rows.length < 2) {
      quarterlyCard.hidden = true;
      emptyNote.hidden = false;
    } else {
      quarterlyCard.hidden = false;
      emptyNote.hidden = true;
      renderAddressPriceChart(rows);
    }
  } else {
    districtCard.hidden = false;
    typeCard.hidden = false;
    mapCard.hidden = false;
    rateCard.hidden = false;
    quarterlyCard.hidden = false;
    emptyNote.hidden = true;
    quarterlyHeading.textContent = 'Median price by quarter';
  }
}

const RATE_TYPE_LABELS = {
  pdh_variable: 'Variable',
  pdh_tracker: 'Tracker',
  pdh_fixed_up_to_1y: 'Fixed (up to 1yr)',
  pdh_fixed_1_3y: 'Fixed (1-3yr)',
  pdh_fixed_over_3y: 'Fixed (3yr+)',
  pdh_blended_backfill: 'Blended (ECB backfill)',
};
const RATE_SOURCE_LABELS = { cbi: 'Central Bank of Ireland', ecb: 'ECB' };

// Raw browsable views of the two external tables joined in alongside the
// sales register (see supabase/schema.sql) — both small enough (a few
// hundred / low thousands of rows) to render in full rather than needing
// the sales table's incremental-loading machinery. Independent of the
// search/filter view lifecycle: this data doesn't change with what's
// searched or filtered, so it's fetched once on initial load, not re-fetched
// per view.
async function loadMortgageRatesTable() {
  const { data } = await pg('mortgage_rates', { select: 'quarter,rate_type,rate_pct,source', order: 'quarter.desc' });
  const body = document.getElementById('rates-table-body');
  body.replaceChildren();
  (data || []).forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${Math.min(i, 12) * 8}ms`;

    const quarterTd = document.createElement('td');
    quarterTd.textContent = quarterFmt(r.quarter);
    tr.appendChild(quarterTd);

    const typeTd = document.createElement('td');
    typeTd.textContent = RATE_TYPE_LABELS[r.rate_type] || r.rate_type;
    tr.appendChild(typeTd);

    const rateTd = document.createElement('td');
    rateTd.className = 'num';
    rateTd.textContent = `${Number(r.rate_pct).toFixed(2)}%`;
    tr.appendChild(rateTd);

    const sourceTd = document.createElement('td');
    sourceTd.textContent = RATE_SOURCE_LABELS[r.source] || r.source;
    tr.appendChild(sourceTd);

    body.appendChild(tr);
  });
}

async function loadRentIndexTable() {
  // PostgREST caps a single response at 1000 rows regardless of the
  // requested `limit` (confirmed live: a limit=2000 request for this
  // table's real ~1,266 rows came back as content-range 0-999/1266) — a
  // single fetch would have silently dropped its oldest 266 rows. Paginate
  // in batches of 1000 until a page comes back short.
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data } = await pg('rent_index', {
      select: 'quarter,district,avg_rent_eur',
      order: 'quarter.desc,district.asc',
      limit: '1000',
      offset: String(offset),
    });
    const page = data || [];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const body = document.getElementById('rent-table-body');
  body.replaceChildren();
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${Math.min(i, 12) * 8}ms`;

    const quarterTd = document.createElement('td');
    quarterTd.textContent = quarterFmt(r.quarter);
    tr.appendChild(quarterTd);

    const districtTd = document.createElement('td');
    districtTd.textContent = r.district;
    tr.appendChild(districtTd);

    const rentTd = document.createElement('td');
    rentTd.className = 'num';
    rentTd.textContent = eur.format(r.avg_rent_eur);
    tr.appendChild(rentTd);

    body.appendChild(tr);
  });
}

function renderAddressPriceChart(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.sale_date) - new Date(b.sale_date));
  const ctx = document.getElementById('chart-quarterly');
  quarterlyChart = upsertChart(quarterlyChart, ctx, {
    type: 'line',
    data: {
      labels: sorted.map((r) => r.sale_date),
      datasets: [
        {
          data: sorted.map((r) => r.price),
          borderColor: palette.series1,
          backgroundColor: palette.series1 + '1a',
          borderWidth: 2,
          pointRadius: 5,
          pointBackgroundColor: palette.series1,
          pointBorderColor: '#1a1a19',
          pointBorderWidth: 2,
          fill: true,
          tension: 0, // raw sale points, not a smoothed trend
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipBase(),
          callbacks: { label: (ctx) => eur.format(ctx.parsed.y) },
        },
      },
      scales: baseScales(),
    },
  });
}

function renderAddressDetail(rows) {
  const detail = document.getElementById('address-detail');
  if (!rows.length) {
    detail.hidden = true;
    return;
  }

  const latest = rows[0]; // rows are sale_date desc
  const sizeRow = rows.find((r) => r.size_description);
  // Always show every field, labeled — a silently-omitted Eircode reads as
  // "the app is broken", not "the source register didn't record one".
  const parts = [
    propertyTypeLabel(latest.property_type),
    `District: ${latest.postal_district || 'not recorded'}`,
    `Eircode: ${latest.eircode || 'not recorded'}`,
  ];
  if (sizeRow) parts.push(`Size: ${sizeRow.size_description}`);
  document.getElementById('address-detail-meta').textContent = parts.join(' · ');

  const query = encodeURIComponent(`${latest.address}, Dublin, Ireland`);
  document.getElementById('address-detail-map').href = `https://www.google.com/maps/search/?api=1&query=${query}`;

  detail.hidden = false;
}

function renderNotesCell(r) {
  const td = document.createElement('td');
  td.className = 'notes-cell';

  const size = shortSize(r.size_description);
  if (size) {
    const span = document.createElement('span');
    span.className = 'note-size';
    span.textContent = size;
    td.appendChild(span);
  }
  if (r.not_full_market_price) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Non-market';
    td.appendChild(badge);
  }
  if (r.vat_exclusive) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'VAT excl.';
    td.appendChild(badge);
  }
  return td;
}

// Briefly re-triggers the value-in fade so a stat tile visibly updates
// instead of silently snapping to a new number.
function setStat(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

// Toggles the loading indicator in the search box. A search is pending from
// the first keystroke until the winning view request lands, and separately
// until the address-suggestion RPC lands — the two can run at very different
// speeds, so the indicator stays on until BOTH are done (the suggestions call
// is ref-counted; overlapping superseded calls release their own reference
// via finally). Idempotent: superseded requests leave the state alone.
function setSearchPending(pending) {
  if (searchPending === pending) return;
  searchPending = pending;
  updateSearchStatus();
}

function setSuggestionsPending(pending) {
  suggestionsRefs = Math.max(0, suggestionsRefs + (pending ? 1 : -1));
  updateSearchStatus();
}

function updateSearchStatus() {
  document.getElementById('search-status').hidden = !(searchPending || suggestionsRefs > 0);
}

// Dims stats/charts/table while a view is being (re)loaded, so filtering
// reads as a transition rather than a jump-cut. Skipped for the true first
// load, which gets the stronger shimmer skeleton instead (see loadDefaultView).
function setViewLoading(loading) {
  document.querySelector('.page').classList.toggle('view-loading', loading);
}

function buildTableRow(r, animationIndex) {
  const tr = document.createElement('tr');
  tr.style.animationDelay = `${Math.min(animationIndex, 12) * 8}ms`;

  const dateTd = document.createElement('td');
  dateTd.textContent = r.sale_date;
  tr.appendChild(dateTd);

  const addressTd = document.createElement('td');
  addressTd.className = 'address-cell';
  addressTd.textContent = r.address;
  addressTd.title = 'View full sale history for this address';
  addressTd.addEventListener('click', () => runAddressHistory(r.address));
  tr.appendChild(addressTd);

  const districtTd = document.createElement('td');
  districtTd.textContent = r.postal_district || '—';
  tr.appendChild(districtTd);

  const eircodeTd = document.createElement('td');
  eircodeTd.textContent = r.eircode || '—';
  tr.appendChild(eircodeTd);

  const typeTd = document.createElement('td');
  typeTd.textContent = r.property_type ? propertyTypeLabel(r.property_type) : '—';
  tr.appendChild(typeTd);

  const priceTd = document.createElement('td');
  priceTd.className = 'num';
  priceTd.textContent = eur.format(r.price);
  tr.appendChild(priceTd);

  tr.appendChild(renderNotesCell(r));
  return tr;
}

function renderTable(rows, cap, trueTotal) {
  const body = document.getElementById('table-body');
  body.replaceChildren();
  rows.forEach((r, i) => body.appendChild(buildTableRow(r, i)));
  const note = document.getElementById('result-note');
  if (rows.length >= cap) {
    // trueTotal (from PostgREST's exact count, see pg()) is the real match
    // count; rows.length is just this page. Show both rather than implying
    // "first 200" is close to the whole story when it might be 1 of 30 pages.
    note.textContent =
      trueTotal && trueTotal > cap
        ? `Showing ${cap} of ${trueTotal.toLocaleString()} matches`
        : `Showing first ${cap} matches`;
  } else {
    note.textContent = `${rows.length} result${rows.length === 1 ? '' : 's'}`;
  }
}

function stopRecentInfiniteScroll() {
  recentScrollObserver?.disconnect();
  recentScrollObserver = null;
  tableFetchParams = null;
  tableTrueTotal = null;
}

// Bounds the live DOM regardless of how far a user scrolls: once the table
// grows past DOM_WINDOW_MAX rows, the oldest ones at the top are evicted
// back down to DOM_WINDOW_TRIM_TO. Compensates .table-scroll's scrollTop by
// measuring exactly how far a surviving row (the one that becomes the new
// first row) actually moves across the removal, rather than precomputing a
// sum of the removed rows' heights — verified live that a precomputed sum
// drifts from the real answer by a large, inconsistent margin (likely the
// row-entrance animation or table layout reflow affecting
// getBoundingClientRect at measurement time), while measuring the real
// before/after delta of a row that isn't itself being touched is correct
// by construction regardless of the cause. This is what makes uncapped
// scrolling in loadMoreRecent safe: the DOM never grows past a few hundred
// rows no matter how many pages have been fetched. Trade-off: scrolling
// back up past the evicted point shows a gap rather than re-fetching those
// rows — one-directional windowing, not a full bidirectional virtualised
// list.
const DOM_WINDOW_MAX = 300;
const DOM_WINDOW_TRIM_TO = 200;

function trimTableWindow() {
  const body = document.getElementById('table-body');
  const toRemove = body.children.length - DOM_WINDOW_TRIM_TO;
  if (body.children.length <= DOM_WINDOW_MAX || toRemove <= 0) return;
  const scrollEl = document.querySelector('.table-scroll');
  const anchorRow = body.children[toRemove]; // first row that survives the trim
  const anchorTopBefore = anchorRow?.getBoundingClientRect().top;
  for (let i = 0; i < toRemove; i++) body.firstElementChild.remove();
  if (scrollEl && anchorRow && anchorTopBefore != null) {
    scrollEl.scrollTop += anchorRow.getBoundingClientRect().top - anchorTopBefore;
  }
}

// Client-side equivalent of sales_stats' own filter logic (see
// supabase/schema.sql), used only to page a filtered search PAST what
// sales_stats itself returns — its rows are capped at RESULT_LIMIT, but the
// stats/charts above the table are already computed server-side over every
// match, so paging further doesn't touch those, only the table. Term
// matching here goes through PostgREST's own ilike/or filter syntax rather
// than the RPC's carefully %L-quoted SQL, so it's not escaped as robustly —
// a term containing a literal * would misbehave as a wildcard, an edge case
// rare enough for an address/Eircode/district search not to warrant a
// bespoke escaping layer just for this incremental-loading path.
function buildFilteredPageParams(term, district, typeGroup, includeNonMarket) {
  return (offset) => {
    const params = { select: SALE_ROW_SELECT, order: 'sale_date.desc', limit: RECENT_PAGE_SIZE, offset };
    if (!includeNonMarket) params.not_full_market_price = 'eq.false';
    if (district) params.postal_district = `eq.${district}`;
    if (typeGroup) params.property_type = `in.(${typeGroup.values.map((v) => `"${v}"`).join(',')})`;
    if (term) {
      const t = term.trim();
      params.or = `(address.ilike.*${t}*,eircode.ilike.*${t.replace(/\s+/g, '')}*,postal_district.ilike.*${t}*)`;
    }
    return params;
  };
}

function updateLoadedResultNote(loadedCount, exhausted) {
  document.getElementById('result-note').textContent =
    !exhausted && tableTrueTotal
      ? `${loadedCount.toLocaleString()} of ${tableTrueTotal.toLocaleString()} loaded, keep scrolling for more`
      : `${loadedCount.toLocaleString()} result${loadedCount === 1 ? '' : 's'}`;
}

// No hard cap on how far this pages: keeps going until a page comes back
// short (recentExhausted), meaning it's genuinely reached the end of the
// match set, not an arbitrary stopping point. sales is indexed on sale_date
// (and the filtered columns this also queries), so paging through it is
// cheap at any depth, and the anon key is already publicly queryable that
// deep regardless — trimTableWindow above is what keeps the actual DOM cost
// bounded.
//
// try/finally matters here specifically: verified live that without it, a
// single failed request (an HTTP error, or fetch() itself rejecting on a
// network blip) leaves recentLoadingMore stuck true forever — the guard at
// the top of this function then silently blocks every future scroll-
// triggered load for the rest of the session, with no visible error. An
// HTTP-error response (pg() returns data: null) is also distinguished from
// a genuinely short final page, so a transient server error doesn't get
// misread as "reached the end of the data" and permanently stop the
// scroll-loader via recentExhausted.
async function loadMoreRecent() {
  if (recentLoadingMore || recentExhausted || !tableFetchParams) return;
  recentLoadingMore = true;
  try {
    const { data, error } = await pg('sales', tableFetchParams(recentOffset));
    if (error) {
      console.error('loadMoreRecent failed:', error);
      return; // transient — leave recentExhausted false so a later scroll can retry
    }
    const rows = data || [];
    const body = document.getElementById('table-body');
    rows.forEach((r, i) => body.appendChild(buildTableRow(r, i)));
    recentOffset += rows.length;
    trimTableWindow();
    const exhausted = rows.length < RECENT_PAGE_SIZE;
    if (exhausted) {
      recentExhausted = true;
      stopRecentInfiniteScroll();
    }
    updateLoadedResultNote(recentOffset, exhausted);
  } catch (e) {
    console.error('loadMoreRecent failed:', e);
  } finally {
    recentLoadingMore = false;
  }
}

// Infinite scroll shared by the unfiltered "Recent sales" table and a
// filtered search's results — both are the same table/eviction machinery,
// just fed a different per-page query. `fetchParamsFn(offset)` builds the
// pg('sales', ...) params for the next page; `startOffset` is how many rows
// are already rendered from the initial (non-incremental) fetch; `trueTotal`
// is the exact match count if known (sales_stats' agg.total for a filtered
// view), used only for the "X of Y loaded" note. Address view doesn't use
// this at all — a single address's history is never realistically large
// enough to need it, see applyResultSet's stopRecentInfiniteScroll() call.
function setupRecentInfiniteScroll(fetchParamsFn, startOffset, trueTotal = null) {
  stopRecentInfiniteScroll();
  tableFetchParams = fetchParamsFn;
  tableTrueTotal = trueTotal;
  recentOffset = startOffset;
  recentExhausted = false;
  recentLoadingMore = false;
  const sentinel = document.getElementById('table-scroll-sentinel');
  if (!sentinel) return;
  recentScrollObserver = new IntersectionObserver(
    (entries) => { if (entries[0].isIntersecting) loadMoreRecent(); },
    { root: document.querySelector('.table-scroll'), rootMargin: '200px' },
  );
  recentScrollObserver.observe(sentinel);
}

async function loadDefaultView() {
  const requestId = ++viewRequestId;
  viewAbort?.abort();
  viewAbort = new AbortController();
  viewAddress = null;
  document.getElementById('table-heading').textContent = 'Recent sales';
  document.getElementById('result-note').textContent = '';
  document.getElementById('address-detail').hidden = true;
  document.getElementById('charts-cap-note').hidden = true; // sales_summary is a true full-table aggregate, never capped
  document.getElementById('stats').classList.add('is-loading');
  setViewLoading(true);

  if (!defaultViewCache) {
    const signal = viewAbort.signal;
    const [summaryRes, quarterly, district, type, recent, rates] = await Promise.all([
      pg('sales_summary', { select: '*' }, { signal }),
      pg('sales_quarterly', { select: '*' }, { signal }),
      pg('sales_by_district', { select: '*' }, { signal }),
      pg('sales_by_type', { select: '*' }, { signal }),
      pg('sales', {
        select: SALE_ROW_SELECT,
        order: 'sale_date.desc',
        limit: RECENT_LIMIT,
      }, { signal }),
      // Non-critical: the rate overlay is one chart among several, not core
      // page data, so a failure here (network blip, an unrelated grant/RLS
      // regression on mortgage_rates) must not fail the whole Promise.all and
      // leave the page stuck in its loading state — degrade to an empty
      // series (an empty rate-overlay chart) instead.
      getRateSeries().catch((e) => { console.error('mortgage rate fetch failed', e); return new Map(); }),
    ]);
    if (requestId !== viewRequestId) return; // a newer view request has since started
    defaultViewCache = {
      summary: summaryRes.data?.[0],
      quarterly: quarterly.data || [],
      district: district.data || [],
      type: type.data || [],
      recent: recent.data || [],
      rateSeries: rates,
    };
  }

  const { summary, quarterly, district, type, recent, rateSeries } = defaultViewCache;
  setStatLabels('aggregate');
  if (summary) {
    // The all-time total ("since 2010") is contextless next to a live
    // dashboard, so the first tile shows sales over the trailing 12 months
    // (the last four quarters) instead — a figure that means something now.
    // Fall back to the lifetime total only if the quarterly series is empty.
    const last4 = quarterly.slice(-4);
    const trailingYear = last4.reduce((acc, q) => acc + (q.sale_count || 0), 0);
    const cutoffDate = last4[0]?.quarter;
    document.getElementById('stat-total-label').textContent =
      trailingYear > 0 ? 'Sales past 12 months' : 'Sales since 2010';
    setStat('stat-total', (trailingYear > 0 ? trailingYear : summary.total_sales).toLocaleString());

    // Median price and new-build share: same trailing window as the tile
    // above where there's enough recent data for it, rather than the
    // all-time register — an all-time median blends 2010 prices in with
    // 2026 ones and reads as "today's price" when it isn't. The label always
    // states which one this ended up being, explicitly, every time.
    const medianLabel = document.getElementById('stat-median-label');
    const newbuildLabel = document.getElementById('stat-newbuild-label');
    if (trailingYear > 0 && cutoffDate) {
      medianLabel.textContent = 'Median price (past 12mo)';
      newbuildLabel.textContent = 'New build share (past 12mo)';
      // Not awaited: charts/table below don't depend on this, and it adds
      // 3 lightweight requests (2 exact-count, 1 point-fetch) on top of the
      // page's core data — no reason to delay the rest of the view on it.
      trailingWindowStats(cutoffDate).then((trailing) => {
        if (requestId !== viewRequestId) return; // superseded by a newer view request
        setStat('stat-median', trailing.medianPrice != null ? eur.format(trailing.medianPrice) : '—');
        setStat('stat-newbuild', `${trailing.newBuildSharePct}%`);
      });
    } else {
      medianLabel.textContent = 'Median price (all-time)';
      newbuildLabel.textContent = 'New build share (all-time)';
      setStat('stat-median', eur.format(summary.median_price));
      setStat('stat-newbuild', `${newBuildShareFromCounts(type)}%`);
    }
    setStat('stat-latest', summary.latest_sale_date);
  }

  setChartsMode('aggregate');
  renderQuarterly(quarterly);
  renderDistrict(district);
  renderMap(district);
  renderType(mergeTypeRows(type));
  renderRateOverlay(quarterly, rateSeries);
  renderTable(recent, RECENT_LIMIT);
  setupRecentInfiniteScroll(
    (offset) => ({ select: SALE_ROW_SELECT, order: 'sale_date.desc', limit: RECENT_PAGE_SIZE, offset }),
    RECENT_LIMIT,
  );

  districtOptions = district.map((d) => ({
    label: d.postal_district,
    sale_count: d.sale_count,
    synonyms: districtSynonyms(d.postal_district),
  }));
  typeOptions = buildTypeOptions(type);
  populateFilterSelects();

  document.getElementById('stats').classList.remove('is-loading');
  setViewLoading(false);
  setSearchPending(false);
  syncUrl(allowHistoryPush);
}

function populateFilterSelects() {
  const currentDistrict = districtSelect.value;
  districtSelect.replaceChildren(new Option('All districts', ''));
  for (const d of districtOptions) {
    districtSelect.appendChild(new Option(`${d.label} (${d.sale_count.toLocaleString()})`, d.label));
  }
  districtSelect.value = currentDistrict;

  const currentType = typeSelect.value;
  typeSelect.replaceChildren(new Option('All property types', ''));
  for (const t of typeOptions) {
    typeSelect.appendChild(new Option(`${t.label} (${t.sale_count.toLocaleString()})`, t.label));
  }
  typeSelect.value = currentType;
}

// districtSelect/typeSelect start with only the placeholder "All ..."
// <option> — real per-value options are added exclusively by
// populateFilterSelects() above, which loadDefaultView calls after its own
// fetch resolves. Assigning a <select>'s .value to a string with no matching
// <option> is a silent no-op per the HTML spec (selectedIndex stays -1,
// .value reads back as ""), so a deep link or Back/Forward restore straight
// into a filtered view — reachable without loadDefaultView ever having run —
// would set districtSelect.value/typeSelect.value and have it silently
// evaporate, dropping the filter with no error. Call this before assigning
// either value whenever that ordering isn't already guaranteed.
async function ensureFilterOptions() {
  if (districtOptions.length) return; // already populated by a prior loadDefaultView
  const [district, type] = await Promise.all([
    pg('sales_by_district', { select: '*' }),
    pg('sales_by_type', { select: '*' }),
  ]);
  districtOptions = (district.data || []).map((d) => ({
    label: d.postal_district,
    sale_count: d.sale_count,
    synonyms: districtSynonyms(d.postal_district),
  }));
  typeOptions = buildTypeOptions(type.data || []);
  populateFilterSelects();
}

// Stats + table for the address-history view (a single address is a bounded,
// exact-equality result set, so everything derives from the rows themselves).
//
// trueTotal is the real count of matching rows (see pg()'s exactCount), which
// can be far larger than `data` when the result set is capped at `cap`.
// "Total sales" uses it directly since that's cheap and exact; median/new
// build share/charts are still derived from just the capped `data` — capped-
// note() below says so rather than quietly presenting a 200-row sample as if
// it were the full picture. The filtered search path does NOT go through
// here: it uses sales_stats, which computes everything server-side over all
// matches (see runFilteredView).
function applyResultSet(data, cap, trueTotal) {
  setStatLabels('address');
  stopRecentInfiniteScroll(); // this table is now one address's own capped rows, not the incrementally-loaded default one
  renderTable(data, cap, trueTotal);
  document.getElementById('address-detail').hidden = true; // re-shown by renderAddressDetail when relevant
  document.getElementById('stats').classList.remove('is-loading'); // only loadDefaultView sets it; a deep link straight into an address view never would otherwise
  const latest = data.length ? data[0] : null; // rows come back ordered by sale_date desc
  setStat('stat-total', (trueTotal ?? data.length).toLocaleString());
  setStat('stat-median', latest && latest.price != null ? eur.format(latest.price) : '—');
  setStat('stat-latest', latest ? latest.sale_date : '—');

  const capNote = document.getElementById('charts-cap-note');
  if (trueTotal && trueTotal > cap) {
    capNote.textContent = `Stats and charts below reflect only the ${cap.toLocaleString()} shown sales, not all ${trueTotal.toLocaleString()}.`;
    capNote.hidden = false;
  } else {
    capNote.hidden = true;
  }
}

// Fetches the district's (and Dublin-wide) price-per-quarter series and
// reveals the "Estimated value today" tile once estimateCurrentValue can say
// something trustworthy about them — left hidden otherwise rather than
// showing a number built on one or two sales. Runs after applyResultSet
// rather than alongside it: it needs the resolved latest sale's district,
// and it's a second round trip that shouldn't block the rest of the view
// from rendering. requestId guards against a since-superseded address still
// overwriting a newer one's tile once its fetch lands.
async function renderValueEstimate(latestSale, requestId) {
  const tile = document.getElementById('stat-newbuild-tile');
  if (!latestSale?.postal_district) return;

  const [{ data: districtQuarters }, { data: cityQuarters }] = await Promise.all([
    pg('district_quarterly', {
      select: 'quarter,median_price,sale_count',
      postal_district: `eq.${latestSale.postal_district}`,
      order: 'quarter.asc',
    }),
    pg('sales_quarterly', { select: 'quarter,median_price,sale_count', order: 'quarter.asc' }),
  ]);
  if (requestId !== viewRequestId) return; // superseded by a newer view request

  const estimate = estimateCurrentValue(latestSale, districtQuarters || [], cityQuarters || []);
  if (!estimate) return;

  setStat('stat-newbuild', eur.format(estimate.value));
  const sign = estimate.growthPct >= 0 ? '+' : '';
  tile.title = `Based on the ${estimate.basis} price trend from ${quarterFmt(estimate.saleQuarter)} to ${quarterFmt(estimate.asOfQuarter)} (${sign}${estimate.growthPct.toFixed(0)}%). Not a valuation.`;
  tile.hidden = false;
}

function buildFilterHeading(term, district, type) {
  const parts = [];
  if (term) parts.push(`"${term}"`);
  if (district) parts.push(district);
  if (type) parts.push(type); // already a merged label ("New Build" / "Resale")
  return parts.length ? `Filtered sales: ${parts.join(' · ')}` : 'Recent sales';
}

// Renders a filtered view's stats + charts from a sales_stats RPC result
// (see supabase/schema.sql): server-computed medians and series that cover
// every matching sale, not just the 200-row page. `rows` in the payload is
// the capped page for the table; `total` is the true match count.
function applyStatsPayload(agg, rateSeries) {
  setStatLabels('filtered');
  document.getElementById('address-detail').hidden = true;
  document.getElementById('charts-cap-note').hidden = true; // stats/charts cover all matches, not the page
  document.getElementById('stats').classList.remove('is-loading'); // only loadDefaultView sets it; a deep link straight into a filtered view never would otherwise
  setStat('stat-total', agg.total.toLocaleString());
  // percentile_cont over zero matching rows comes back as SQL NULL — Intl's
  // format() coerces that to 0 and shows "€0" as if it were a real (very
  // cheap) median, rather than "no data". Same null-guard pattern already
  // used for latest_sale_date just below.
  setStat('stat-median', agg.median_price != null ? eur.format(agg.median_price) : '—');
  setStat('stat-newbuild', `${newBuildShareFromCounts(agg.types)}%`);
  setStat('stat-latest', agg.latest_sale_date || '—');
  setChartsMode('aggregate');
  renderQuarterly(agg.quarterly);
  renderDistrict(agg.districts);
  renderMap(agg.districts);
  renderType(mergeTypeRows(agg.types));
  renderRateOverlay(agg.quarterly, rateSeries);
}

// The single query path behind search text, the district select, the
// property-type select, and the non-market checkbox — every control reads
// its own current value here, so no combination of them can go stale or
// contradict what's on screen (the bug where unchecking the checkbox re-ran
// a stale search instead of the active view).
async function runFilteredView() {
  const requestId = ++viewRequestId;
  viewAbort?.abort();
  viewAbort = new AbortController();
  viewAddress = null;
  setSearchPending(true);
  const term = searchInput.value.trim();
  const district = districtSelect.value;
  const type = typeSelect.value;
  const includeNonMarket = nonMarketCheckbox.checked;

  if (!term && !district && !type && !includeNonMarket) {
    await loadDefaultView();
    return;
  }

  // The filter goes to the sales_stats RPC as arguments — the SQL owns the
  // matching, medians and series (see supabase/schema.sql) — and the whole
  // view renders from that one payload, so nothing here can disagree with
  // the table. The previous results stay on screen until this response
  // lands (no loading dim: for search-as-you-type the old rows are the best
  // placeholder, and the new ones simply swell in). "type" is a merged label
  // ("New Build"); expand it to every raw source string that folds into it
  // (see PROPERTY_TYPE_LABELS), including the Irish-language variants, and
  // pass them '|'-joined.
  const typeGroup = type ? typeOptions.find((t) => t.label === type) : null;
  const [{ data, error }, rateSeries] = await Promise.all([
    pg(
      'rpc/sales_stats',
      {
        p_term: term || null,
        p_district: district || null,
        p_types: typeGroup ? typeGroup.values.join('|') : null,
        p_include_non_market: includeNonMarket,
      },
      { signal: viewAbort.signal },
    ),
    getRateSeries().catch((e) => { console.error('mortgage rate fetch failed', e); return new Map(); }),
  ]);
  if (requestId !== viewRequestId) return; // superseded by a newer view request
  if (error) {
    console.error(error);
    setSearchPending(false);
    return;
  }

  const agg = data[0];
  if (!agg) {
    setSearchPending(false);
    return;
  }

  document.getElementById('table-heading').textContent = buildFilterHeading(term, district, type);
  renderTable(agg.rows, RESULT_LIMIT, agg.total);
  setupRecentInfiniteScroll(
    buildFilteredPageParams(term, district, typeGroup, includeNonMarket),
    RESULT_LIMIT,
    agg.total,
  );
  applyStatsPayload(agg, rateSeries);
  setViewLoading(false); // clears the initial-load dim if this search overtook it
  setSearchPending(false);
  syncUrl(allowHistoryPush);
}

async function runAddressHistory(address) {
  const requestId = ++viewRequestId;
  viewAbort?.abort();
  viewAbort = new AbortController();
  debouncedFilteredView.cancel(); // an in-flight debounced search must not fire later and kick us back out
  allowHistoryPush = true; // opening an address is a discrete navigation
  viewAddress = address;
  setSearchPending(true);
  hideSuggestions();
  searchInput.value = address;
  toggleClearButton();

  const { data, error, count } = await pg(
    'sales',
    {
      select: SALE_ROW_SELECT,
      address: `eq.${address}`,
      order: 'sale_date.desc',
      limit: RESULT_LIMIT,
    },
    { exactCount: true, signal: viewAbort.signal },
  );
  if (requestId !== viewRequestId) return; // superseded by a newer view request
  if (error) {
    console.error(error);
    setSearchPending(false);
    return;
  }
  document.getElementById('table-heading').textContent = `Sale history: ${address}`;
  applyResultSet(data, RESULT_LIMIT, count);
  setChartsMode('address', data);
  renderAddressDetail(data);
  setViewLoading(false); // clears the initial-load dim if this request overtook it
  setSearchPending(false);
  syncUrl(allowHistoryPush);
  renderValueEstimate(data[0], requestId); // not awaited — a second round trip that shouldn't block the rest of the view
}

function debounce(fn, ms) {
  let t;
  const debounced = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(t);
  return debounced;
}

// --- Browser navigation ---
// The whole dashboard is one URL, so without this Back/Forward would leave the
// site. Each view's state is serialised into the query string and restored on
// popstate, making the views navigable like separate pages (and shareable via
// the URL). See allowHistoryPush/restoringView above for the push-vs-replace
// and restore-suppression rules.

// The URL is a link only to a destination, not to whatever's half-typed:
// an address the user picked (`?address=`) or a chosen filter (`?district=`,
// `?type=`, `?nonmarket=1`). A raw search term is transient typing — it never
// becomes part of the URL, so the address bar stays clean while you type.

// Accepts (but no longer writes) legacy `?q=` URLs shared before this change.
function parseViewFromLocation() {
  const params = new URLSearchParams(location.search);
  const address = params.get('address');
  if (address) return { type: 'address', address };
  const term = params.get('q') ?? '';
  const district = params.get('district') ?? '';
  const typeLabel = params.get('type') ?? '';
  const nonmarket = params.get('nonmarket') === '1';
  if (address || term || district || typeLabel || nonmarket) {
    return { type: 'filtered', term, district, typeLabel, nonmarket };
  }
  return { type: 'default' };
}

function syncUrl(push) {
  if (restoringView) return; // the URL already says where we're going
  const qs = new URLSearchParams();
  if (viewAddress) qs.set('address', viewAddress);
  else {
    if (districtSelect.value) qs.set('district', districtSelect.value);
    if (typeSelect.value) qs.set('type', typeSelect.value);
    if (nonMarketCheckbox.checked) qs.set('nonmarket', '1');
  }
  const targetQs = qs.toString();
  if (targetQs === new URLSearchParams(location.search).toString()) return; // already there — typing never rewrites the bar
  const url = targetQs ? `?${targetQs}` : './';
  if (push) {
    history.pushState(null, '', url);
    allowHistoryPush = false;
  } else {
    history.replaceState(null, '', url);
  }
}

function resetControls() {
  searchInput.value = '';
  districtSelect.value = '';
  typeSelect.value = '';
  nonMarketCheckbox.checked = false;
  toggleClearButton();
  hideSuggestions();
}

function applyFilteredControls(view) {
  searchInput.value = view.term;
  districtSelect.value = view.district;
  typeSelect.value = view.typeLabel;
  nonMarketCheckbox.checked = view.nonmarket;
  toggleClearButton();
  hideSuggestions();
}

// Restores whatever view the URL points to (Back/Forward, or the initial load
// of a deep link). The awaited loader does the fetching; restoringView stays
// non-zero until it finishes so it can't rewrite the URL we just arrived at.
window.addEventListener('popstate', async () => {
  const view = parseViewFromLocation();
  restoringView++;
  try {
    if (view.type === 'address') {
      await runAddressHistory(view.address);
    } else if (view.type === 'filtered') {
      await ensureFilterOptions();
      applyFilteredControls(view);
      await runFilteredView();
    } else {
      resetControls();
      await loadDefaultView();
    }
  } finally {
    restoringView--;
    allowHistoryPush = true; // the next gesture starts a fresh history entry
  }
});

async function loadInitialView() {
  // Treat the first load like a restore: the URL already points at the right
  // view, so suppress URL writes (and don't stack a duplicate history entry
  // for a deep link).
  restoringView++;
  try {
    const view = parseViewFromLocation();
    if (view.type === 'address') {
      await runAddressHistory(view.address);
    } else if (view.type === 'filtered') {
      applyFilteredControls(view);
      await runFilteredView();
    } else {
      await loadDefaultView();
    }
  } finally {
    restoringView--;
  }
  allowHistoryPush = true; // first user navigation pushes a new entry
}

const searchInput = document.getElementById('search');
const nonMarketCheckbox = document.getElementById('include-non-market');
const clearButton = document.getElementById('search-clear');
const suggestionsEl = document.getElementById('suggestions');
const districtSelect = document.getElementById('filter-district');
const typeSelect = document.getElementById('filter-type');
mapWrapEl = document.getElementById('map-wrap');
mapTooltipEl = document.getElementById('map-tooltip');

if (!supportsHover) {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.district-path')) {
      touchPreviewKey = null;
      hideMapTooltip();
    }
  });
}

// 100ms: tight enough that results follow the typing hand (search-as-you-type)
// without firing a query mid-word on every keystroke. The queries are cheap
// now (GIN-backed), and superseded requests are aborted rather than queued.
const debouncedFilteredView = debounce(runFilteredView, 100);

function toggleClearButton() {
  clearButton.hidden = searchInput.value.length === 0;
}

// --- Instant suggestions: district matches are computed client-side against
// the small (~30 row) district list already in memory, so they render on the
// same keystroke with no network round trip. Address matches follow shortly
// after via a short-debounced call to the search_sales RPC, which ranks rows
// by pg_trgm word-similarity — so a typo or partial word still finds the
// address — and are appended to the same dropdown rather than gating it.

function matchDistricts(term) {
  const q = term.toLowerCase();
  if (!q) return [];
  return districtOptions
    .map((d) => {
      const starts = d.synonyms.some((s) => s.startsWith(q));
      const includes = !starts && d.synonyms.some((s) => s.includes(q));
      if (!starts && !includes) return null;
      return { ...d, rank: starts ? 0 : 1 };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || b.sale_count - a.sale_count)
    .slice(0, 5);
}

const fetchAddressSuggestions = debounce(async (term) => {
  const requestId = ++suggestionRequestId;
  suggestAbort?.abort();
  suggestAbort = new AbortController();
  const q = term.trim();
  if (!q) return;

  // Terms that match a postal district — even partially, since "dublin"
  // (or any substring of it) appears in nearly every address — are
  // pathological for the trigram search: the planner estimates a match over
  // most of the ~250k rows, falls back to a sequential scan, and can exceed
  // PostgREST's statement timeout. matchDistricts already answers these
  // inputs fully on the client, so skip the network call for them.
  if (matchDistricts(q).length > 0) {
    addressMatches = [];
    renderSuggestions(q);
    return;
  }

  // The term goes straight to the RPC as a bound parameter — no PostgREST
  // filter syntax is built here, so no escaping (or injection) is involved.
  // This call runs ~3x slower than the main view's RPC, so it holds its own
  // reference on the loading indicator (released in the finally below).
  setSuggestionsPending(true);
  try {
    const { data, error } = await pg(
      'rpc/search_sales',
      { search_term: q, max_results: 30 },
      { signal: suggestAbort.signal },
    );

    if (error || !data || requestId !== suggestionRequestId) return;

    const seen = new Map();
    for (const row of data) {
      if (!seen.has(row.address)) seen.set(row.address, row);
    }
    addressMatches = [...seen.values()].slice(0, 5);
    renderSuggestions(term);
  } finally {
    setSuggestionsPending(false);
  }
}, 120);

function currentSuggestionItems(term) {
  const districts = matchDistricts(term).map((d) => ({ type: 'district', value: d.label, meta: `${d.sale_count} sales` }));
  const addresses = addressMatches.map((a) => ({ type: 'address', value: a.address, meta: a.postal_district || a.eircode || '' }));
  return [...districts, ...addresses];
}

function renderSuggestions(term) {
  const items = currentSuggestionItems(term);
  suggestionsEl.replaceChildren();
  activeSuggestionIndex = -1;

  if (!term || items.length === 0) {
    suggestionsEl.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    return;
  }

  let lastType = null;
  items.forEach((item, i) => {
    if (item.type !== lastType) {
      const label = document.createElement('li');
      label.className = 'group-label';
      label.textContent = item.type === 'district' ? 'Postal districts' : 'Addresses';
      suggestionsEl.appendChild(label);
      lastType = item.type;
    }
    const li = document.createElement('li');
    li.className = 'option';
    li.setAttribute('role', 'option');
    li.dataset.index = i;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.value;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = item.meta;
    li.appendChild(label);
    li.appendChild(meta);
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so 'blur' doesn't fire before the click
      selectSuggestion(item);
    });
    suggestionsEl.appendChild(li);
  });

  suggestionsEl.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}

function selectSuggestion(item) {
  hideSuggestions();
  if (item.type === 'district') {
    allowHistoryPush = true;
    searchInput.value = '';
    toggleClearButton();
    districtSelect.value = item.value;
    runFilteredView();
  } else {
    runAddressHistory(item.value);
  }
}

// Every call site here means "this dropdown must not be showing" — so this
// also cancels fetchAddressSuggestions' pending debounce timer (a still-
// scheduled lookup from a keystroke just before the dismiss would otherwise
// fire ~120ms later and silently reopen the dropdown over whatever the user
// navigated to) and bumps suggestionRequestId to discard a request that's
// already in flight and past cancellation, so its late response can't
// reopen it either.
function hideSuggestions() {
  fetchAddressSuggestions.cancel();
  ++suggestionRequestId;
  suggestionsEl.hidden = true;
  suggestionsEl.replaceChildren();
  activeSuggestionIndex = -1;
  searchInput.setAttribute('aria-expanded', 'false');
}

function moveActiveSuggestion(delta) {
  const options = [...suggestionsEl.querySelectorAll('li.option')];
  if (!options.length) return;
  options[activeSuggestionIndex]?.classList.remove('active');
  activeSuggestionIndex = (activeSuggestionIndex + delta + options.length) % options.length;
  options[activeSuggestionIndex].classList.add('active');
  options[activeSuggestionIndex].scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('input', () => {
  setSearchPending(true); // show "Searching…" during the debounce window too
  toggleClearButton();
  addressMatches = [];
  const term = searchInput.value.trim();
  renderSuggestions(term);
  if (term) fetchAddressSuggestions(term);
  debouncedFilteredView();
});

searchInput.addEventListener('keydown', (e) => {
  if (suggestionsEl.hidden) return;
  const options = [...suggestionsEl.querySelectorAll('li.option')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveActiveSuggestion(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveActiveSuggestion(-1);
  } else if (e.key === 'Enter' && activeSuggestionIndex >= 0) {
    e.preventDefault();
    const items = currentSuggestionItems(searchInput.value.trim());
    selectSuggestion(items[activeSuggestionIndex]);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
  void options;
});

searchInput.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 100);
});

clearButton.addEventListener('click', () => {
  allowHistoryPush = true;
  searchInput.value = '';
  toggleClearButton();
  hideSuggestions();
  runFilteredView(); // respects any district/type filter still set, unlike a hard reset
  searchInput.focus();
});

districtSelect.addEventListener('change', () => {
  allowHistoryPush = true;
  runFilteredView();
});
typeSelect.addEventListener('change', () => {
  allowHistoryPush = true;
  runFilteredView();
});
nonMarketCheckbox.addEventListener('change', () => {
  allowHistoryPush = true;
  runFilteredView();
});

function goHome() {
  debouncedFilteredView.cancel();
  allowHistoryPush = true; // "home" is a view too — Back from it returns to where you were
  resetControls();
  loadDefaultView();
}

const homeLink = document.getElementById('home-link');
homeLink.addEventListener('click', goHome);
homeLink.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    goHome();
  }
});

// --- Next refresh countdown (weekly ingest runs Monday 06:00 UTC) ---
function nextRefreshDate() {
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  let daysUntilMonday = (1 - target.getUTCDay() + 7) % 7;
  if (daysUntilMonday === 0 && now >= target) daysUntilMonday = 7;
  target.setUTCDate(target.getUTCDate() + daysUntilMonday);
  return target;
}

function updateCountdown() {
  const el = document.getElementById('refresh-countdown');
  const diff = nextRefreshDate() - new Date();
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  el.textContent = `${d}d ${h}h ${m}m ${s}s`;
}

updateCountdown();
setInterval(updateCountdown, 1000);

loadInitialView();
loadMortgageRatesTable();
loadRentIndexTable();
