-- Dublin Property Prices — schema
-- Run once in the Supabase SQL editor (or via `supabase db push`).
-- Source data: PSRA Residential Property Price Register, filtered to County = Dublin.

create extension if not exists pg_trgm;

create table if not exists sales (
  id text primary key,                    -- md5(sale_date|address|price), dedupe key since PPR rows have no natural id
  sale_date date not null,
  address text not null,
  county text not null,
  eircode text,
  postal_district text,                   -- e.g. 'Dublin 14', 'Co. Dublin' — derived from Eircode routing key or address text
  price numeric(12,2) not null,
  not_full_market_price boolean not null default false,
  vat_exclusive boolean not null default false,
  property_type text,
  size_description text,
  created_at timestamptz not null default now()
);

create index if not exists sales_sale_date_idx on sales (sale_date);
create index if not exists sales_postal_district_idx on sales (postal_district);
create index if not exists sales_address_trgm_idx on sales using gin (address gin_trgm_ops);
create index if not exists sales_eircode_trgm_idx on sales using gin (eircode gin_trgm_ops);
create index if not exists sales_postal_district_trgm_idx on sales using gin (postal_district gin_trgm_ops);

alter table sales enable row level security;

-- Public read-only access (dashboard queries directly with the anon key).
-- No insert/update/delete policy is defined, so writes are denied by default
-- for anon/authenticated; the ingest script uses the service_role key, which
-- bypasses RLS entirely.
drop policy if exists "public read access" on sales;
create policy "public read access" on sales
  for select
  using (true);

-- Pre-aggregated views for the dashboard's default (unfiltered) charts, so the
-- browser never has to pull all ~250k rows just to compute a median/count.
-- Views run as their owner (full table access), so grants below are required
-- since RLS on the base table doesn't automatically extend to them.

create or replace view sales_quarterly as
select
  date_trunc('quarter', sale_date)::date as quarter,
  percentile_cont(0.5) within group (order by price) as median_price,
  count(*) as sale_count
from sales
group by 1
order by 1;

create or replace view sales_by_district as
select
  postal_district,
  percentile_cont(0.5) within group (order by price) as median_price,
  count(*) as sale_count
from sales
where postal_district is not null
group by 1
order by 1;

-- Per-district time series, same shape as sales_quarterly but split by
-- district. Backs the "Estimated value today" tile on the address view: a
-- past sale's price is scaled by how much that district's median has moved
-- between the sale's quarter and the latest one (see app.js
-- estimateCurrentValue). A district/quarter with no sales simply has no row
-- here, rather than a row with a zero count.
create or replace view district_quarterly as
select
  postal_district,
  date_trunc('quarter', sale_date)::date as quarter,
  percentile_cont(0.5) within group (order by price) as median_price,
  count(*) as sale_count
from sales
where postal_district is not null
group by 1, 2
order by 1, 2;

create or replace view sales_by_type as
select
  property_type,
  percentile_cont(0.5) within group (order by price) as median_price,
  count(*) as sale_count
from sales
where property_type is not null
group by 1
order by 2 desc;

drop view if exists sales_summary;
create or replace view sales_summary as
select
  count(*) as total_sales,
  percentile_cont(0.5) within group (order by price) as median_price,
  max(sale_date) as latest_sale_date
from sales;

grant select on sales_quarterly, sales_by_district, district_quarterly, sales_by_type, sales_summary to anon, authenticated;

-- Fuzzy address search for the dashboard's suggestion dropdown. PPR addresses
-- are free-text and don't always match how people type them — exact-substring
-- (ilike) matching misses a lookup on a single typo. This ranks matches by
-- pg_trgm word_similarity: how closely the typed term matches some extent of
-- the stored address or Eircode. The threshold is set via set_config() as
-- the function's first statement rather than a function-level
-- `set pg_trgm.word_similarity_threshold = ...` clause — Supabase's managed
-- `postgres` role can SET that GUC at session level but is denied
-- permission to set it as function config (proconfig), so this is the only
-- way to get the <% operator to pick up the threshold. The term is injected
-- into the query as a literal via format(%L) (safe quoting) rather than a
-- bound parameter: PostgREST passes RPC arguments as prepared-statement
-- parameters, and pg_trgm's GIN operators can only be planned when the term
-- is a constant — with a parameter the planner falls back to a sequential
-- scan of all ~250k rows, which blows past PostgREST's statement timeout on
-- cold caches. Runs as the invoker, so RLS's public read policy governs it
-- like any other query (app.js fetchAddressSuggestions).
create or replace function search_sales(search_term text, max_results integer default 10)
returns table (address text, postal_district text, eircode text, sale_date date)
language plpgsql
stable
as $$
begin
  perform set_config('pg_trgm.word_similarity_threshold', '0.2', true);
  -- Terms under three characters have too few trigrams to mean anything (a
  -- bare "d" would match nearly every address) — refuse them here rather
  -- than return a flood of noise; district suggestions already cover short
  -- input client-side.
  return query execute format(
    'select s.address, s.postal_district, s.eircode, s.sale_date
       from sales s
      where length(%L) >= 3
        and (%L <%% s.address or (s.eircode is not null and %L <%% s.eircode))
      order by greatest(
                 word_similarity(%L, s.address),
                 case when s.eircode is not null then word_similarity(%L, s.eircode) else 0 end
               ) desc,
               s.sale_date desc
      limit %s',
    search_term, search_term, search_term, search_term, search_term,
    least(greatest(max_results, 0), 100)
  );
