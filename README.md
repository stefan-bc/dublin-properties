# Dublin Property Prices

Every residential property sale in Dublin since 2010, sourced from Ireland's
official [Property Price Register](https://www.propertypriceregister.ie) and
refreshed weekly. Search by address, Eircode or postal district, browse the
trends, or click into a single property's full sale history.

Live at [dublin.ectoplasma.org](https://dublin.ectoplasma.org).

## What it does

- Fast, typo-tolerant search across roughly 250,000 sales
- Filter by postal district, property type or date
- An interactive map of Dublin's postal districts, coloured by median price
- Per-address sale history, with an estimated current value
- Market analysis: price trends, district growth, the new-build premium,
  seasonality, and how mortgage rates and rents relate to sale prices

## How it's built

- **Data pipeline.** A scheduled GitHub Action downloads the official
  register every Monday, cleans it up (encoding fixes, address parsing,
  deduplication) and loads it into Postgres. It's safe to re-run: rows are
  updated in place, never duplicated.
- **Database.** Supabase Postgres. Pre-computed views and two SQL functions
  handle search and filtering server-side, so the browser never has to churn
  through a quarter of a million rows itself.
- **Frontend.** Plain HTML, CSS and JavaScript. No framework, no build step.
  Charts and a hand-rendered choropleth map of Dublin's postal districts,
  drawn straight to canvas and SVG.
- **Market context.** Mortgage rate data from the Central Bank of Ireland and
  rent index data from the CSO, joined against the sales figures.
- Automated tests and linting on every push.

## About the data

The Property Price Register is public government data, and like most public
data it has the odd typo or gap. Where something in the source is ambiguous
or missing, it's shown honestly (as "not recorded") rather than guessed at
or dropped silently.

## Running it locally

No build step needed.

```
npx serve .
```

```
npm test     # tests
npm run lint # linting
```
