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
async function pg(table, params, { exactCount = false, signal } = {}) {
  const qs = new URLSearchParams(params).toString();
  const headers = exactCount ? { ...REST_HEADERS, Prefer: 'count=exact' } : REST_HEADERS;
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

// The four stat tiles mean different things depending on the view, so their
// labels are set with the values. Overview: the whole register since 2010.
// Filtered: whatever matches the active search/filters. Address: that single
// property's own record — where "New build share" is meaningless (a house is
// either new-built once or not) and "Price range" says what actually matters.
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
    labels.newbuild.textContent = 'Price range';
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
  // Only the address view ever hides this tile, and only when there's a
  // single sale (see applyResultSet); every other mode always shows it.
  document.getElementById('stat-newbuild-tile').hidden = mode === 'address';
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
Chart.defaults.animation = { duration: 450, easing: 'easeOutQuart' }; // subtle, quick — not a gimmick

const RESULT_LIMIT = 200;
const RECENT_LIMIT = 50;

let quarterlyChart, districtChart, typeChart, planningChart;
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
    path.setAttribute('role', 'button');
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

    path.addEventListener('mouseenter', (e) => showMapTooltip(e, label, row?.median_price, row?.sale_count));
    path.addEventListener('mousemove', positionMapTooltip);
    path.addEventListener('mouseleave', hideMapTooltip);
    path.addEventListener('focus', (e) => showMapTooltip(e, label, row?.median_price, row?.sale_count));
    path.addEventListener('blur', hideMapTooltip);

    const activate = () => {
      districtFilterActivate(label);
    };
    path.addEventListener('click', activate);
    path.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

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

// --- CSO planning permissions (BHQ13) ---
// Dwelling units granted planning permission in Dublin, quarterly, straight
// from the CSO's open-data API (JSON-stat 2.0, no key). This is a one-shot
// third-party fetch, unrelated to the Supabase pipeline — it loads once on
// startup, isn't tied to any view, and if the CSO is unreachable the card
// hides itself quietly rather than taking the dashboard down.
const CSO_PLANNING_URL = 'https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/BHQ13/JSON-stat/2.0/en';

// CSO quarter codes are "2018Q1"; the rest of the dashboard renders quarters
// as "2018 Q1", so normalise to match.
function formatPlanningQuarter(code) {
  return code.replace(/^(\d{4})Q(\d)$/, '$1 Q$2');
}

// The CSO suppresses small cells (too few observations to publish safely)
// with "." / ".." — a suppressed count is NOT a zero, so such cells parse to
// null and the chart draws a gap instead of a misleading dip.
function planningValue(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const t = `${raw}`.trim();
  return /^[0-9]+$/.test(t) ? Number.parseInt(t, 10) : null;
}

// Returns the position of `label` within a JSON-stat dimension's own
// category.index order (not the code — the label), or -1 if absent.
function planningDimIndex(cube, dimId, label) {
  const dim = cube.dimension[dimId];
  return dim.category.index.findIndex((code) => dim.category.label[code] === label);
}

// BHQ13's cube dimensions are [statistic, quarter, construction type,
// functional category, region] and `cube.value` is flattened in that order.
// Each value's flat index is the dot product of per-dimension positions and
// strides, where stride[i] = product of the category sizes of every
// dimension after i. Work the strides out generically from j.id and the
// dimensions' own sizes, and resolve "Dublin" / "Dwellings" / "All types of
// construction" from the labels, so nothing here assumes a fixed layout.
function planningSeries(cube) {
  const dims = cube.id;
  const size = (id) => cube.dimension[id].category.index.length;
  const stride = dims.map((id, i) => dims.slice(i + 1).reduce((acc, laterId) => acc * size(laterId), 1));

  const QUARTER = 'TLIST(Q1)';
  const CONSTRUCTION = 'C01921V02511';
  const CATEGORY = 'C02074V02506';
  const REGION = 'C02196V04140';

  const regionIdx = planningDimIndex(cube, REGION, 'Dublin');
  const categoryIdx = planningDimIndex(cube, CATEGORY, 'Dwellings');
  const constructionIdx = planningDimIndex(cube, CONSTRUCTION, 'All types of construction');
  if (regionIdx < 0 || categoryIdx < 0 || constructionIdx < 0) {
    throw new Error('CSO BHQ13 cube missing expected labels');
  }

  const quarterCodes = cube.dimension[QUARTER].category.index;
  const flatIndex = (q) =>
    stride.reduce((acc, s, i) => acc + (dims[i] === QUARTER ? q : 0) * s, 0) +
    constructionIdx * stride[dims.indexOf(CONSTRUCTION)] +
    categoryIdx * stride[dims.indexOf(CATEGORY)] +
    regionIdx * stride[dims.indexOf(REGION)];

  return quarterCodes.map((code, q) => ({
    label: formatPlanningQuarter(code),
    value: planningValue(cube.value[flatIndex(q)]),
  }));
}

function renderPlanning(points) {
  const ctx = document.getElementById('chart-planning');
  planningChart = upsertChart(planningChart, ctx, {
    type: 'line',
    data: {
      labels: points.map((p) => p.label),
      datasets: [
        {
          data: points.map((p) => p.value),
          borderColor: palette.series2,
          backgroundColor: palette.series2 + '1a',
          borderWidth: 2,
          pointRadius: 2,
          pointBackgroundColor: palette.series2,
          pointBorderColor: '#1a1a19',
          pointBorderWidth: 1,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: palette.series2,
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
          callbacks: {
            // Counts, not prices — the eurCompact axis callback in baseScales
            // doesn't fit here, so this chart's scales are spelled out.
            label: (c) => (c.parsed.y == null ? 'No data' : `${c.parsed.y.toLocaleString()} dwelling units`),
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
          grid: { color: palette.gridline },
          border: { display: false },
          ticks: { color: palette.textMuted },
          beginAtZero: true,
        },
      },
    },
  });
}

async function loadPlanningPermissions() {
  try {
    const res = await fetch(CSO_PLANNING_URL);
    if (!res.ok) throw new Error(`CSO planning API responded ${res.status}`);
    renderPlanning(planningSeries(await res.json()));
  } catch (e) {
    // A third-party API being down must not break the dashboard — hide the
    // card and leave a console note instead of throwing.
    console.warn('Could not load CSO planning-permission data:', e);
    document.getElementById('card-planning').hidden = true;
  }
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
  const quarterlyCard = document.getElementById('card-quarterly');
  const quarterlyHeading = document.getElementById('chart-quarterly-heading');
  const emptyNote = document.getElementById('charts-empty-note');

  if (mode === 'address') {
    districtCard.hidden = true;
    typeCard.hidden = true;
    mapCard.hidden = true; // same reasoning as the district bar chart — one address is one district
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
    quarterlyCard.hidden = false;
    emptyNote.hidden = true;
    quarterlyHeading.textContent = 'Median price by quarter';
  }
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

function renderTable(rows, cap, trueTotal) {
  const body = document.getElementById('table-body');
  body.replaceChildren();
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${Math.min(i, 12) * 8}ms`;

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

    body.appendChild(tr);
  });
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
    const [summaryRes, quarterly, district, type, recent] = await Promise.all([
      pg('sales_summary', { select: '*' }, { signal }),
      pg('sales_quarterly', { select: '*' }, { signal }),
      pg('sales_by_district', { select: '*' }, { signal }),
      pg('sales_by_type', { select: '*' }, { signal }),
      pg('sales', {
        select: 'sale_date,address,postal_district,eircode,property_type,price,size_description,vat_exclusive,not_full_market_price',
        order: 'sale_date.desc',
        limit: RECENT_LIMIT,
      }, { signal }),
    ]);
    if (requestId !== viewRequestId) return; // a newer view request has since started
    defaultViewCache = {
      summary: summaryRes.data?.[0],
      quarterly: quarterly.data || [],
      district: district.data || [],
      type: type.data || [],
      recent: recent.data || [],
    };
  }

  const { summary, quarterly, district, type, recent } = defaultViewCache;
  setStatLabels('aggregate');
  if (summary) {
    setStat('stat-total', summary.total_sales.toLocaleString());
    setStat('stat-median', eur.format(summary.median_price));
    setStat('stat-newbuild', `${newBuildShareFromCounts(type)}%`);
    setStat('stat-latest', summary.latest_sale_date);
  }

  setChartsMode('aggregate');
  renderQuarterly(quarterly);
  renderDistrict(district);
  renderMap(district);
  renderType(mergeTypeRows(type));
  renderTable(recent, RECENT_LIMIT);

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
  renderTable(data, cap, trueTotal);
  document.getElementById('address-detail').hidden = true; // re-shown by renderAddressDetail when relevant
  const latest = data.length ? data[0] : null; // rows come back ordered by sale_date desc
  setStat('stat-total', (trueTotal ?? data.length).toLocaleString());
  setStat('stat-median', latest && latest.price != null ? eur.format(latest.price) : '—');
  const prices = data.map((r) => r.price).filter(Boolean);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  setStat(
    'stat-newbuild',
    prices.length > 1
      ? `${eur.format(minPrice)} – ${eur.format(maxPrice)}`
      : prices.length === 1
        ? eur.format(minPrice)
        : '—',
  );
  setStat('stat-latest', latest ? latest.sale_date : '—');
  // A single sale has no spread worth showing; the "Latest sale price" tile
  // already carries it.
  document.getElementById('stat-newbuild-tile').hidden = data.length < 2;

  const capNote = document.getElementById('charts-cap-note');
  if (trueTotal && trueTotal > cap) {
    capNote.textContent = `Median, price range and charts below reflect only the ${cap.toLocaleString()} shown sales, not all ${trueTotal.toLocaleString()}.`;
    capNote.hidden = false;
  } else {
    capNote.hidden = true;
  }
}

function buildFilterHeading(term, district, type) {
  const parts = [];
  if (term) parts.push(`"${term}"`);
  if (district) parts.push(district);
  if (type) parts.push(type); // already a merged label ("New Build" / "Resale")
  return parts.length ? `Filtered sales — ${parts.join(' · ')}` : 'Recent sales';
}

// Renders a filtered view's stats + charts from a sales_stats RPC result
// (see supabase/schema.sql): server-computed medians and series that cover
// every matching sale, not just the 200-row page. `rows` in the payload is
// the capped page for the table; `total` is the true match count.
function applyStatsPayload(agg) {
  setStatLabels('filtered');
  document.getElementById('address-detail').hidden = true;
  document.getElementById('charts-cap-note').hidden = true; // stats/charts cover all matches, not the page
  setStat('stat-total', agg.total.toLocaleString());
  setStat('stat-median', eur.format(agg.median_price));
  setStat('stat-newbuild', `${newBuildShareFromCounts(agg.types)}%`);
  setStat('stat-latest', agg.latest_sale_date || '—');
  setChartsMode('aggregate');
  renderQuarterly(agg.quarterly);
  renderDistrict(agg.districts);
  renderMap(agg.districts);
  renderType(mergeTypeRows(agg.types));
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
  const { data, error } = await pg(
    'rpc/sales_stats',
    {
      p_term: term || null,
      p_district: district || null,
      p_types: typeGroup ? typeGroup.values.join('|') : null,
      p_include_non_market: includeNonMarket,
    },
    { signal: viewAbort.signal },
  );
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
  applyStatsPayload(agg);
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
      select: 'sale_date,address,postal_district,eircode,property_type,price,size_description,vat_exclusive,not_full_market_price',
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

function hideSuggestions() {
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
loadPlanningPermissions();
