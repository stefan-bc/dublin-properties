// Ingests Principal Dwelling House mortgage rates on new business into
// `mortgage_rates`. Two sources, stitched at the seam rather than blended:
// - 2015-Q1 onward: Central Bank of Ireland Table B.3.1 (opendata.centralbank.ie),
//   a real market-aggregated rate per type, not fragmented by bank.
// - 2010-2014: no CBI equivalent exists, so it's backfilled from the ECB's
//   blended composite Irish house-purchase rate (all mortgage types averaged,
//   not variable-only) — tagged with its own rate_type so it's never mistaken
//   for the CBI series it's filling in for.
// Idempotent — safe to re-run; upserts on (quarter, rate_type).
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const CBI_PACKAGE_ID = 'e92c1985-9da0-47e2-af77-c88a3fa37cec';
const CBI_PACKAGE_SHOW_URL = `https://opendata.centralbank.ie/api/3/action/package_show?id=${CBI_PACKAGE_ID}`;
const ECB_MIR_URL =
  'https://data-api.ecb.europa.eu/service/data/MIR/M.IE.B.A2C.AM.R.A.2250.EUR.N?format=jsondata';

// CBI CSV column header -> our rate_type key. All five are "rates on new
// business (%)" for Principal Dwelling Houses (excludes Buy-to-let).
const CBI_COLUMNS = {
  'Principal Dwelling Houses, floating rate, standard or LTV variable, rates on new business (%)': 'pdh_variable',
  'Principal Dwelling Houses, floating rate, tracker mortgages, rates on new business (%)': 'pdh_tracker',
  'Principal Dwelling Houses, floating rate, up to 1 year fixed, rates on new business (%)': 'pdh_fixed_up_to_1y',
  'Principal Dwelling Houses, fixed rate, from 1 to 3 years, rates on new business (%)': 'pdh_fixed_1_3y',
  'Principal Dwelling Houses, fixed rate, over 3 years, rates on new business (%)': 'pdh_fixed_over_3y',
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// dd/mm/yyyy quarter-end reporting date -> ISO date of that quarter's first day.
function quarterStart(reportingDate) {
  const [, mm, yyyy] = reportingDate.split('/');
  const q = Math.ceil(Number(mm) / 3);
  const startMonth = String((q - 1) * 3 + 1).padStart(2, '0');
  return `${yyyy}-${startMonth}-01`;
}

function parseRate(raw) {
  const v = raw?.trim();
  if (!v || v === '..' || v === '.') return null;
  const n = Number.parseFloat(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchCbiRows() {
  console.log('Resolving current CBI Table B.3.1 CSV resource...');
  const pkgRes = await fetch(CBI_PACKAGE_SHOW_URL);
  if (!pkgRes.ok) throw new Error(`CBI package_show failed: ${pkgRes.status}`);
  const pkg = await pkgRes.json();
  const resource = pkg.result.resources.find((r) => r.format === 'CSV');
  if (!resource) throw new Error('No CSV resource found in CBI dataset');

  console.log(`Downloading ${resource.url}`);
  const csvRes = await fetch(resource.url);
  if (!csvRes.ok) throw new Error(`CBI CSV download failed: ${csvRes.status}`);
  const csvText = await csvRes.text();
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

  const rows = [];
  for (const record of records) {
    const quarter = quarterStart(record['Reporting date']);
    for (const [column, rateType] of Object.entries(CBI_COLUMNS)) {
      const rate_pct = parseRate(record[column]);
      if (rate_pct === null) continue;
      rows.push({ quarter, rate_type: rateType, rate_pct, source: 'cbi' });
    }
  }
  console.log(`Parsed ${rows.length} CBI rate rows`);
  return rows;
}

// 2010 Q1 - 2014 Q3 only: 2014 Q4 onward comes from CBI (first CBI reporting
// date is 31/12/2014, i.e. quarter 2014-10-01).
async function fetchEcbBackfillRows() {
  console.log('Downloading ECB MIR backfill series (Irish house-purchase rate, 2010-2014)...');
  const res = await fetch(ECB_MIR_URL);
  if (!res.ok) throw new Error(`ECB MIR download failed: ${res.status}`);
  const data = await res.json();
  const series = Object.values(data.dataSets[0].series)[0];
  const observations = series.observations;

  const monthIndex = (year, month) => (year - 2003) * 12 + (month - 1);
  const targets = [];
  for (let year = 2010; year <= 2013; year++) targets.push(...[3, 6, 9, 12].map((m) => [year, m]));
  targets.push(...[3, 6, 9].map((m) => [2014, m]));

  const rows = [];
  for (const [year, month] of targets) {
    const obs = observations[String(monthIndex(year, month))];
    const rate_pct = obs?.[0];
    if (rate_pct == null) continue;
    rows.push({ quarter: quarterStart(`01/${String(month).padStart(2, '0')}/${year}`), rate_type: 'pdh_blended_backfill', rate_pct, source: 'ecb' });
  }
  console.log(`Parsed ${rows.length} ECB backfill rows`);
  return rows;
}

async function main() {
  const [cbiRows, ecbRows] = await Promise.all([fetchCbiRows(), fetchEcbBackfillRows()]);
  const rows = [...ecbRows, ...cbiRows];

  const { error } = await supabase.from('mortgage_rates').upsert(rows, { onConflict: 'quarter,rate_type' });
  if (error) throw new Error(`Upsert failed: ${error.message}`);
  console.log(`Upserted ${rows.length} mortgage_rates rows`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
