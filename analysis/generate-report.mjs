// Generates the data + charts behind analysis/dublin-housing-report.md.
// Reads live data from the Supabase PostgREST API with the public anon key
// (same read-only path the dashboard uses), computes the findings, and writes
// analysis/data.json plus the SVGs under analysis/charts/. The report's prose
// is written by hand on top of that snapshot, so rerun here → inspect
// data.json → update the report whenever the register refreshes.
//
// All figures exclude "not full market price" rows (gifts, part-transfers)
// unless stated — the same default the dashboard uses.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const configSrc = await fs.readFile(path.join(dir, '..', 'config.js'), 'utf8');
const SUPABASE_URL = configSrc.match(/SUPABASE_URL = '([^']+)'/)?.[1];
const ANON_KEY = configSrc.match(/SUPABASE_ANON_KEY = '([^']+)'/)?.[1];
if (!SUPABASE_URL || !ANON_KEY) throw new Error('could not read config.js');
const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = { apikey: ANON_KEY };

// The only property_type strings in the data (verified against sales_by_type):
// two plain-English labels and a handful of Irish-language / mis-encoded rows.
const NEW_TYPES = ['New Dwelling house /Apartment', 'Teach/Árasán Cónaithe Nua', 'Teach/?ras?n C?naithe Nua'];
const RESALE_TYPES = ['Second-Hand Dwelling house /Apartment', 'Teach/Árasán Cónaithe Atháimhe'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (vals) => {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function get(apiPath, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${REST}/${apiPath}?${qs}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${apiPath} ${res.status}: ${await res.text()}`);
  return res.json();
}

// Fetches every price for a filter, paginated, and returns its median.
// `pairs` is an array of [key, value] pairs so the same column can be
// filtered twice (e.g. sale_date gte + lte) — plain objects can't express
// duplicate keys, and this Supabase instance rejects the `column.gte=` form.
async function medianFor(pairs) {
  const prices = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await get('sales', [
      ['select', 'price'],
      ['limit', '1000'],
      ['offset', String(offset)],
      ['order', 'sale_date.asc'],
      ...pairs,
    ]);
    if (!rows.length) break;
    rows.forEach((r) => prices.push(Number(r.price)));
    if (rows.length < 1000) break;
    await sleep(30);
  }
  return median(prices);
}

// Cheap exact count (Content-Range header), no body.
async function countFor(pairs) {
  const qs = new URLSearchParams([['select', 'id'], ...pairs]).toString();
  const res = await fetch(`${REST}/sales?${qs}`, {
    headers: { ...HEADERS, Range: '0-0', Prefer: 'count=exact' },
  });
  if (!res.ok) throw new Error(`count ${res.status}: ${await res.text()}`);
  const cr = res.headers.get('content-range');
  return cr ? Number(cr.split('/')[1]) : null;
}

// Point-fetch the price at one rank index of a price-ordered filtered set,
// using the Range header to ask for exactly that row instead of paginating
// everything. Percentiles then cost one exact-count request + one fetch each.
async function priceAtIndex(pairs, index) {
  const qs = new URLSearchParams([['select', 'price'], ...pairs, ['order', 'price.asc']]).toString();
  const res = await fetch(`${REST}/sales?${qs}`, { headers: { ...HEADERS, Range: `${index}-${index}` } });
  if (!res.ok) throw new Error(`priceAtIndex ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] ? Number(rows[0].price) : null;
}

// Nearest-rank percentiles of a filtered set without pulling every row.
// p at index floor(p*(n-1)) — matches percentile_cont on the sorted sample.
async function percentilesFor(pairs, ps = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const n = await countFor(pairs);
  if (!n) return null;
  const out = { count: n };
  for (const p of ps) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
    out[`p${Math.round(p * 100)}`] = await priceAtIndex(pairs, idx);
    await sleep(30);
  }
  return out;
}

