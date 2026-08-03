import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortSize } from '../lib.js';

test('shortSize parses the PPR range sentence', () => {
  assert.equal(
    shortSize('greater than or equal to 38 sq metres and less than 125 sq metres'),
    '38–125 m²',
  );
});

test('shortSize parses min-only and max-only sentences', () => {
  assert.equal(shortSize('greater than or equal to 200 sq metres'), '≥200 m²');
  assert.equal(shortSize('less than 38 sq metres'), '<38 m²');
});

test('shortSize falls back to the raw sentence for unrecognised phrasing', () => {
  assert.equal(shortSize('unusual phrasing'), 'unusual phrasing');
});

test('shortSize returns null for missing input', () => {
  assert.equal(shortSize(null), null);
  assert.equal(shortSize(undefined), null);
  assert.equal(shortSize(''), null);
});
