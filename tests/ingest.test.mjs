import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parsePrice, derivePostalDistrict } from '../scripts/lib.mjs';

test('parseDate converts dd/mm/yyyy to iso', () => {
  assert.equal(parseDate('05/03/2026'), '2026-03-05');
});

test('parsePrice strips currency symbols/commas', () => {
  assert.equal(parsePrice('€352,423.00'), 352423);
  assert.equal(parsePrice('480000'), 480000);
});

test('derivePostalDistrict prefers the Eircode routing key over address text', () => {
  assert.equal(derivePostalDistrict('Dublin', 'Some Address, Dublin 4', 'D06 W2R1'), 'Dublin 6');
});

test('derivePostalDistrict falls back to address text when there is no usable Eircode', () => {
  assert.equal(derivePostalDistrict('Dublin', '12 Main St, Dublin 14', null), 'Dublin 14');
  assert.equal(derivePostalDistrict('Dublin', '3 The Green, Dublin 6W', ''), 'Dublin 6W');
});

test('derivePostalDistrict falls back to "Co. Dublin" for typo\'d districts rather than fabricating one', () => {
  // No "Dublin 19", "Dublin 21", "Dublin 23", "Dublin 91" etc. — county is
  // still Dublin, so it lands in the honest catch-all, not a guessed district.
  assert.equal(derivePostalDistrict('Dublin', '4 Oak Rd, Dublin 91', null), 'Co. Dublin');
  assert.equal(derivePostalDistrict('Dublin', '4 Oak Rd, Dublin 19', null), 'Co. Dublin');
});

test('derivePostalDistrict returns null for an invalid district outside county Dublin', () => {
  assert.equal(derivePostalDistrict('Cork', '4 Oak Rd, Dublin 91', null), null);
});

test('derivePostalDistrict falls back to "Co. Dublin" for county-Dublin rows with no district', () => {
  assert.equal(derivePostalDistrict('Dublin', '1 Any Estate, Lucan', null), 'Co. Dublin');
});

test('derivePostalDistrict returns null outside county Dublin', () => {
  assert.equal(derivePostalDistrict('Cork', '1 Any Estate, Cork', null), null);
});