const inList = (values) => `in.(${values.map((v) => `"${v}"`).join(',')})`;
const yearRange = (y) => [['sale_date', `gte.${y}-01-01`], ['sale_date', `lte.${y}-12-31`]];
const MARKET = [['not_full_market_price', 'eq.false']];
const districtEq = (d) => [['postal_district', `eq.${d}`]];
const typeFilter = (types) => [['property_type', inList(types)]];

// --- Pull everything --------------------------------------------------------

const [summary, quarterly, byDistrict, byType] = await Promise.all([
  get('sales_summary', { select: '*' }),
  get('sales_quarterly', { select: '*', order: 'quarter.asc' }),
  get('sales_by_district', { select: '*', order: 'sale_count.desc' }),
  get('sales_by_type', { select: '*', order: 'sale_count.desc' }),
]);

const total = summary[0]?.total_sales;
const overallMedian = summary[0]?.median_price;
const latestSale = summary[0]?.latest_sale_date;
const nonMarketCount = await countFor([['not_full_market_price', 'eq.true']]);
const vatExclusiveCount = await countFor([['vat_exclusive', 'eq.true'], ...MARKET]);

// Headline market move: Dublin-wide resale median, 2010 vs 2025.
const [m2010, m2025] = await Promise.all([
  medianFor([...typeFilter(RESALE_TYPES), ...MARKET, ...yearRange(2010)]),
  medianFor([...typeFilter(RESALE_TYPES), ...MARKET, ...yearRange(2025)]),
]);

// Per-district resale growth 2010 -> 2025 (min 20 resales in each year).
const districts = byDistrict.map((d) => d.postal_district).filter(Boolean);
const growth = [];
for (const district of districts) {
  const base = [...districtEq(district), ...typeFilter(RESALE_TYPES), ...MARKET];
  const [y2010, y2025] = await Promise.all([
    medianFor([...base, ...yearRange(2010)]),
    medianFor([...base, ...yearRange(2025)]),
  ]);
  growth.push({ district, median_2010: y2010, median_2025: y2025 });
  await sleep(30);
}

// New-build vs resale premium, 2020-2025 (min 10 of each type in the window).
const RECENT = [['sale_date', 'gte.2020-01-01'], ['sale_date', 'lte.2025-12-31']];
const premiums = [];
for (const district of districts) {
  const base = [...districtEq(district), ...MARKET, ...RECENT];
  const [newCount, resaleCount] = await Promise.all([
    countFor([...base, ...typeFilter(NEW_TYPES)]),
    countFor([...base, ...typeFilter(RESALE_TYPES)]),
  ]);
  if (newCount < 10 || resaleCount < 10) {
    premiums.push({ district, new_build_count: newCount, resale_count: resaleCount });
    await sleep(30);
    continue;
  }
  const [newMedian, resaleMedian] = await Promise.all([
    medianFor([...base, ...typeFilter(NEW_TYPES)]),
    medianFor([...base, ...typeFilter(RESALE_TYPES)]),
  ]);
  premiums.push({
    district,
    new_build_count: newCount,
    resale_count: resaleCount,
    new_build_median: newMedian,
    resale_median: resaleMedian,
  });
  await sleep(30);
}

// --- Price distribution by year (P10/P25/P50/P75/P90) -----------------------
// Full-market-price sales, all property types, nearest-rank percentiles. The
// P10–P90 spread shows how the whole distribution has moved, not just the
// middle, and whether dispersion (inequality across transactions) is widening.

const YEARS = [];
for (let y = 2010; y <= 2026; y++) YEARS.push(y);
const distribution = [];
for (const y of YEARS) {
  const d = await percentilesFor([...MARKET, ...yearRange(y)]);
  if (!d) continue;
  distribution.push({
    year: y,
    count: d.count,
    p10: d.p10,
    p25: d.p25,
    p50: d.p50,
    p75: d.p75,
    p90: d.p90,
  });
  await sleep(30);
}

