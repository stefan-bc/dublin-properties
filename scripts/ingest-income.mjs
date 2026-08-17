// Ingests Dublin-wide weekly earnings (mean + median) into `income_stats`
// from CSO table NEA06 (Revenue PAYE administrative data). Annual, county
// level only — real postal-district income data doesn't exist and there's
// no official crosswalk from the finer geography that does (Electoral
// Divisions) to Eircode routing keys (verified against CSO's own PxStat API
// before building this; see supabase/schema.sql's income_stats comment).
// Idempotent — safe to re-run; upserts on (year, statistic).
import { createClient } from '@supabase/supabase-js';

const NEA06_URL = 'https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/NEA06/JSON-stat/2.0/en';
const DUBLIN_COUNTY_LABEL = 'Co. Dublin';
const STAT_CODES = { NEA06C01: 'mean', NEA06C02: 'median' };

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// JSON-stat 2.0 category index can be an array (position = array index) or
// an object (code -> position) depending on dimension size — normalise both.
function categoryPositions(category) {
  const idx = category.index;
  return Array.isArray(idx) ? Object.fromEntries(idx.map((code, i) => [code, i])) : idx;
}

function makeOffsetFn(dataset) {
  const sizes = dataset.size;
  const strides = sizes.map((_, i) => sizes.slice(i + 1).reduce((a, b) => a * b, 1));
  return (positions) => positions.reduce((sum, p, i) => sum + p * strides[i], 0);
}

async function main() {
  console.log('Downloading NEA06 (weekly earnings via CSO PxStat)...');
  const res = await fetch(NEA06_URL);
  if (!res.ok) throw new Error(`NEA06 download failed: ${res.status}`);
  const dataset = await res.json();

  const [statDim, yearDim, countyDim, sexDim] = dataset.id;
  const offset = makeOffsetFn(dataset);

  const statPositions = categoryPositions(dataset.dimension[statDim].category);
  const yearPositions = categoryPositions(dataset.dimension[yearDim].category);
  const countyCategory = dataset.dimension[countyDim].category;
  const countyPositions = categoryPositions(countyCategory);
  const countyLabels = countyCategory.label;
  const sexPositions = categoryPositions(dataset.dimension[sexDim].category);

  const dublinCode = Object.keys(countyLabels).find((code) => countyLabels[code] === DUBLIN_COUNTY_LABEL);
  if (!dublinCode) throw new Error(`Could not find '${DUBLIN_COUNTY_LABEL}' in NEA06's county dimension`);
  const dublinPos = countyPositions[dublinCode];
  const bothSexesPos = sexPositions['-'];

  const rows = [];
  for (const [statCode, statistic] of Object.entries(STAT_CODES)) {
    const statPos = statPositions[statCode];
    for (const [yearCode, yearPos] of Object.entries(yearPositions)) {
      const idx = offset([statPos, yearPos, dublinPos, bothSexesPos]);
      const weekly_earnings_eur = dataset.value[idx];
      if (weekly_earnings_eur == null) continue;
      rows.push({ year: Number(yearCode), statistic, weekly_earnings_eur, source: 'cso_nea06' });
    }
  }
  console.log(`Parsed ${rows.length} income_stats rows`);

  const { error } = await supabase.from('income_stats').upsert(rows, { onConflict: 'year,statistic' });
  if (error) throw new Error(`Upsert failed: ${error.message}`);
  console.log(`Upserted ${rows.length} income_stats rows`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