end
$$;

grant execute on function search_sales(text, integer) to anon, authenticated;

-- True server-side aggregates for a filtered view. The dashboard used to pull
-- a capped 200-row page of matching sales into the browser and compute median/
-- charts from that sample (honest about it, but still approximate — a filter
-- matching 5,000 sales only summarised the 200 newest). This function runs
-- the exact same filters as the table below it and returns the stats, the
-- quarterly/district/type series, AND the capped table rows in one round
-- trip, so every number on screen covers every matching sale. The filter
-- logic lives here in SQL once, rather than being rebuilt in JS per control,
-- so the table and charts cannot drift. Filters are null when inactive;
-- p_types is a '|'-joined list of raw property_type values (the JS side
-- expands a merged label like "New Build" into every raw source string,
-- including the Irish-language variants). p_term matches address/Eircode/
-- district as ilike substrings. Like search_sales, the term and every other
-- filter value are baked into the query as %L literals rather than bound
-- parameters: PostgREST passes RPC arguments as prepared-statement
-- parameters, and pg_trgm's GIN operators can only be planned against a
-- constant, so a bound term would force a sequential scan of all ~250k rows
-- on every keystroke. %/_/\ are escaped before baking, so the term stays a
-- literal and can't widen its own match (or inject SQL). Runs as the
-- invoker, so RLS's public read policy applies. Called by app.js
-- runFilteredView.
create or replace function sales_stats(
  p_term text default null,
  p_district text default null,
  p_types text default null,
  p_include_non_market boolean default false
)
returns table (
  total bigint,
  median_price double precision,
  latest_sale_date date,
  quarterly json,
  districts json,
  types json,
  rows json
)
language plpgsql
stable
as $$
declare
  esc text;
  conds text[] := '{}';
