const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

const RESULT_LIMIT = 200;
const RECENT_LIMIT = 50;

let quarterlyChart, districtChart, typeChart;

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
    const cells = [
      dateFmt.format(new Date(r.sale_date)),
      r.address,
      r.postal_district || '—',
      r.eircode || '—',
      r.property_type?.replace(' Dwelling house /Apartment', '') || '—',
      eur.format(r.price),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === cells.length - 1) td.className = 'num';
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
    supabase.from('sales_summary').select('*').single(),
    supabase.from('sales_quarterly').select('*'),
    supabase.from('sales_by_district').select('*'),
    supabase.from('sales_by_type').select('*'),
    supabase.from('sales').select('sale_date,address,postal_district,eircode,property_type,price').order('sale_date', { ascending: false }).limit(RECENT_LIMIT),
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
}

function escapeForFilter(term) {
  return term.replace(/[%,"\\]/g, '');
}

async function runSearch(term, includeNonMarket) {
  const safe = escapeForFilter(term.trim());
  let query = supabase
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
  renderTable(data, RESULT_LIMIT);

  const agg = aggregateFromRows(data);
  renderQuarterly(agg.quarterly.sort((a, b) => a.quarter.localeCompare(b.quarter)));
  renderDistrict(agg.district);
  renderType(agg.type);

  document.getElementById('stat-total').textContent = data.length.toLocaleString();
  document.getElementById('stat-median').textContent = eur.format(median(data.map((r) => r.price)));
  document.getElementById('stat-districts').textContent = new Set(data.map((r) => r.postal_district).filter(Boolean)).size;
  document.getElementById('stat-latest').textContent = data.length ? dateFmt.format(new Date(data[0].sale_date)) : '—';
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

const triggerSearch = debounce(() => {
  const term = searchInput.value.trim();
  if (term) {
    runSearch(term, nonMarketCheckbox.checked);
  } else {
    loadDefaultView();
  }
}, 300);

searchInput.addEventListener('input', triggerSearch);
nonMarketCheckbox.addEventListener('change', triggerSearch);

loadDefaultView();
