// Plain fetch against PostgREST instead of @supabase/supabase-js — this
// dashboard only ever runs simple SELECTs with the public anon key. The SDK
// bundles Auth, Realtime (a WebSocket client), and Storage, none of which
// anything here touches; that's dead weight worth cutting.
const REST_URL = `${SUPABASE_URL}/rest/v1`;
const REST_HEADERS = { apikey: SUPABASE_ANON_KEY };

async function pg(table, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${REST_URL}/${table}?${qs}`, { headers: REST_HEADERS });
  if (!res.ok) return { data: null, error: await res.text() };
  return { data: await res.json(), error: null };
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

// Same stat, from a raw list of sale rows (the filtered/address-history path).
function newBuildShareFromRows(rows) {
  if (!rows.length) return 0;
  const newCount = rows.filter((r) => propertyTypeLabel(r.property_type) === 'New Build').length;
  return Math.round((newCount / rows.length) * 100);
}

const palette = {
  gridline: '#2c2c2a',
  baseline: '#383835',
  textSecondary: '#c3c2b7',
  textMuted: '#898781',
  series1: '#3987e5',
  series2: '#199e70',
};

Chart.defaults.font.family = '"JetBrains Mono", ui-monospace, monospace';
Chart.defaults.font.size = 12;
Chart.defaults.color = palette.textMuted;
Chart.defaults.animation = false; // plain and live, not a gimmick

const RESULT_LIMIT = 200;
const RECENT_LIMIT = 50;

let quarterlyChart, districtChart, typeChart;
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

function renderQuarterly(rows) {
  const ctx = document.getElementById('chart-quarterly');
  const labels = rows.map((r) => quarterFmt(r.quarter));
  const data = rows.map((r) => Math.round(r.median_price));

  if (quarterlyChart) quarterlyChart.destroy();
  quarterlyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data,
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
  const labels = sorted.map((r) => r.postal_district);
  const data = sorted.map((r) => Math.round(r.median_price));

  if (districtChart) districtChart.destroy();
  districtChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data,
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

function renderType(rows) {
  const ctx = document.getElementById('chart-type');
  const labels = rows.map((r) => propertyTypeLabel(r.property_type));
  const data = rows.map((r) => Math.round(r.median_price));

  if (typeChart) typeChart.destroy();
  typeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data,
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

// A single address is always exactly one district and one property type, so
// those two charts are structurally meaningless there — hide them rather than
// show a one-bar "chart" that isn't telling the reader anything. The quarterly
// chart is repurposed into that address's own raw price history (or hidden
// too, honestly, if there's only one sale to plot).
function setChartsMode(mode, rows = []) {
  const districtCard = document.getElementById('card-district');
  const typeCard = document.getElementById('card-type');
  const quarterlyCard = document.getElementById('card-quarterly');
  const quarterlyHeading = document.getElementById('chart-quarterly-heading');
  const emptyNote = document.getElementById('charts-empty-note');

  if (mode === 'address') {
    districtCard.hidden = true;
    typeCard.hidden = true;
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
    quarterlyCard.hidden = false;
    emptyNote.hidden = true;
    quarterlyHeading.textContent = 'Median price by quarter';
  }
}

function renderAddressPriceChart(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.sale_date) - new Date(b.sale_date));
  const ctx = document.getElementById('chart-quarterly');
  const labels = sorted.map((r) => r.sale_date);
  const data = sorted.map((r) => r.price);

  if (quarterlyChart) quarterlyChart.destroy();
  quarterlyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data,
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

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateFromRows(rows) {
  const byQuarter = new Map();
  const byDistrict = new Map();
  const byType = new Map();

  for (const r of rows) {
    const q = quarterFmt(r.sale_date);
    if (!byQuarter.has(q)) byQuarter.set(q, []);
    byQuarter.get(q).push(r.price);

    if (r.postal_district) {
      if (!byDistrict.has(r.postal_district)) byDistrict.set(r.postal_district, []);
      byDistrict.get(r.postal_district).push(r.price);
    }

    if (r.property_type) {
      const label = propertyTypeLabel(r.property_type);
      if (!byType.has(label)) byType.set(label, []);
      byType.get(label).push(r.price);
    }
  }

  return {
    quarterly: [...byQuarter.entries()].map(([quarter, prices]) => ({
      quarter,
      median_price: median(prices),
    })),
    district: [...byDistrict.entries()].map(([postal_district, prices]) => ({
      postal_district,
      median_price: median(prices),
    })),
    type: [...byType.entries()].map(([property_type, prices]) => ({
      property_type,
      median_price: median(prices),
    })),
  };
}

// PPR only records size as a coarse sentence ("greater than or equal to 38
// sq metres and less than 125 sq metres"); this pulls out just the numbers
// for a table cell. Falls back to the raw sentence for any phrasing it
// doesn't recognise, so nothing is silently dropped.
function shortSize(desc) {
  if (!desc) return null;
  const range = desc.match(/greater than or equal to (\d+) sq metres and less than (\d+) sq metres/i);
  if (range) return `${range[1]}–${range[2]} m²`;
  const min = desc.match(/greater than or equal to (\d+) sq metres/i);
  if (min) return `≥${min[1]} m²`;
  const max = desc.match(/less than (\d+) sq metres/i);
  if (max) return `<${max[1]} m²`;
  return desc;
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

function renderTable(rows, cap) {
  const body = document.getElementById('table-body');
  body.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');

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
  }
  const note = document.getElementById('result-note');
  if (rows.length >= cap) {
    note.textContent = `Showing first ${cap} matches`;
  } else {
    note.textContent = `${rows.length} result${rows.length === 1 ? '' : 's'}`;
  }
}

async function loadDefaultView() {
  const requestId = ++viewRequestId;
  document.getElementById('table-heading').textContent = 'Recent sales';
  document.getElementById('result-note').textContent = '';
  document.getElementById('address-detail').hidden = true;

  const [summaryRes, quarterly, district, type, recent] = await Promise.all([
    pg('sales_summary', { select: '*' }),
    pg('sales_quarterly', { select: '*' }),
    pg('sales_by_district', { select: '*' }),
    pg('sales_by_type', { select: '*' }),
    pg('sales', {
      select: 'sale_date,address,postal_district,eircode,property_type,price,size_description,vat_exclusive,not_full_market_price',
      order: 'sale_date.desc',
      limit: RECENT_LIMIT,
    }),
  ]);
  if (requestId !== viewRequestId) return; // a newer view request has since started

  const summary = summaryRes.data?.[0];
  if (summary) {
    document.getElementById('stat-total').textContent = summary.total_sales.toLocaleString();
    document.getElementById('stat-median').textContent = eur.format(summary.median_price);
    document.getElementById('stat-newbuild').textContent = `${newBuildShareFromCounts(type.data || [])}%`;
    document.getElementById('stat-latest').textContent = summary.latest_sale_date;
  }

  setChartsMode('aggregate');
  renderQuarterly(quarterly.data || []);
  renderDistrict(district.data || []);
  renderType(mergeTypeRows(type.data || []));
  renderTable(recent.data || [], RECENT_LIMIT);

  districtOptions = (district.data || []).map((d) => ({
    label: d.postal_district,
    sale_count: d.sale_count,
    synonyms: districtSynonyms(d.postal_district),
  }));
  typeOptions = buildTypeOptions(type.data || []);
  populateFilterSelects();
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

function escapeForFilter(term) {
  return term.replace(/[%,"\\]/g, '');
}

// Stored Eircodes have no space ("D03C640"); people type them either way
// ("D03 C640" or "D03C640"), so match against a space-stripped copy of the
// term on that column only — address/district text still wants real spaces.
function escapeForEircodeFilter(term) {
  return escapeForFilter(term).replace(/\s+/g, '');
}

// Stats + table are shared by every result-set view; chart handling differs
// (aggregate charts for a filtered list, a dedicated price-history chart for
// a single address — see setChartsMode), so it's kept separate.
function applyResultSet(data, cap) {
  renderTable(data, cap);
  document.getElementById('address-detail').hidden = true; // re-shown by renderAddressDetail when relevant
  document.getElementById('stat-total').textContent = data.length.toLocaleString();
  document.getElementById('stat-median').textContent = eur.format(median(data.map((r) => r.price)));
  document.getElementById('stat-newbuild').textContent = `${newBuildShareFromRows(data)}%`;
  document.getElementById('stat-latest').textContent = data.length ? data[0].sale_date : '—';
}

function applyAggregateCharts(data) {
  setChartsMode('aggregate');
  const agg = aggregateFromRows(data);
  renderQuarterly(agg.quarterly.sort((a, b) => a.quarter.localeCompare(b.quarter)));
  renderDistrict(agg.district);
  renderType(agg.type);
}

function buildFilterHeading(term, district, type) {
  const parts = [];
  if (term) parts.push(`"${term}"`);
  if (district) parts.push(district);
  if (type) parts.push(type); // already a merged label ("New Build" / "Resale")
  return parts.length ? `Filtered sales — ${parts.join(' · ')}` : 'Recent sales';
}

// The single query path behind search text, the district select, the
// property-type select, and the non-market checkbox — every control reads
// its own current value here, so no combination of them can go stale or
// contradict what's on screen (the bug where unchecking the checkbox re-ran
// a stale search instead of the active view).
async function runFilteredView() {
  const requestId = ++viewRequestId;
  const term = searchInput.value.trim();
  const district = districtSelect.value;
  const type = typeSelect.value;
  const includeNonMarket = nonMarketCheckbox.checked;

  if (!term && !district && !type && !includeNonMarket) {
    await loadDefaultView();
    return;
  }

  const params = {
    select: 'sale_date,address,postal_district,eircode,property_type,price,size_description,vat_exclusive,not_full_market_price',
    order: 'sale_date.desc',
    limit: RESULT_LIMIT,
  };

  if (term) {
    const safe = escapeForFilter(term);
    const safeEircode = escapeForEircodeFilter(term);
    params.or = `(address.ilike.%${safe}%,eircode.ilike.%${safeEircode}%,postal_district.ilike.%${safe}%)`;
  }
  if (district) params.postal_district = `eq.${district}`;
  if (type) {
    // "type" is a merged label ("New Build"); match every raw source string
    // that folds into it (see PROPERTY_TYPE_LABELS), including the Irish-
    // language variants, not just the common English one.
    const group = typeOptions.find((t) => t.label === type);
    if (group) params.property_type = `in.(${group.values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(',')})`;
  }
  if (!includeNonMarket) params.not_full_market_price = 'eq.false';

  const { data, error } = await pg('sales', params);
  if (requestId !== viewRequestId) return; // superseded by a newer view request
  if (error) {
    console.error(error);
    return;
  }

  document.getElementById('table-heading').textContent = buildFilterHeading(term, district, type);
  applyResultSet(data, RESULT_LIMIT);
  applyAggregateCharts(data);
}

async function runAddressHistory(address) {
  const requestId = ++viewRequestId;
  debouncedFilteredView.cancel(); // an in-flight debounced search must not fire later and kick us back out
  hideSuggestions();
  searchInput.value = address;
  toggleClearButton();

  const { data, error } = await pg('sales', {
    select: 'sale_date,address,postal_district,eircode,property_type,price,size_description,vat_exclusive,not_full_market_price',
    address: `eq.${address}`,
    order: 'sale_date.desc',
    limit: RESULT_LIMIT,
  });
  if (requestId !== viewRequestId) return; // superseded by a newer view request
  if (error) {
    console.error(error);
    return;
  }
  document.getElementById('table-heading').textContent = `Sale history: ${address}`;
  applyResultSet(data, RESULT_LIMIT);
  setChartsMode('address', data);
  renderAddressDetail(data);
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

const searchInput = document.getElementById('search');
const nonMarketCheckbox = document.getElementById('include-non-market');
const clearButton = document.getElementById('search-clear');
const suggestionsEl = document.getElementById('suggestions');
const districtSelect = document.getElementById('filter-district');
const typeSelect = document.getElementById('filter-type');

const debouncedFilteredView = debounce(runFilteredView, 300);

function toggleClearButton() {
  clearButton.hidden = searchInput.value.length === 0;
}

// --- Instant suggestions: district matches are computed client-side against
// the small (~30 row) district list already in memory, so they render on the
// same keystroke with no network round trip. Address matches follow shortly
// after via a short-debounced, trigram-indexed query, and are appended to
// the same dropdown rather than gating it.

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
  const safe = escapeForFilter(term.trim());
  const safeEircode = escapeForEircodeFilter(term.trim());
  if (!safe) return;

  const { data, error } = await pg('sales', {
    select: 'address,postal_district,eircode,sale_date',
    or: `(address.ilike.%${safe}%,eircode.ilike.%${safeEircode}%)`,
    order: 'sale_date.desc',
    limit: 30,
  });

  if (error || requestId !== suggestionRequestId) return;

  const seen = new Map();
  for (const row of data) {
    if (!seen.has(row.address)) seen.set(row.address, row);
  }
  addressMatches = [...seen.values()].slice(0, 5);
  renderSuggestions(term);
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

searchInput.addEventListener('focus', () => {
  const term = searchInput.value.trim();
  if (term) renderSuggestions(term);
});

searchInput.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 100);
});

clearButton.addEventListener('click', () => {
  searchInput.value = '';
  toggleClearButton();
  hideSuggestions();
  runFilteredView(); // respects any district/type filter still set, unlike a hard reset
  searchInput.focus();
});

districtSelect.addEventListener('change', runFilteredView);
typeSelect.addEventListener('change', runFilteredView);
nonMarketCheckbox.addEventListener('change', runFilteredView);

function goHome() {
  debouncedFilteredView.cancel();
  searchInput.value = '';
  districtSelect.value = '';
  typeSelect.value = '';
  nonMarketCheckbox.checked = false;
  toggleClearButton();
  hideSuggestions();
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

loadDefaultView();
