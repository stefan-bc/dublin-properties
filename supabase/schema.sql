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

grant select on sales_quarterly, sales_by_district, sales_by_type, sales_summary to anon, authenticated;

-- Fuzzy address search for the dashboard's suggestion dropdown. PPR addresses
-- are free-text and don't always match how people type them — exact-substring
-- (ilike) matching misses a lookup on a single typo. This ranks matches by
-- pg_trgm word_similarity: how closely the typed term matches some extent of
-- the stored address or Eircode. The threshold is set via set_config() as
-- the function's first statement rather than a function-level
-- `set pg_trgm.word_similarity_threshold = ...` clause — Supabase's managed
-- `postgres` role can SET that GUC at session level but is denied
-- permission to set it as function config (proconfig), so this is the only
-- way to get the <% operator to pick up the threshold and use the GIN
-- trigram indexes below; without them, word_similarity() over all ~250k
-- rows blows past PostgREST's statement timeout. Runs as the invoker, so
-- RLS's public read policy governs it like any other query. PostgREST calls
-- it as an RPC with the term bound as a parameter (see app.js
-- fetchAddressSuggestions).
create or replace function search_sales(search_term text, max_results integer default 10)
returns table (address text, postal_district text, eircode text, sale_date date)
language sql
stable
as $$
  select set_config('pg_trgm.word_similarity_threshold', '0.2', true);
  -- Terms under three characters have too few trigrams to mean anything (a
  -- bare "d" would match nearly every address) — refuse them here rather
  -- than return a flood of noise; district suggestions already cover short
  -- input client-side.
  select s.address, s.postal_district, s.eircode, s.sale_date
  from sales s
  where length(search_term) >= 3
    and (search_term <% s.address or (s.eircode is not null and search_term <% s.eircode))
  order by greatest(
             word_similarity(search_term, s.address),
             case when s.eircode is not null then word_similarity(search_term, s.eircode) else 0 end
           ) desc,
           s.sale_date desc
  limit max_results;
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
-- district as ilike substrings — the term is a bound parameter and %/_/\ are
-- escaped as literals, so it can't widen its own match. Runs as the invoker,
-- so RLS's public read policy applies. Called by app.js runFilteredView.
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
language sql
stable
as $$
  with t as (
    select coalesce(p_term, '') as raw,
           replace(replace(replace(coalesce(p_term, ''), '\', '\\'), '%', '\%'), '_', '\_') as esc
  ),
  matches as (
    select address, postal_district, eircode, property_type, price, sale_date,
           size_description, vat_exclusive, not_full_market_price
    from sales s, t
    where (
        t.raw = ''
        or s.address ilike '%' || t.esc || '%' escape '\'
        or s.eircode ilike '%' || replace(t.esc, ' ', '') || '%' escape '\'
        or s.postal_district ilike '%' || t.esc || '%' escape '\'
      )
      and (p_district is null or p_district = '' or s.postal_district = p_district)
      and (p_types is null or p_types = '' or s.property_type = any(string_to_array(p_types, '|')))
      and (p_include_non_market or not s.not_full_market_price)
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
     ) r);
$$;

grant execute on function sales_stats(text, text, text, boolean) to anon, authenticated;
