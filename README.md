# Central Haze Watch

A small web dashboard for Singapore haze, focused on the **Central** region.

- Latest 1-hr PM2.5 and 24-hr PSI for all five NEA regions, with NEA's bands and health advice
- 14-day trend: hourly readings, daily averages, peaks and hours in the High band
- 24-hour PM2.5 forecast with a likely range
- Drivers: NEA wind and showers forecast, ASMC hotspot counts (Sumatra, Kalimantan) and ASMC alert level
- A warning banner when Central 24-hr PSI is above 200 or 1-hr PM2.5 is 251+
- Health advice follows the worse of the 24-hr PSI band and the 1-hr PM2.5 band (verify against haze.gov.sg)

## How it works

`public/index.html` is a static page. It calls `api/data.js`, a Vercel serverless function that
fetches live data (8 s timeout per request, at most 4 PM2.5 day-requests in flight, 15 days fetched so a full 14 are available) from:

| Source | Data |
|---|---|
| NEA via data.gov.sg (`api-open.data.gov.sg/v2/real-time/api`) | `pm25` (hourly, last 15 days), `psi`, `twenty-four-hr-forecast` |
| ASEAN Specialised Meteorological Centre (`asmc.asean.org`) | NOAA-20 daily hotspot files, current alert level |

Responses are cached on Vercel's CDN for 30 minutes (`s-maxage=1800`; error responses are `no-store`), so the page updates
automatically without any database or cron job. The page itself re-checks every 15 minutes.

### Optional: data.gov.sg API key

Anonymous access is rate-limited. If you see `HTTP 429` errors, get a free key from
data.gov.sg and add it in Vercel as the environment variable `DATA_GOV_SG_API_KEY`.

## Forecast model

`lib/model.js` holds ridge-regression weights for 1, 3, 6, 12 and 24 hours ahead, trained on
hourly Central PM2.5. Inputs: current level, 1 h and 3 h ago, the 24-hour mean, and the daily
cycle. The result is then scaled by hand-set adjustments: ×0.8 when showers are forecast,
×1.15 for winds from the south (135°–247°, which carry smoke from Sumatra), ×0.8 for northerly
winds, and a mild factor for total hotspot count relative to 400.

The hand-set adjustments are bounded: the hotspot ratio is clamped to 0.25–4× the reference and
the combined multiplier to 0.6–1.3. They are priors, not fitted or validated.

**Accuracy caveat.** The weights are trained on only about 14 days of data. An earlier version of
this README quoted a score on the training data itself, which overstates skill. `scripts/refit.py`
now holds out the final 30 % of rows, compares against "no change", prints the table and stores it
as `backtest` in `lib/model.js`; the "likely range" width is the larger of the in-sample and
held-out spread. Until you refit, the shipped `sd` values are still the old in-sample ones, so
treat the range as optimistic. NEA's advisories take precedence.

To refit with fresh data:

```
pip install numpy pandas
python3 scripts/refit.py https://<your-site>/api/data
git commit -am "Refit model" && git push   # if this folder is a git repo
```

## Deploy

Import this repository in Vercel (no build settings needed). Every push to `main` redeploys.

## Tests

```
npm test
```
