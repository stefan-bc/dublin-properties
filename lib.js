// Pure, DOM-free helpers shared by app.js and the test suite (tests/lib.test.mjs).
// Split out from app.js so they're importable from Node — app.js itself
// touches the DOM at load time and can't run outside a browser.

// PostgREST's or=(...) syntax treats `,` `.` `:` `(` `)` as structural
// delimiters — wrapping a value in double quotes (see app.js's ilike filter
// construction) lets it contain them literally. Only `"` and `\` need
// escaping inside that quoted form. `%` is stripped rather than escaped —
// it's not a PostgREST delimiter, but a literal `%` from the user would
// silently broaden their own ILIKE pattern with an extra wildcard.
export function escapeForFilter(term) {
  return term.replace(/%/g, '').replace(/[\\"]/g, '\\$&');
}

// Stored Eircodes have no space ("D03C640"); people type them either way
// ("D03 C640" or "D03C640"), so match against a space-stripped copy of the
// term on that column only — address/district text still wants real spaces.
export function escapeForEircodeFilter(term) {
  return escapeForFilter(term).replace(/\s+/g, '');
}

// PPR only records size as a coarse sentence ("greater than or equal to 38
// sq metres and less than 125 sq metres"); this pulls out just the numbers
// for a table cell. Falls back to the raw sentence for any phrasing it
// doesn't recognise, so nothing is silently dropped.
export function shortSize(desc) {
  if (!desc) return null;
  const range = desc.match(/greater than or equal to (\d+) sq metres and less than (\d+) sq metres/i);
  if (range) return `${range[1]}–${range[2]} m²`;
  const min = desc.match(/greater than or equal to (\d+) sq metres/i);
  if (min) return `≥${min[1]} m²`;
  const max = desc.match(/less than (\d+) sq metres/i);
  if (max) return `<${max[1]} m²`;
  return desc;
}
