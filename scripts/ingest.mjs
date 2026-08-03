// Downloads the PSRA Residential Property Price Register, filters to County = Dublin,
// and upserts into Supabase. Idempotent — safe to re-run on the same data.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const PPR_ZIP_URL =
  'https://www.propertypriceregister.ie/website/npsra/ppr/npsra-ppr.nsf/Downloads/PPR-ALL.zip/$FILE/PPR-ALL.zip';
const BATCH_SIZE = 1000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}
const supabase = createClient(supabaseUrl, supabaseKey);

async function downloadCsv() {
  console.log('Downloading PPR dataset...');
  const res = await fetch(PPR_ZIP_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const zipBuffer = Buffer.from(await res.arrayBuffer());

  const zip = new AdmZip(zipBuffer);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.csv'));
  if (!entry) throw new Error('No CSV file found in PPR zip');

  // Source file is Windows-1252 encoded, not UTF-8 (contains a raw € byte).
  return iconv.decode(entry.getData(), 'win1252');
}

function parseDate(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split('/');
  return `${y}-${m}-${d}`;
}

function parsePrice(raw) {
  return Number.parseFloat(raw.replace(/[^0-9.]/g, ''));
}

// The only postal districts that actually exist: 1-18, 20, 22, 24, 6W (no 19,
// 21, 23). PPR is raw, unedited data (PSRA's own disclaimer) with genuine
// address typos like "Dublin 91" or "Dublin 67" — validate against this set
// rather than trust whatever digits follow the word "Dublin".
const VALID_DUBLIN_DISTRICTS = new Set([
  '1', '2', '3', '4', '5', '6', '6W', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '20', '22', '24',
]);

// Eircode routing keys map 1:1 to postal districts. Prefer the Eircode when
// present (reliable); fall back to the address text.
function derivePostalDistrict(county, address, eircode) {
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

function toSaleRow(record) {
  const saleDate = parseDate(record['Date of Sale (dd/mm/yyyy)']);
  const address = record['Address'].trim();
  const price = parsePrice(record['Price (€)'] ?? record['Price ()'] ?? '');
  const eircode = record['Eircode']?.trim() || null;
  const county = record['County'].trim();

  const id = crypto
    .createHash('md5')
    .update(`${saleDate}|${address}|${price.toFixed(2)}`)
    .digest('hex');

  return {
    id,
    sale_date: saleDate,
    address,
    county,
    eircode,
    postal_district: derivePostalDistrict(county, address, eircode),
    price,
    not_full_market_price: record['Not Full Market Price'] === 'Yes',
    vat_exclusive: record['VAT Exclusive'] === 'Yes',
    property_type: record['Description of Property']?.trim() || null,
    size_description: record['Property Size Description']?.trim() || null,
  };
}

async function upsertBatches(rows) {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('sales').upsert(batch, { onConflict: 'id' });
    if (error) throw new Error(`Upsert failed at batch ${i / BATCH_SIZE}: ${error.message}`);
    upserted += batch.length;
    console.log(`Upserted ${upserted}/${rows.length}`);
  }
}

async function main() {
  const csvText = await downloadCsv();
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`Parsed ${records.length} rows nationwide`);

  const dublinRows = records.filter((r) => r.County?.trim() === 'Dublin').map(toSaleRow);
  console.log(`Filtered to ${dublinRows.length} Dublin rows`);

  // A handful of rows share the same (date, address, price) — e.g. identical
  // new-build units sold the same day at the same price with a non-unit-level
  // address. They're indistinguishable under our dedupe key, so collapse them
  // rather than let ON CONFLICT choke on updating the same row twice.
  const dedupedRows = [...new Map(dublinRows.map((r) => [r.id, r])).values()];
  const dupeCount = dublinRows.length - dedupedRows.length;
  if (dupeCount > 0) console.log(`Collapsed ${dupeCount} duplicate (date, address, price) rows`);

  await upsertBatches(dedupedRows);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