begin
  if coalesce(p_term, '') <> '' then
    esc := replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_');
    conds := array_append(conds, format(
      $w$(s.address ilike %L escape '\' or s.eircode ilike %L escape '\' or s.postal_district ilike %L escape '\')$w$,
      '%' || esc || '%',
      '%' || replace(esc, ' ', '') || '%',
      '%' || esc || '%'
    ));
  end if;
  if p_district is not null and p_district <> '' then
    conds := array_append(conds, format('s.postal_district = %L', p_district));
  end if;
  if p_types is not null and p_types <> '' then
    conds := array_append(conds, format('s.property_type = any(string_to_array(%L, ''|''))', p_types));
  end if;
  -- coalesce, not a bare `not p_include_non_market`: Postgres's IF treats a
  -- NULL condition the same as false (branch skipped), so `not NULL` would
  -- silently skip the exclusion instead of applying the documented "null
  -- means inactive/default" behaviour every other filter here follows —
  -- non-market sales would leak into what's meant to be the clean default.
  if not coalesce(p_include_non_market, false) then
    conds := array_append(conds, 'not s.not_full_market_price');
  end if;

  return query execute format($q$
    with matches as (
      select address, postal_district, eircode, property_type, price, sale_date,
             size_description, vat_exclusive, not_full_market_price
      from sales s
      %s
    )
    select
      (select count(*) from matches),
      (select percentile_cont(0.5) within group (order by price)::float8 from matches),
      (select max(sale_date) from matches),
      (select coalesce(json_agg(q), '[]') from (
         select date_trunc('quarter', sale_date)::date as quarter,
                percentile_cont(0.5) within group (order by price)::float8 as median_price,
                count(*) as sale_count
         from matches group by 1 order by 1
       ) q),
      (select coalesce(json_agg(d), '[]') from (
         select postal_district,
                percentile_cont(0.5) within group (order by price)::float8 as median_price,
                count(*) as sale_count
         from matches where postal_district is not null group by 1 order by 1
       ) d),
      (select coalesce(json_agg(v), '[]') from (
         select property_type,
                percentile_cont(0.5) within group (order by price)::float8 as median_price,
                count(*) as sale_count
         from matches where property_type is not null group by 1 order by 2 desc
       ) v),
      (select coalesce(json_agg(r), '[]') from (
         select sale_date::text, address, postal_district, eircode, property_type,
                price::float8, size_description, vat_exclusive, not_full_market_price
         from matches order by sale_date desc limit 200
       ) r)
    $q$, case when array_length(conds, 1) > 0 then ' where ' || array_to_string(conds, ' and ') else '' end);
end
$$;

grant execute on function sales_stats(text, text, text, boolean) to anon, authenticated;

-- External market-context data, joined against `sales` in the analysis layer
-- (analysis/generate-report.mjs) to answer questions the PPR data alone
-- can't: did mortgage rate rises coincide with the price/volume slowdown,
-- and how does buying compare to renting by district. Both are quarterly,
-- both come from official Irish/EU sources, both ingested idempotently the
-- same way as `sales` (see scripts/ingest-mortgage-rates.mjs and
-- scripts/ingest-rent-index.mjs).

-- Principal Dwelling House mortgage rates on new business, by rate type, one
-- row per (quarter, rate_type). 2015-Q1 onward is the Central Bank of
-- Ireland's own Table B.3.1 (source='cbi') — a real, market-aggregated rate
-- per type, not fragmented by bank. Pre-2015 has no CBI equivalent, so
-- 2010-2014 is backfilled from the ECB's blended composite Irish house-
-- purchase rate (rate_type='pdh_blended_backfill', source='ecb') — a
-- different methodology (all mortgage types averaged, not variable-only),
-- which is why it's a distinct rate_type rather than silently extending
-- 'pdh_variable' backwards. The analysis layer prefers 'pdh_variable' where
-- both exist and flags the source break rather than smoothing over it.
create table if not exists mortgage_rates (
  quarter date not null,           -- first day of the quarter, e.g. 2015-01-01
  rate_type text not null,         -- 'pdh_variable' | 'pdh_tracker' | 'pdh_fixed_up_to_1y' | 'pdh_fixed_1_3y' | 'pdh_fixed_over_3y' | 'pdh_blended_backfill'
  rate_pct numeric(5,2) not null,
  source text not null,            -- 'cbi' | 'ecb'
  primary key (quarter, rate_type)
);

create index if not exists mortgage_rates_quarter_idx on mortgage_rates (quarter);

alter table mortgage_rates enable row level security;

drop policy if exists "public read access" on mortgage_rates;
create policy "public read access" on mortgage_rates
  for select
  using (true);

grant select on mortgage_rates to anon, authenticated;

-- Average monthly rent, RTB Rent Index via CSO table RIQ02, "All bedrooms" /
-- "All property types" only (the finer breakdowns exist upstream but aren't
-- ingested — out of scope for a price-to-rent ratio). One row per (quarter,
-- district); `district` is either a real postal district ('Dublin 14') in
-- the same naming as sales.postal_district, or the literal 'Dublin' for the
-- county-wide aggregate — NOT the same thing as sales' 'Co. Dublin' bucket
-- (that's PPR sales outside the 22 core districts; this is CSO's own
-- county-level rent rollup). Small-area cells are null-suppressed by CSO in
-- recent quarters for low sample size — those quarters are simply absent
-- here rather than stored as a fabricated value, so the analysis layer falls
-- back to the county-wide 'Dublin' row when a district's latest quarter is
-- missing.
create table if not exists rent_index (
  quarter date not null,           -- first day of the quarter, e.g. 2025-10-01
  district text not null,
  avg_rent_eur numeric(9,2) not null,
  source text not null default 'rtb_cso',
  primary key (quarter, district)
);

create index if not exists rent_index_quarter_idx on rent_index (quarter);
create index if not exists rent_index_district_idx on rent_index (district);

alter table rent_index enable row level security;

drop policy if exists "public read access" on rent_index;
create policy "public read access" on rent_index
  for select
  using (true);

grant select on rent_index to anon, authenticated;

-- Weekly earnings, Dublin-wide (CSO table NEA06, Revenue PAYE administrative
-- data, "Both sexes"). Annual, not quarterly like the rest of this project —
-- income statistics are published once a year, roughly 7 months after the
-- year ends. County-level only: real Dublin postal-district income data
-- doesn't exist (verified against CSO's own PxStat API before building
-- this) and there's no official crosswalk from the finer geography that
-- does exist (Electoral Divisions) to Eircode routing keys, so a
-- district-level figure would require an approximation this project
-- doesn't make. 'statistic' is 'mean' or 'median' — CSO publishes both, so
-- the dashboard can toggle between them rather than picking one silently.
create table if not exists income_stats (
  year integer not null,
  statistic text not null,          -- 'mean' | 'median'
  weekly_earnings_eur numeric(8,2) not null,
  source text not null default 'cso_nea06',
  primary key (year, statistic)
);

create index if not exists income_stats_year_idx on income_stats (year);

alter table income_stats enable row level security;

drop policy if exists "public read access" on income_stats;
create policy "public read access" on income_stats
  for select
  using (true);

grant select on income_stats to anon, authenticated;
