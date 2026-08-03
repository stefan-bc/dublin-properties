# Dublin Housing Market Report

*Full-market-price residential sales, County Dublin, January 2010 – 24 July 2026.*

Data: [PSRA Residential Property Price Register](https://www.propertypriceregister.ie),
ingested weekly. 249,311 transactions. All figures computed from the raw
register via `analysis/generate-report.mjs`; source numbers in `data.json`.

## Executive summary

- The median Dublin home sold for **€482,000** in 2025, up **69%** from
  **€286,000** in 2010 — about 3.5% a year compounding.
- The market took six years to recover its pre-crash peak: the all-Dublin
  median fell from €270,000 (2010) to a trough of **€208,000 (2012)** and only
  regained its 2010 level around 2016.
- Volume followed the same arc: roughly 6,000–7,000 sales a year in 2010–11,
  ~19,000 a year since 2018, a COVID dip to 14,775 in 2020, then a steady
  ~19,000 again through 2025.
- Every Dublin district grew over the period, but unequally — a +108% Dublin 10
  against a +42% Dublin 18. Inner-city and former industrial areas outpaced the
  already-expensive southside.
- New builds (17.9% of sales) carried a large premium in central districts but
  sold at or *below* resale values in parts of the outer city.

## Market overview

**Volume.** The register shows 6,920 sales in 2010, falling to 5,901 in 2011 —
the post-crash low. Activity recovered quickly: 8,920 (2012), 10,375 (2013),
14,169 (2014), 15,426 (2015), and by 2018 settled around 18,500–19,300, where
it has stayed. 2020 dropped to 14,775 (construction and transaction disruption
through the COVID years) before returning to ~19,000. 2026 is tracking on pace
(8,995 through July).

**Price.** The all-Dublin median (all property types) by year:

| Year | Median | | Year | Median |
|------|-------:|-|------|-------:|
| 2010 | €270,000 | | 2019 | €335,500 |
| 2011 | €244,500 | | 2020 | €354,864 |
| 2012 | €208,000 | | 2021 | €374,750 |
| 2013 | €221,000 | | 2022 | €397,941 |
| 2014 | €252,500 | | 2023 | €412,024 |
| 2015 | €267,500 | | 2024 | €438,326 |
| 2016 | €297,500 | | 2025 | €467,500 |
| 2017 | €320,113 | | 2026 (ytd) | €475,000 |
| 2018 | €334,801 | | | |

The trough-to-today move is roughly 2.3×. Post-2019 growth has been
remarkably steady — roughly €30k–40k a year, no single spike.

## Price growth by district, 2010 → 2025

Second-hand (resale) median, districts with ≥20 resales in both years:

- **Fastest:** Dublin 10 (+108%), Dublin 8 (+100%), Dublin 1 (+100%),
  Dublin 6W (+97%), Dublin 14 (+91%).
- **Slowest:** Dublin 18 (+42%), Dublin 4 (+43%), Dublin 17 (+43%),
  Dublin 3 (+50%), Dublin 6 (+53%).

The gap between the two extremes is large: a 2010 median of €157,000 in Dublin 10
more than doubled to €327,000, while Dublin 4's €465,000 went to €664,250.
Absolute price still tracks the old order — Dublin 6 (€767,000) and Dublin 14
(€737,000) lead outright, Dublin 17 (€330,000) and Dublin 10 (€327,000) are
cheapest — but the *percentage* growth is concentrated in the central and
post-industrial inner-city districts.

## New builds vs resale, 2020–2025

New builds were 17.9% of all sales. Across 2020–2025 (districts with ≥10 of
each type):

- **Biggest premium:** Dublin 1 (+82%), Dublin 7 (+75%), Dublin 8 (+73%),
  Dublin 6 (+71%), Dublin 12 (+59%).
- **At or below resale:** Dublin 11 (−14%), Dublin 6W (−7.5%), Co. Dublin (−1.7%).

The pattern is intuitive: where land is scarce and redevelopment sites are the
only new supply (the city centre), new stock commands a strong premium; in the
suburban fringe, new-build pricing competes directly with established homes and
offers little or no premium.

## Method and caveats

All medians are computed over every matching row server-side (not a sample),
with non-full-market-price sales (gifts, part-transfers; 10,917 rows) excluded
from price figures. The register has no floor area, no mortgage/financing
details, and no condition/quality data, so price-per-square-metre or
price-by-quality analysis is impossible from this source. 42,668 transactions
are recorded as VAT-exclusive; those prices are used as published, so
comparisons that mix new builds (where VAT-exclusive records are common) and
resales carry a small systematic bias — the recorded gap between new-build and
resale medians is if anything understated. Individual rows in the PPR are
known to contain address and typology errors (some recorded in Irish, some with
corrupted characters); this report relies on the aggregates, where those
cancel out. `Co. Dublin` is a catch-all for Eircode/addresses outside the 22
core districts (Fingal, South Dublin, Dún Laoghaire–Rathdown) and should not be
read as a single market.

*Generated 2026-08-03.*
