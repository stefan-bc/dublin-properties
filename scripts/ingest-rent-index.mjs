// Ingests the RTB Rent Index (via CSO table RIQ02) into `rent_index`, for the
// 22 core Dublin postal districts plus the county-wide 'Dublin' aggregate.
// Only the "All bedrooms" / "All property types" slice is pulled — the
// dataset breaks down further by bedroom count and dwelling type, but that's
// out of scope for a price-to-rent ratio. Idempotent — safe to re-run;
// upserts on (quarter, district). Small-area cells CSO suppresses for low
// sample size come back as JSON null and are simply skipped, not fabricated.
import { createClient } from '@supabase/supabase-js';

const RIQ02_URL = 'https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/RIQ02/JSON-stat/2.0/en';
const DUBLIN_DISTRICT_RE = /^Dublin (\d{1,2}|6W)$/;

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

// Row-major offset into the flat `value` array, per the JSON-stat 2.0 spec:
// the first dimension in `id` has the largest stride, the last varies fastest.
function makeOffsetFn(dataset) {
  const sizes = dataset.size;
  const strides = sizes.map((_, i) => sizes.slice(i + 1).reduce((a, b) => a * b, 1));
  return (positions) => positions.reduce((sum, p, i) => sum + p * strides[i], 0);
}

function quarterCodeToDate(code) {
  const year = code.slice(0, 4);
  const q = Number(code.slice(4));
  const startMonth = String((q - 1) * 3 + 1).padStart(2, '0');
  return `${year}-${startMonth}-01`;
}

async function main() {
  console.log('Downloading RIQ02 (RTB Rent Index via CSO PxStat)...');
  const res = await fetch(RIQ02_URL);
  if (!res.ok) throw new Error(`RIQ02 download failed: ${res.status}`);
  const dataset = await res.json();

  const dims = dataset.id; // ['STATISTIC', 'TLIST(Q1)', bedrooms, propertyType, location]
  const [, quarterDim, bedroomDim, propertyDim, locationDim] = dims;
  const offset = makeOffsetFn(dataset);

  const quarterPositions = categoryPositions(dataset.dimension[quarterDim].category);
  const locationCategory = dataset.dimension[locationDim].category;
  const locationPositions = categoryPositions(locationCategory);
  const locationLabels = locationCategory.label;

  // "All bedrooms" / "All property types" are both coded '-' in this dataset.
  const allBedrooms = categoryPositions(dataset.dimension[bedroomDim].category)['-'];
  const allPropertyTypes = categoryPositions(dataset.dimension[propertyDim].category)['-'];
  const statPos = 0; // single-valued dimension

  const targetLocations = Object.entries(locationPositions)
    .map(([code, pos]) => ({ code, pos, label: locationLabels[code] }))
    .filter((l) => l.label === 'Dublin' || DUBLIN_DISTRICT_RE.test(l.label));
  console.log(`Found ${targetLocations.length} Dublin locations in the dataset`);

  const rows = [];
  for (const [quarterCode, quarterPos] of Object.entries(quarterPositions)) {
    const quarter = quarterCodeToDate(quarterCode);
    for (const { pos: locationPos, label } of targetLocations) {
      const idx = offset([statPos, quarterPos, allBedrooms, allPropertyTypes, locationPos]);
      const avg_rent_eur = dataset.value[idx];
      if (avg_rent_eur == null) continue; // suppressed or not yet reported
      rows.push({ quarter, district: label, avg_rent_eur, source: 'rtb_cso' });
    }
  }
  console.log(`Parsed ${rows.length} rent_index rows`);

  const BATCH_SIZE = 1000;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('rent_index').upsert(batch, { onConflict: 'quarter,district' });
    if (error) throw new Error(`Upsert failed at batch ${i / BATCH_SIZE}: ${error.message}`);
    upserted += batch.length;
  }
  console.log(`Upserted ${upserted} rent_index rows`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
