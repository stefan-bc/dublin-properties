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

create or replace view sales_summary as
select
  count(*) as total_sales,
  percentile_cont(0.5) within group (order by price) as median_price,
  max(sale_date) as latest_sale_date,
  count(distinct postal_district) as district_count
from sales;

grant select on sales_quarterly, sales_by_district, sales_by_type, sales_summary to anon, authenticated;
