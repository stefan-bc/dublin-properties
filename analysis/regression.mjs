// Hedonic price regression: log(price) ~ district + is_new_build + year.
// Purpose: separate "prices went up" from "the mix of what's selling
// changed" — a raw year-over-year median conflates both (e.g. if more
// expensive districts or more new-builds are selling this year than last,
// the median moves even if no single home appreciated). This holds
// district and new-build/resale mix constant and asks what's left.
//
// OLS via the normal equations (beta = (X'X)^-1 X'y), implemented directly
// (no stats library) and verified against a synthetic dataset with a known
// answer before trusting it on real data — see verifyOlsOnSyntheticData().
//
// Sample, not the full ~239k-row market-price register: 15 chunks of 2,000
// rows each, at offsets spread evenly across the whole sale_date-ordered
// table, giving a sample spanning the full 2010-2026 date range rather than
// e.g. only the most recent rows. Disclosed explicitly in the output, not
// silently presented as the full population.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const configSrc = await fs.readFile(path.join(dir, '..', 'config.js'), 'utf8');
const SUPABASE_URL = configSrc.match(/SUPABASE_URL = '([^']+)'/)?.[1];
const ANON_KEY = configSrc.match(/SUPABASE_ANON_KEY = '([^']+)'/)?.[1];
const REST = `${SUPABASE_URL}/rest/v1`;

const NEW_TYPES = ['New Dwelling house /Apartment', 'Teach/Árasán Cónaithe Nua', 'Teach/?ras?n C?naithe Nua'];

async function get(apiPath, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${REST}/${apiPath}?${qs}`, { headers: { apikey: ANON_KEY } });
  if (!res.ok) throw new Error(`${apiPath} ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Minimal linear algebra: transpose, multiply, Gauss-Jordan inverse ----

function transpose(m) {
  return m[0].map((_, j) => m.map((row) => row[j]));
}

function multiply(a, b) {
  const out = Array.from({ length: a.length }, () => new Array(b[0].length).fill(0));
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < b.length; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < b[0].length; j++) out[i][j] += aik * b[k][j];
    }
  }
  return out;
}

function invert(matrix) {
  const n = matrix.length;
  const aug = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[pivotRow][col])) pivotRow = r;
    if (Math.abs(aug[pivotRow][col]) < 1e-12) throw new Error('Matrix is singular (collinear predictors?) — cannot invert.');
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];
    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= factor * aug[col][j];
    }
  }
  return aug.map((row) => row.slice(n));
}

