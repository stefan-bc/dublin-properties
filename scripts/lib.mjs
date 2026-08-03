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
