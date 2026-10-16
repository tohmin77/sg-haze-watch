// GET /api/data — live haze data for the dashboard.
// Pulls NEA (data.gov.sg) PM2.5, PSI and the 24-hour forecast, plus ASMC hotspot counts,
// and returns one JSON payload. Vercel's CDN caches it for 30 minutes.

const model = require('../lib/model');

const NEA = 'https://api-open.data.gov.sg/v2/real-time/api';
const ASMC = 'https://asmc.asean.org';
const REGIONS = ['central', 'north', 'south', 'east', 'west'];
const HISTORY_DAYS = 15; // today + 14 days back

const headers = { 'User-Agent': 'central-haze-watch/1.0' };
if (process.env.DATA_GOV_SG_API_KEY) headers['x-api-key'] = process.env.DATA_GOV_SG_API_KEY;

// Past days never change, so keep them in memory between invocations of a warm function.
const dayCache = new Map();

const TIMEOUT_MS = 8000;

async function getJSON(url) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

function sgDate(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 3600e3 - offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
}

// Run fn over items with at most `limit` in flight; resolves to allSettled-style results.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function pm25ForDate(date, isToday) {
  if (!isToday && dayCache.has(date)) return dayCache.get(date);
  const items = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const url = `${NEA}/pm25?date=${date}${token ? `&paginationToken=${encodeURIComponent(token)}` : ''}`;
    const j = await getJSON(url);
    const data = j.data || {};
    items.push(...(data.items || []));
    token = data.paginationToken;
    if (!token) break;
  }
  const rows = items
    .map((it) => {
      const v = (it.readings && it.readings.pm25_one_hourly) || {};
      return { ts: it.timestamp || it.date, pm25: Object.fromEntries(REGIONS.map((k) => [k, v[k] ?? null])) };
    })
    .filter((r) => r.ts && r.pm25.central != null);
  if (!isToday && rows.length >= 20) dayCache.set(date, rows);
  return rows;
}

async function history() {
  const dates = Array.from({ length: HISTORY_DAYS }, (_, i) => sgDate(HISTORY_DAYS - 1 - i));
  const today = sgDate(0);
  const results = await mapLimit(dates, 4, (d) => pm25ForDate(d, d === today));
  const rows = [];
  const missing = [];
  results.forEach((r, i) => (r.status === 'fulfilled' ? rows.push(...r.value) : missing.push(dates[i])));
  const byHour = new Map(rows.map((r) => [new Date(r.ts).toISOString().slice(0, 13), r]));
  return { readings: [...byHour.values()].sort((a, b) => new Date(a.ts) - new Date(b.ts)), missing };
}

async function psi() {
  const j = await getJSON(`${NEA}/psi`);
  const items = (j.data && j.data.items) || [];
  const it = items[items.length - 1];
  if (!it) throw new Error('PSI: no items');
  const r = it.readings || {};
  const pick = (k) => (r[k] ? r[k].central : undefined);
  return {
    ts: it.timestamp || it.date,
    psi24: Object.fromEntries(REGIONS.map((k) => [k, r.psi_twenty_four_hourly ? r.psi_twenty_four_hourly[k] : null])),
    central: {
      pm25_24h: pick('pm25_twenty_four_hourly'),
      pm10_24h: pick('pm10_twenty_four_hourly'),
      o3_8h: pick('o3_eight_hour_max'),
      co_8h: pick('co_eight_hour_max'),
      no2_1h: pick('no2_one_hour_max'),
      so2_24h: pick('so2_twenty_four_hourly'),
    },
  };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

async function weather() {
  const j = await getJSON(`${NEA}/twenty-four-hr-forecast`);
  const rec = (j.data && j.data.records && j.data.records[0]) || {};
  const g = rec.general || {};
  const wind = g.wind || {};
  const dirText = String(wind.direction || '').toUpperCase().trim();
  const di = COMPASS.indexOf(dirText);
  const sp = wind.speed || {};
  const rh = g.relativeHumidity || {};
  const text = (o) => {
    const t = o && typeof o === 'object' ? o.text || o.forecast : o;
    return typeof t === 'string' ? t : '';
  };
  // Showers for Central in any of the next periods?
  const periods = rec.periods || [];
  const centralTexts = periods.map((p) => text(p.regions && p.regions.central)).filter(Boolean);
  const showers = [text(g.forecast), ...centralTexts].some((t) => /shower|rain|thunder/i.test(String(t)));
  return {
    wind_dir_text: dirText || undefined,
    wind_dir_deg: di >= 0 ? di * 22.5 : undefined,
    wind_speed_kmh: sp.low != null && sp.high != null ? (sp.low + sp.high) / 2 : undefined,
    rh: rh.low != null && rh.high != null ? Math.round((rh.low + rh.high) / 2) : undefined,
    showers,
    forecast_text: String(text(g.forecast) || '') + (centralTexts.length ? ` · Central: ${centralTexts.join(' → ')}` : ''),
  };
}

// ASMC hotspot files: one row per hotspot ("S/No  Longitude  Latitude"), grouped by satellite pass.
function countHotspots(txt) {
  let n = 0;
  let date;
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*\d+\s+-?\d+\.\d+\s+-?\d+\.\d+\s*$/.test(line)) n++;
    const m = line.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
    if (m && !date) date = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return { n, date };
}

async function hotspots() {
  const [s, k] = await Promise.all([
    getText(`${ASMC}/files/msscommunity/hotspots/DailyJP1NOAA20.sumatra.txt`),
    getText(`${ASMC}/files/msscommunity/hotspots/DailyJP1NOAA20.kalimantan.txt`),
  ]);
  const a = countHotspots(s);
  const b = countHotspots(k);
  // A zero count from both files more likely means the format changed than a fire-free day.
  if (a.n === 0 && b.n === 0) throw new Error('hotspots: no rows parsed, file format may have changed');
  return { sumatra: a.n, kalimantan: b.n, date: a.date || b.date ? `${a.date || b.date} (NOAA-20)` : undefined };
}

async function asmcAlert() {
  const html = await getText(`${ASMC}/home/`);
  const m = html.replace(/<[^>]+>/g, ' ').match(/Alert Level\s*(\d)[^.]{0,80}?(Southern|Northern)?\s*ASEAN/i);
  return m ? `Level ${m[1]}${m[2] ? `, ${m[2]} ASEAN` : ''}` : undefined;
}

module.exports = async (req, res) => {
  const [h, p, w, hs, al] = await Promise.allSettled([history(), psi(), weather(), hotspots(), asmcAlert()]);
  const errors = [];
  const val = (r, name) => {
    if (r.status === 'fulfilled') return r.value;
    errors.push(`${name}: ${r.reason && r.reason.message}`);
    return undefined;
  };
  const hist = val(h, 'pm25 history') || { readings: [], missing: [] };
  if (hist.missing.length) errors.push(`pm25 missing days: ${hist.missing.join(', ')}`);

  const body = {
    fetchedAt: new Date().toISOString(),
    readings: hist.readings,
    psi: val(p, 'psi'),
    met: val(w, 'weather'),
    hotspots: val(hs, 'hotspots'),
    asmc_alert: val(al, 'asmc alert'),
    model,
    errors,
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const ok = hist.readings.length > 0;
  // Never let the CDN keep an error response.
  res.setHeader('Cache-Control', ok ? 'public, s-maxage=1800, stale-while-revalidate=3600' : 'no-store');
  res.status(ok ? 200 : 502).send(JSON.stringify(body));
};

module.exports._test = { countHotspots, sgDate, mapLimit };
