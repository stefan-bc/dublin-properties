# Dublin Property Prices

A demo data-analyst project: every registered residential property sale in
Dublin since 2010, ingested weekly from Ireland's official
[PSRA Residential Property Price Register](https://www.propertypriceregister.ie),
stored in Supabase, and shown on a small dark-themed dashboard with instant
type-ahead search by address, Eircode, or postal district, and a drill-down
into any single address's full sale history.

Live at: `dublin.ectoplasma.org` (once deployed — see Setup).

## Architecture

```
PPR CSV (weekly)  →  GitHub Action (scripts/ingest.mjs)  →  Supabase Postgres  →  static dashboard (Cloudflare Pages)
```

- **Data source**: `propertypriceregister.ie`, PPR-ALL.zip — the full nationwide
  dataset, filtered to `County = Dublin` during ingestion (~250k rows). No API
  key, no auth, published by the PSRA.
- **Ingestion**: `scripts/ingest.mjs` downloads the CSV, decodes it (source is
  Windows-1252, not UTF-8), parses and cleans each row, derives a Dublin
  postal district (`Dublin 1`–`24`, `Co. Dublin`) from the Eircode routing key
  or address text, dedupes rows that share the same (date, address, price) —
  e.g. identical new-build units sold the same day — and upserts into
  Supabase keyed on an md5 hash of that triple, so re-runs are idempotent.
- **Scheduling**: `.github/workflows/ingest.yml` runs every Monday 06:00 UTC,
  plus on-demand via `workflow_dispatch`.
- **Database**: `supabase/schema.sql` — one `sales` table (RLS: public
  read-only, writes only via the service-role key) plus four aggregate views
  (`sales_summary`, `sales_quarterly`, `sales_by_district`, `sales_by_type`)
  so the dashboard's default charts don't have to pull ~250k rows into the
  browser just to compute a median.
- **Dashboard**: `index.html` / `style.css` / `app.js` — no build step,
  Supabase JS + Chart.js via CDN, queries Supabase directly with the public
  anon key (safe — reads only, enforced by RLS). The search box shows an
  instant suggestions dropdown: postal-district matches come from a small
  list already held in memory (zero network round trip), address matches
  follow ~120ms later from a trigram-indexed query. Picking an address shows
  its full sale history; clicking any address in the results table does the
  same. Charts and stat tiles always reflect exactly the rows in the table
  below them — no separate "chart data."

## Setup (manual steps — need your accounts, not automatable from here)

1. **Apply the schema.** In the Supabase SQL editor for project
   `ivtgyiobltlwoybwbvev`, run the contents of `supabase/schema.sql`.
2. **Get the anon key.** Supabase dashboard → Project Settings → API →
   `anon` `public` key. Paste it into `config.js` in place of
   `REPLACE_WITH_SUPABASE_ANON_PUBLIC_KEY`. (This key is safe to commit — it's
   public by design, access is controlled by RLS, not secrecy.)
3. **Run the first ingest.** Either push to `main` and trigger the
   `Ingest PPR data` workflow manually (Actions tab → Run workflow), or run it
   locally: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run ingest`.
4. **Deploy to Cloudflare Pages.** Connect this GitHub repo in the Cloudflare
   dashboard (Workers & Pages → Create → Pages → Connect to Git). No build
   command, no output directory override needed — it's a static site served
   from the repo root.
5. **Custom domain.** In the Pages project → Custom domains → add
   `dublin.ectoplasma.org` (requires `ectoplasma.org` to already be a zone in
   the same Cloudflare account).

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already stored as encrypted
GitHub Actions secrets on this repo — not in any file here.

## Local development

No build step. Serve the directory and open it:

```
npx serve .
```

## Known limitations

- Postal district is derived from the Eircode routing key when present,
  otherwise parsed from the free-text address — a small number of edge cases
  won't classify cleanly.
- No geocoding/map view — out of scope for this version. Aggregation is by
  postal district only.
- "Not full market price" sales (gifts, part-transfers) are excluded from the
  default view but not from the data — toggle "Include non-market-price
  sales" to see them.

## Status

- [x] Schema, ETL script, ingest workflow, dashboard written
- [x] Schema applied to Supabase
- [x] Anon key added to `config.js`
- [x] First ingest run — 249,311 Dublin rows loaded, verified end-to-end in a real browser
- [ ] Deployed to Cloudflare Pages under `dublin.ectoplasma.org`