// --- Size-band price per square metre (2010–2018) ---------------------------
// The PPR published floor-area *bands* for 2010–2018 (18,883 Dublin rows), not
// exact areas, so an exact price-per-m² is still impossible — but a
// band-level median is not. Representative areas: band midpoints (38 m² upper
// edge for "<38", 81.5 midpoint for "38–125", 125 lower edge for "≥125").
const SIZE_BANDS = [
  { label: '< 38 m²', test: (v) => v.includes('less than 38'), m2: 38 },
  { label: '38–125 m²', test: (v) => v.includes('greater than or equal to 38') && v.includes('less than 125'), m2: 81.5 },
  { label: '≥ 125 m²', test: (v) => v.includes('greater than or equal to 125') || v.includes('greater than 125'), m2: 125 },
];

async function medianForSized() {
  const prices = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await get('sales', [
      ['select', 'price,size_description'],
      ['size_description', 'neq.'],
      ['sale_date', 'gte.2010-01-01'],
      ['sale_date', 'lte.2018-12-31'],
      ['limit', '1000'],
      ['offset', String(offset)],
    ]);
    if (!rows.length) break;
    rows.forEach((r) => prices.push({ price: Number(r.price), band: r.size_description }));
    if (rows.length < 1000) break;
    await sleep(30);
  }
  return prices;
}

const sizedRows = await medianForSized();
const sizeBands = SIZE_BANDS.map((b) => {
  const prices = sizedRows.filter((r) => b.test(r.band)).map((r) => r.price);
  const med = median(prices);
  return {
    band: b.label,
    representative_m2: b.m2,
    sale_count: prices.length,
    median_price: med,
    approx_per_sqm: med ? Math.round(med / b.m2) : null,
  };
}).filter((b) => b.sale_count > 0);

// --- Seasonality: volume and median price by calendar month -----------------
// All years pooled, full-market-price sales. PostgREST can't express "month ==
// X across all years" as a single filter, so each calendar month's sales are
// fetched per year (2010–2026) and pooled client-side. The per-(year, month)
// count and the range-point median share one count, so it's 24 point-fetches
// per year rather than a full scan of all ~250k rows.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_END = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const seasonPools = MONTHS.map(() => ({ count: 0, prices: [] }));
for (const y of YEARS) {
  const tasks = MONTHS.map(async (_, m) => {
    const pad = String(m + 1).padStart(2, '0');
    const pairs = [...MARKET, ['sale_date', `gte.${y}-${pad}-01`], ['sale_date', `lte.${y}-${pad}-${MONTH_END[m]}`]];
    const n = await countFor(pairs);
    if (!n) return;
    const midIdx = Math.max(0, Math.floor((n - 1) / 2));
    const mid = await priceAtIndex(pairs, midIdx);
    seasonPools[m].count += n;
    if (mid != null) seasonPools[m].prices.push(mid);
  });
  await Promise.all(tasks);
}
const seasonality = MONTHS.map((name, m) => ({
  month: name,
  count: seasonPools[m].count,
  median_price: median(seasonPools[m].prices),
}));

// --- Derived figures --------------------------------------------------------

const yearVolume = new Map();
for (const q of quarterly) {
  const year = q.quarter.slice(0, 4);
  yearVolume.set(year, (yearVolume.get(year) || 0) + q.sale_count);
}
const volume = [...yearVolume.entries()]
  .map(([year, count]) => ({ year: Number(year), count }))
  .sort((a, b) => a.year - b.year);

const medianByYear = new Map();
for (const q of quarterly) {
  const year = q.quarter.slice(0, 4);
  const arr = medianByYear.get(year) || [];
  arr.push(q.median_price);
  medianByYear.set(year, arr);
}
const annualMedian = [...medianByYear.entries()]
  .map(([year, prices]) => ({ year: Number(year), median_price: median(prices) }))
  .sort((a, b) => a.year - b.year);