function ols(X, y) {
  const Xt = transpose(X);
  const XtX = multiply(Xt, X);
  const XtXInv = invert(XtX);
  const Xty = multiply(Xt, y.map((v) => [v]));
  const beta = multiply(XtXInv, Xty).map((row) => row[0]);

  const yMean = y.reduce((a, b) => a + b, 0) / y.length;
  const predictions = multiply(X, beta.map((b) => [b])).map((row) => row[0]);
  const ssRes = y.reduce((s, v, i) => s + (v - predictions[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;
  return { beta, r2 };
}

// Sanity-checks the OLS implementation against a dataset with a known exact
// answer before it's trusted on real data: y = 5 + 2*x1 - 1*x2, no noise.
function verifyOlsOnSyntheticData() {
  const X = [], y = [];
  for (let x1 = 0; x1 < 10; x1++) {
    for (let x2 = 0; x2 < 10; x2++) {
      X.push([1, x1, x2]);
      y.push(5 + 2 * x1 - 1 * x2);
    }
  }
  const { beta, r2 } = ols(X, y);
  const expected = [5, 2, -1];
  const maxError = Math.max(...beta.map((b, i) => Math.abs(b - expected[i])));
  if (maxError > 1e-8 || Math.abs(r2 - 1) > 1e-8) {
    throw new Error(`OLS self-check failed: expected [5,2,-1] r2=1, got [${beta.map((b) => b.toFixed(6))}] r2=${r2}`);
  }
  console.log('OLS self-check passed (recovered exact coefficients on noise-free synthetic data).');
}

verifyOlsOnSyntheticData();

// --- Pull a stratified sample ------------------------------------------

// Restricted to 2015 onward, not the full 2010-2026 register: a first pass
// on the full range produced a new-build coefficient of roughly -6% (new
// builds cheaper than resale, controlling for district/year) that flatly
// contradicted the raw 2020-2025 medians (up to +82% premium, see
// report.html). Checked why rather than reporting either number blindly:
// pooled year-by-year medians show new-build sold BELOW resale in 2010-2012
// (224,670 vs 300,000 in 2010; likely distressed/unsold post-crash stock)
// and consistently ABOVE resale from 2016 on. A single linear-in-time
// coefficient across both regimes averages two opposite effects into one
// misleading number. Restricting to the stable modern regime gives an
// estimate that's actually comparable to (and can sanity-check) the raw
// finding, instead of a pooled artifact.
const SAMPLE_START_YEAR = 2015;

async function countMarketPriceRows() {
  const res = await fetch(`${REST}/sales?select=id&not_full_market_price=eq.false&sale_date=gte.${SAMPLE_START_YEAR}-01-01`, {
    headers: { apikey: ANON_KEY, Range: '0-0', Prefer: 'count=exact' },
  });
  return Number(res.headers.get('content-range').split('/')[1]);
}
const TOTAL_ROWS = await countMarketPriceRows();
console.log(`Market-price register, ${SAMPLE_START_YEAR} onward: ${TOTAL_ROWS.toLocaleString()} rows`);

const CHUNK_SIZE = 2000;
const CHUNKS = 15;
const maxOffset = TOTAL_ROWS - CHUNK_SIZE;
const offsets = Array.from({ length: CHUNKS }, (_, i) => Math.round((i / (CHUNKS - 1)) * maxOffset));

const sampleRows = [];
for (const offset of offsets) {
  const rows = await get('sales', {
    select: 'price,postal_district,property_type,sale_date',
    not_full_market_price: 'eq.false',
    postal_district: 'not.is.null',
    property_type: 'not.is.null',
    sale_date: `gte.${SAMPLE_START_YEAR}-01-01`,
    order: 'sale_date.asc',
    limit: String(CHUNK_SIZE),
    offset: String(offset),
  });
  sampleRows.push(...rows);
}
console.log(`Sample: ${sampleRows.length.toLocaleString()} rows across ${CHUNKS} chunks spanning ${SAMPLE_START_YEAR}-2026`);

// --- Build the design matrix ---------------------------------------------
// log(price) ~ intercept + district dummies (k-1, "Co. Dublin" as baseline)
// + is_new_build + year (centred on 2010, so the intercept means something).

const districts = [...new Set(sampleRows.map((r) => r.postal_district))].sort();
const baselineDistrict = 'Co. Dublin';
const districtDummies = districts.filter((d) => d !== baselineDistrict);

const X = [];
const y = [];
for (const r of sampleRows) {
  const price = Number(r.price);
  if (!Number.isFinite(price) || price <= 0) continue;
  const year = Number(r.sale_date.slice(0, 4));
  const isNew = NEW_TYPES.includes(r.property_type) ? 1 : 0;
  const row = [1, ...districtDummies.map((d) => (r.postal_district === d ? 1 : 0)), isNew, year - SAMPLE_START_YEAR];
  X.push(row);
  y.push(Math.log(price));
}

console.log(`Design matrix: ${X.length} rows x ${X[0].length} columns (${districtDummies.length} district dummies + new-build + year + intercept)`);

const { beta, r2 } = ols(X, y);
const [intercept, ...rest] = beta;
const newBuildCoef = rest[districtDummies.length];
const yearCoef = rest[districtDummies.length + 1];
const districtCoefs = districtDummies.map((d, i) => ({ district: d, log_effect: rest[i] }));

// log-coefficient -> % effect: e^b - 1
const pct = (logCoef) => (Math.exp(logCoef) - 1) * 100;

const result = {
  generated_at: new Date().toISOString(),
  sample_start_year: SAMPLE_START_YEAR,
  sample_size: X.length,
  full_population_size: TOTAL_ROWS,
  r_squared: r2,
  [`intercept_price_baseline_co_dublin_${SAMPLE_START_YEAR}_resale`]: Math.exp(intercept),
  year_effect_pct_per_year: pct(yearCoef),
  new_build_premium_pct: pct(newBuildCoef),
  district_effects_pct_vs_co_dublin: districtCoefs
    .map((d) => ({ district: d.district, pct_vs_co_dublin: pct(d.log_effect) }))
    .sort((a, b) => b.pct_vs_co_dublin - a.pct_vs_co_dublin),
};

await fs.writeFile(path.join(dir, 'regression.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
