import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeForFilter, escapeForEircodeFilter, shortSize } from '../lib.js';

test('escapeForFilter leaves commas/periods/parens intact', () => {
  // Regression test: these used to be stripped, which broke ILIKE matching
  // for any address containing one (see app.js's or=(...) filter, which now
  // wraps values in double quotes instead of stripping structural chars).
  assert.equal(escapeForFilter('Apartment 61, Mercor Manor, Mercer Vale'), 'Apartment 61, Mercor Manor, Mercer Vale');
  assert.equal(escapeForFilter('Unit 4 (rear)'), 'Unit 4 (rear)');
  assert.equal(escapeForFilter('St. Anne’s'), 'St. Anne’s');
});

test('escapeForFilter strips % (would otherwise widen the ILIKE wildcard)', () => {
  assert.equal(escapeForFilter('50% off'), '50 off');
});

test('escapeForFilter escapes double quotes and backslashes for the quoted ilike value', () => {
  assert.equal(escapeForFilter('12" Pipe'), '12\\" Pipe');
  assert.equal(escapeForFilter('back\\slash'), 'back\\\\slash');
});

test('escapeForEircodeFilter strips whitespace on top of the base escaping', () => {
  assert.equal(escapeForEircodeFilter('D03 C640'), 'D03C640');
  assert.equal(escapeForEircodeFilter('d03c640'), 'd03c640');
});

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