const growthRows = growth
  .filter((g) => g.median_2010 && g.median_2025)
  .map((g) => ({
    district: g.district,
    pct_change: ((g.median_2025 - g.median_2010) / g.median_2010) * 100,
    cagr: (Math.pow(g.median_2025 / g.median_2010, 1 / 15) - 1) * 100,
    median_2010: g.median_2010,
    median_2025: g.median_2025,
  }))
  .sort((a, b) => b.pct_change - a.pct_change);

const premiumRows = premiums
  .filter((p) => p.new_build_median && p.resale_median)
  .map((p) => ({
    district: p.district,
    new_build_count: p.new_build_count,
    resale_count: p.resale_count,
    premium_pct: ((p.new_build_median - p.resale_median) / p.resale_median) * 100,
    new_build_median: p.new_build_median,
    resale_median: p.resale_median,
  }))
  .sort((a, b) => b.premium_pct - a.premium_pct);

const newBuildCount = byType
  .filter((t) => NEW_TYPES.includes(t.property_type))
  .reduce((s, t) => s + t.sale_count, 0);

const data = {
  generated_at: new Date().toISOString(),
  total_sales: total,
  overall_median_price: overallMedian,
  latest_sale_date: latestSale,
  non_market_count: nonMarketCount,
  vat_exclusive_count: vatExclusiveCount,
  market_median_2010: m2010,
  market_median_2025: m2025,
  new_build_share_pct: total ? (newBuildCount / total) * 100 : null,
  quarterly: quarterly.map((q) => ({ quarter: q.quarter, median_price: q.median_price, sale_count: q.sale_count })),
  volume_by_year: volume,
  annual_median: annualMedian,
  districts: byDistrict.map((d) => ({ district: d.postal_district, median_price: d.median_price, sale_count: d.sale_count })),
  types: byType.map((t) => ({ property_type: t.property_type, median_price: t.median_price, sale_count: t.sale_count })),
  growth: growthRows,
  premiums: premiumRows,
  distribution,
  size_bands: sizeBands,
  seasonality,
  yoy_growth: annualMedian
    .map((a, i) => i && annualMedian[i - 1].median_price
      ? { year: a.year, pct_change: ((a.median_price - annualMedian[i - 1].median_price) / annualMedian[i - 1].median_price) * 100 }
      : { year: a.year, pct_change: null })
    .filter((r) => r.pct_change !== null),
};

await fs.mkdir(path.join(dir, 'charts'), { recursive: true });
await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify(data, null, 2) + '\n');

// --- Charts -----------------------------------------------------------------

const BLUE = '#3987e5';
const RED = '#c04343';
const INK = '#3d3d39';
const MUTED = '#6b6a63';
const GRID = '#e6e6e3';

