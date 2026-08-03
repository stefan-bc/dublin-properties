const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
const dateFmt = new Intl.DateTimeFormat('en-IE', { year: 'numeric', month: 'short', day: 'numeric' });
const quarterFmt = (isoDate) => {
  const d = new Date(isoDate);
  return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

const palette = {
  gridline: '#2c2c2a',
  baseline: '#383835',
  textSecondary: '#c3c2b7',
  textMuted: '#898781',
  series1: '#3987e5',
  series2: '#d95926',
};

Chart.defaults.font.family = '"JetBrains Mono", ui-monospace, monospace';
Chart.defaults.font.size = 12;
Chart.defaults.color = palette.textMuted;
Chart.defaults.animation = false; // plain and live, not a gimmick

const RESULT_LIMIT = 200;
const RECENT_LIMIT = 50;

let quarterlyChart, districtChart, typeChart;
let districtOptions = [];
let addressMatches = [];
let activeSuggestionIndex = -1;
let suggestionRequestId = 0;

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
  const labels = rows.map((r) => r.property_type.replace(' Dwelling house /Apartment', ''));
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
      if (!byType.has(r.property_type)) byType.set(r.property_type, []);
      byType.get(r.property_type).push(r.price);
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

function renderTable(rows, cap) {
  const body = document.getElementById('table-body');
  body.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');

    const dateTd = document.createElement('td');
    dateTd.textContent = dateFmt.format(new Date(r.sale_date));
    tr.appendChild(dateTd);

    const addressTd = document.createElement('td');
    addressTd.className = 'address-cell';
    addressTd.textContent = r.address;
    addressTd.title = 'View full sale history for this address';
    addressTd.addEventListener('click', () => runAddressHistory(r.address));
    tr.appendChild(addressTd);

    const rest = [
      r.postal_district || '—',
      r.eircode || '—',
      r.property_type?.replace(' Dwelling house /Apartment', '') || '—',
      eur.format(r.price),
    ];
    rest.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === rest.length - 1) td.className = 'num';
      td.textContent = text;
      tr.appendChild(td);
    });

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
  document.getElementById('table-heading').textContent = 'Recent sales';
  document.getElementById('result-note').textContent = '';

  const [summary, quarterly, district, type, recent] = await Promise.all([
    supabaseClient.from('sales_summary').select('*').single(),
    supabaseClient.from('sales_quarterly').select('*'),
    supabaseClient.from('sales_by_district').select('*'),
    supabaseClient.from('sales_by_type').select('*'),
    supabaseClient.from('sales').select('sale_date,address,postal_district,eircode,property_type,price').order('sale_date', { ascending: false }).limit(RECENT_LIMIT),
  ]);

  if (summary.data) {
    document.getElementById('stat-total').textContent = summary.data.total_sales.toLocaleString();
    document.getElementById('stat-median').textContent = eur.format(summary.data.median_price);
    document.getElementById('stat-districts').textContent = summary.data.district_count;
    document.getElementById('stat-latest').textContent = dateFmt.format(new Date(summary.data.latest_sale_date));
  }

  renderQuarterly(quarterly.data || []);
  renderDistrict(district.data || []);
  renderType(type.data || []);
  renderTable(recent.data || [], RECENT_LIMIT);

  districtOptions = (district.data || []).map((d) => ({
    label: d.postal_district,
    sale_count: d.sale_count,
    synonyms: districtSynonyms(d.postal_district),
  }));
}

function escapeForFilter(term) {
  return term.replace(/[%,"\\]/g, '');
}

// Shared by every "here is a filtered set of sales" view: search, a single
// district, or a single address's history — table, charts, and stat tiles
// all read from the same rows so the numbers on screen always agree.
function applyResultSet(data, cap) {
  renderTable(data, cap);

  const agg = aggregateFromRows(data);
  renderQuarterly(agg.quarterly.sort((a, b) => a.quarter.localeCompare(b.quarter)));
  renderDistrict(agg.district);
  renderType(agg.type);

  document.getElementById('stat-total').textContent = data.length.toLocaleString();
  document.getElementById('stat-median').textContent = eur.format(median(data.map((r) => r.price)));
  document.getElementById('stat-districts').textContent = new Set(data.map((r) => r.postal_district).filter(Boolean)).size;
  document.getElementById('stat-latest').textContent = data.length ? dateFmt.format(new Date(data[0].sale_date)) : '—';
}

async function runSearch(term, includeNonMarket) {
  const safe = escapeForFilter(term.trim());
  let query = supabaseClient
    .from('sales')
    .select('sale_date,address,postal_district,eircode,property_type,price,not_full_market_price')
    .or(`address.ilike.%${safe}%,eircode.ilike.%${safe}%,postal_district.ilike.%${safe}%`)
    .order('sale_date', { ascending: false })
    .limit(RESULT_LIMIT);

  if (!includeNonMarket) query = query.eq('not_full_market_price', false);

  const { data, error } = await query;
  if (error) {
    console.error(error);
    return;
  }

  document.getElementById('table-heading').textContent = `Search results for "${term.trim()}"`;
  applyResultSet(data, RESULT_LIMIT);
}

async function runDistrictFilter(label) {
  const { data, error } = await supabaseClient
    .from('sales')
    .select('sale_date,address,postal_district,eircode,property_type,price,not_full_market_price')
    .eq('postal_district', label)
    .eq('not_full_market_price', false)
    .order('sale_date', { ascending: false })
    .limit(RESULT_LIMIT);
  if (error) {
    console.error(error);
    return;
  }
  document.getElementById('table-heading').textContent = `Sales in ${label}`;
  applyResultSet(data, RESULT_LIMIT);
}

async function runAddressHistory(address) {
  hideSuggestions();
  searchInput.value = address;
  toggleClearButton();

  const { data, error } = await supabaseClient
    .from('sales')
    .select('sale_date,address,postal_district,eircode,property_type,price,not_full_market_price')
    .eq('address', address)
    .order('sale_date', { ascending: false })
    .limit(RESULT_LIMIT);
  if (error) {
    console.error(error);
    return;
  }
  document.getElementById('table-heading').textContent = `Sale history: ${address}`;
  applyResultSet(data, RESULT_LIMIT);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const searchInput = document.getElementById('search');
const nonMarketCheckbox = document.getElementById('include-non-market');
const clearButton = document.getElementById('search-clear');
const suggestionsEl = document.getElementById('suggestions');

const triggerSearch = debounce(() => {
  const term = searchInput.value.trim();
  if (term) {
    runSearch(term, nonMarketCheckbox.checked);
  } else {
    loadDefaultView();
  }
}, 300);

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
  if (!safe) return;

  const { data, error } = await supabaseClient
    .from('sales')
    .select('address,postal_district,eircode,sale_date')
    .or(`address.ilike.%${safe}%,eircode.ilike.%${safe}%`)
    .order('sale_date', { ascending: false })
    .limit(30);

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
  searchInput.value = item.value;
  toggleClearButton();
  if (item.type === 'district') {
    runDistrictFilter(item.value);
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
  triggerSearch();
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
  loadDefaultView();
  searchInput.focus();
});

nonMarketCheckbox.addEventListener('change', triggerSearch);

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
