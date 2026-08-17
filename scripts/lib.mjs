// Pure parsing/derivation helpers shared by ingest.mjs and the test suite
// (tests/ingest.test.mjs). Split out because ingest.mjs itself throws at
// import time if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY aren't set, which
// makes it unimportable from a test process.

export function parseDate(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split('/');
  return `${y}-${m}-${d}`;
}

export function parsePrice(raw) {
  return Number.parseFloat(raw.replace(/[^0-9.]/g, ''));
}

// The only postal districts that actually exist: 1-18, 20, 22, 24, 6W (no 19,
// 21, 23). PPR is raw, unedited data (PSRA's own disclaimer) with genuine
// address typos like "Dublin 91" or "Dublin 67" — validate against this set
// rather than trust whatever digits follow the word "Dublin".
export const VALID_DUBLIN_DISTRICTS = new Set([
  '1', '2', '3', '4', '5', '6', '6W', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '20', '22', '24',
]);

// Eircode routing keys map 1:1 to postal districts. Prefer the Eircode when
// present (reliable); fall back to the address text.
export function derivePostalDistrict(county, address, eircode) {
  if (eircode && /^D\d[0-9W]/i.test(eircode)) {
    const suffix = eircode.slice(1, 3).toUpperCase().replace(/^0/, '');
    if (VALID_DUBLIN_DISTRICTS.has(suffix)) return `Dublin ${suffix}`;
  }
  const match = address.match(/Dublin\s*(\d{1,2}W?)\b/i);
  if (match) {
    const suffix = match[1].toUpperCase().replace(/^0/, '');
    if (VALID_DUBLIN_DISTRICTS.has(suffix)) return `Dublin ${suffix}`;
  }
  if (county === 'Dublin') return 'Co. Dublin';
  return null;
}

// Row-count and data-shape sanity checks, run before anything is written to
// Supabase. A malformed or truncated source download (PPR changes their CSV
// format, a network blip returns a partial file, a column gets silently
// reordered) should fail the ingest workflow loudly rather than upsert
// corrupt or incomplete data that then quietly poisons every view/chart
// built on top of it. GitHub emails the repo owner by default when a
// scheduled Action fails — a thrown error here is the actual alert, not a
// placeholder for one to wire up later. Returns nothing; throws with every
// problem found (not just the first) so a single failed run tells you
// everything wrong in one message.
export function runSanityChecks(rows) {
  const errors = [];

  if (rows.length < 200_000) {
    errors.push(`Only ${rows.length} Dublin rows parsed (expected 200,000+) — source data may be truncated or malformed.`);
  }

  const invalidPriceCount = rows.filter((r) => !Number.isFinite(r.price) || r.price <= 0).length;
  if (rows.length && invalidPriceCount / rows.length > 0.01) {
    errors.push(`${invalidPriceCount} of ${rows.length} rows (${((invalidPriceCount / rows.length) * 100).toFixed(1)}%) have an invalid price — source format may have changed.`);
  }

  const invalidDateCount = rows.filter((r) => Number.isNaN(new Date(r.sale_date).getTime())).length;
  if (rows.length && invalidDateCount / rows.length > 0.01) {
    errors.push(`${invalidDateCount} of ${rows.length} rows have an unparseable sale_date.`);
  }

  const latestDate = rows.reduce((max, r) => (r.sale_date > max ? r.sale_date : max), '0000-00-00');
  const oneYearFromNow = new Date();
  oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
  if (latestDate > oneYearFromNow.toISOString().slice(0, 10)) {
    errors.push(`Latest sale_date (${latestDate}) is implausibly far in the future — date parsing may be broken.`);
  }

  if (errors.length) {
    throw new Error(`Ingest sanity checks failed:\n- ${errors.join('\n- ')}`);
  }
}