const euro = (v) => {
  const n = Number(v);
  if (n >= 1000) return `€${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
  return `€${Math.round(n)}`;
};

function niceTicks(min, max, n = 5) {
  const raw = Math.abs(max - min) / Math.max(n - 1, 1) || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) || 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function lineChart({ title, subtitle, series, xLabels, yTicks, fmt = euro, width = 920, height = 330 }) {
  const pad = { l: 60, r: 16, t: 34, b: 34 };
  const [t0, t1] = [Math.min(...series), Math.max(...series)];
  const minY = t0 < 0 ? t0 * 1.1 : t0 * 0.95;
  const maxY = t1 * 1.05;
  const ticks = yTicks || niceTicks(minY, maxY, 5);
  const x = (i) => pad.l + (i / (series.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - minY) / (maxY - minY)) * (height - pad.t - pad.b);
  const step = Math.max(1, Math.ceil(series.length / 12));

  const grid = ticks
    .map((t) => `<line x1="${pad.l}" y1="${y(t)}" x2="${width - pad.r}" y2="${y(t)}" stroke="${GRID}"/>
      <text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" fill="${MUTED}" font-size="11">${fmt(t)}</text>`)
    .join('\n    ');
  const labels = series
    .map((_, i) => (i % step === 0 || i === series.length - 1 ? `<text x="${x(i)}" y="${height - 12}" text-anchor="middle" fill="${MUTED}" font-size="10">${xLabels[i]}</text>` : ''))
    .join('\n    ');
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = series
    .map((v, i) => (i % step === 0 ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${BLUE}"/>` : ''))
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">
  <text x="${pad.l}" y="18" font-size="14" font-weight="600" fill="${INK}">${title}</text>
  <text x="${pad.l}" y="30" font-size="11" fill="${MUTED}">${subtitle}</text>
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${height - pad.b}" stroke="${INK}" stroke-width="1"/>
  <line x1="${pad.l}" y1="${height - pad.b}" x2="${width - pad.r}" y2="${height - pad.b}" stroke="${INK}" stroke-width="1"/>
  ${grid}
  <polyline points="${pts}" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  ${labels}
</svg>`;
}

function hBarChart({ title, subtitle, rows, fmt, width = 920, rowH = 21, barH = 12 }) {
  const pad = { l: 92, r: 90, t: 34, b: 14 };
  const height = pad.t + pad.b + rows.length * rowH;
  const values = rows.map((r) => r.value);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(...values);
  const ticks = niceTicks(minV, maxV, 5);
  const x = (v) => pad.l + ((v - minV) / (maxV - minV || 1)) * (width - pad.l - pad.r);
  const grid = ticks
    .map((t) => `<line x1="${x(t)}" y1="${pad.t}" x2="${x(t)}" y2="${height - pad.b}" stroke="${GRID}"/>
      <text x="${x(t)}" y="${height - pad.b + 12}" text-anchor="middle" fill="${MUTED}" font-size="10">${fmt(t)}</text>`)
    .join('\n    ');
  const bars = rows
    .map((r, i) => {
      const cy = pad.t + i * rowH + rowH / 2;
      const x0 = x(Math.min(r.value, 0));
      const x1 = x(Math.max(r.value, 0));
      const color = r.value < 0 ? RED : BLUE;
      return `<text x="${pad.l - 8}" y="${cy + 4}" text-anchor="end" fill="${INK}" font-size="11">${r.label}</text>
      <rect x="${x0.toFixed(1)}" y="${(cy - barH / 2).toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${barH}" rx="2" fill="${color}"/>
      <text x="${(x1 + 6).toFixed(1)}" y="${cy + 4}" fill="${INK}" font-size="11">${r.valueLabel}</text>`;
    })
    .join('\n    ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">
  <text x="${pad.l}" y="18" font-size="14" font-weight="600" fill="${INK}">${title}</text>
  <text x="${pad.l}" y="30" font-size="11" fill="${MUTED}">${subtitle}</text>
  ${grid}
  ${bars}
</svg>`;
}

const pct1 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const pct0 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;

// Band chart: draws two coloured ribbons — an outer band (e.g. P10–P90) and an
// inner band (P25–P75) — with a line for the median on top, so the widening of
// the distribution is visible rather than just its middle.
function bandChart({ title, subtitle, xLabels, p10, p25, p50, p75, p90, width = 920, height = 330 }) {
  const pad = { l: 60, r: 16, t: 34, b: 34 };
  const all = [...p10, ...p25, ...p50, ...p75, ...p90].filter((v) => v != null);
  const minY = Math.min(...all) * 0.95;
  const maxY = Math.max(...all) * 1.05;
  const ticks = niceTicks(minY, maxY, 5);
  const x = (i) => pad.l + (i / (xLabels.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - minY) / (maxY - minY)) * (height - pad.t - pad.b);
  const step = Math.max(1, Math.ceil(xLabels.length / 12));

  const grid = ticks
    .map((t) => `<line x1="${pad.l}" y1="${y(t)}" x2="${width - pad.r}" y2="${y(t)}" stroke="${GRID}"/>
      <text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" fill="${MUTED}" font-size="11">${euro(t)}</text>`)
    .join('\n    ');
  const labels = xLabels
    .map((_, i) => (i % step === 0 || i === xLabels.length - 1 ? `<text x="${x(i)}" y="${height - 12}" text-anchor="middle" fill="${MUTED}" font-size="10">${xLabels[i]}</text>` : ''))
    .join('\n    ');
  const ribbon = (lo, hi, color) => {
    const pts = lo.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .concat(hi.map((v, i) => `${x(hi.length - 1 - i).toFixed(1)},${y(hi[hi.length - 1 - i]).toFixed(1)}`));
    return `<polygon points="${pts.join(' ')}" fill="${color}"/>`;
  };
  const mid = p50.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const legend = `<rect x="660" y="14" width="9" height="9" fill="rgba(57,135,229,0.16)"/><text x="673" y="22" font-size="10" fill="${MUTED}">P10–P90</text>`
    + `<rect x="742" y="14" width="9" height="9" fill="rgba(57,135,229,0.28)"/><text x="755" y="22" font-size="10" fill="${MUTED}">P25–P75</text>`
    + `<line x1="824" y1="18" x2="840" y2="18" stroke="${BLUE}" stroke-width="2"/><text x="845" y="22" font-size="10" fill="${MUTED}">median</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">
  <text x="${pad.l}" y="18" font-size="14" font-weight="600" fill="${INK}">${title}</text>
  <text x="${pad.l}" y="30" font-size="11" fill="${MUTED}">${subtitle}</text>
  ${legend}
  ${grid}
  ${ribbon(p10, p90, 'rgba(57,135,229,0.16)')}
  ${ribbon(p25, p75, 'rgba(57,135,229,0.28)')}
  <polyline points="${mid}" fill="none" stroke="${BLUE}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
  ${labels}
</svg>`;
}

const quarterlyLine = lineChart({
  title: 'Median sale price by quarter — all Dublin',
  subtitle: 'Full-market-price sales, PSRA PPR. 2010 Q1 – 2026 Q3.',
  series: quarterly.map((q) => Number(q.median_price)),
  xLabels: quarterly.map((q) => q.quarter.slice(0, 7).replace('-', ' Q')),
});

const volumeChart = lineChart({
  title: 'Sales volume by year',
  subtitle: 'Full-market-price sales recorded on the register.',
  series: volume.map((v) => v.count),
  xLabels: volume.map((v) => String(v.year)),
});

const growthChart = hBarChart({
  title: 'Resale price growth by district, 2010 → 2025',
  subtitle: 'Median second-hand sale price change; districts with ≥20 resales in both years.',
  rows: growthRows.map((g) => ({ label: g.district, value: g.pct_change, valueLabel: pct1(g.pct_change) })),
  fmt: pct0,
});

const premiumChart = hBarChart({
  title: 'New-build vs resale price, 2020–2025',
  subtitle: 'Median new-build price relative to median resale, by district (≥10 of each).',
  rows: premiumRows.map((p) => ({ label: p.district, value: p.premium_pct, valueLabel: pct1(p.premium_pct) })),
  fmt: pct0,
});

const distributionChart = bandChart({
  title: 'Dublin price distribution by year',
  subtitle: 'Full-market-price sales; ribbons span P10–P90 and P25–P75, line is the median.',
  xLabels: distribution.map((d) => String(d.year)),
  p10: distribution.map((d) => d.p10),
  p25: distribution.map((d) => d.p25),
  p50: distribution.map((d) => d.p50),
  p75: distribution.map((d) => d.p75),
  p90: distribution.map((d) => d.p90),
});

const sizeChart = hBarChart({
  title: 'Approximate median price per square metre by size band, 2010–2018',
  subtitle: 'Median sale price ÷ band representative area (38 / 81.5 / 125 m²). PPR only published size bands for these years.',
  rows: sizeBands.map((b) => ({ label: b.band, value: b.approx_per_sqm, valueLabel: b.approx_per_sqm ? euro(b.approx_per_sqm) + '/m²' : '' })),
  fmt: (v) => euro(v) + '/m²',
});

const seasonalityChart = hBarChart({
  title: 'Sales volume by calendar month',
  subtitle: 'Full-market-price sales pooled across 2010–2026.',
  rows: seasonality.map((s) => ({ label: s.month, value: s.count, valueLabel: s.count.toLocaleString('en-IE') })),
  fmt: (v) => (v / 1000).toFixed(1) + 'k',
});

const yoyChart = lineChart({
  title: 'Year-on-year change in median sale price',
  subtitle: 'All-Dublin median, full-market-price sales.',
  series: data.yoy_growth.map((g) => g.pct_change),
  xLabels: data.yoy_growth.map((g) => String(g.year)),
  fmt: pct0,
});

await fs.writeFile(path.join(dir, 'charts', 'quarterly-median.svg'), quarterlyLine);
await fs.writeFile(path.join(dir, 'charts', 'volume-by-year.svg'), volumeChart);
await fs.writeFile(path.join(dir, 'charts', 'district-growth.svg'), growthChart);
await fs.writeFile(path.join(dir, 'charts', 'newbuild-premium.svg'), premiumChart);
await fs.writeFile(path.join(dir, 'charts', 'price-distribution.svg'), distributionChart);
await fs.writeFile(path.join(dir, 'charts', 'size-band-per-sqm.svg'), sizeChart);
await fs.writeFile(path.join(dir, 'charts', 'seasonality.svg'), seasonalityChart);
await fs.writeFile(path.join(dir, 'charts', 'yoy-growth.svg'), yoyChart);

// --- Summary for the report writer ------------------------------------------

console.log(JSON.stringify(
  {
    total, overallMedian, latestSale,
    nonMarketCount, vatExclusiveCount,
    newBuildSharePct: data.new_build_share_pct?.toFixed(1),
    marketMove: m2010 && m2025 ? `${((m2025 - m2010) / m2010 * 100).toFixed(0)}%` : null,
    marketMedian: { m2010, m2025 },
    annualMedian: annualMedian.map((a) => ({ y: a.year, m: Math.round(a.median_price) })),
    growthTop: growthRows.slice(0, 4).map((g) => ({ d: g.district, p: +g.pct_change.toFixed(1) })),
    growthBottom: growthRows.slice(-3).map((g) => ({ d: g.district, p: +g.pct_change.toFixed(1) })),
    premiumTop: premiumRows.slice(0, 4).map((p) => ({ d: p.district, p: +p.premium_pct.toFixed(1) })),
    premiumBottom: premiumRows.slice(-3).map((p) => ({ d: p.district, p: +p.premium_pct.toFixed(1) })),
    distributionLatest: distribution.length ? {
      year: distribution.at(-1).year,
      p10: distribution.at(-1).p10,
      p50: distribution.at(-1).p50,
      p90: distribution.at(-1).p90,
    } : null,
    distributionFirst: distribution.length ? {
      year: distribution[0].year,
      p10: distribution[0].p10,
      p50: distribution[0].p50,
      p90: distribution[0].p90,
    } : null,
    sizeBands: sizeBands.map((b) => ({ band: b.band, n: b.sale_count, med: b.median_price, perSqm: b.approx_per_sqm })),
    seasonPeak: seasonality.reduce((a, s) => (s.count > a.count ? s : a), seasonality[0]),
    seasonTrough: seasonality.reduce((a, s) => (s.count < a.count ? s : a), seasonality[0]),
    yoyLatest: data.yoy_growth.at(-1),
  },
  null,
  2,
));
