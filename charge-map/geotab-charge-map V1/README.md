# Charge & Fuel Map — MyGeotab Add-In

A GRID-style live map of **EV charging points** and **fuel stations** in the
Netherlands, with the fleet's **own vehicles** overlaid and the **nearest
charger / fuel station** (distance + drive time) for any selected vehicle.

![overview](docs/preview.png)

---

## What it does

| Feature | Detail |
|---|---|
| **Charging points** | NDW *DOT-NL* open data — ≈60,000 public points, **live availability** (free / busy), power, connector type, operator. Falls back to Open Charge Map. |
| **Fuel stations** | OpenStreetMap (`amenity=fuel`) — brand, address, available fuel types (diesel / E10 / E5 / LPG / CNG / truck diesel), opening hours. |
| **Filters** | Charging ↔ Fuel ↔ All · available-only · fast-only (≥50 kW) · min power slider · connector type · fuel type · open-now. |
| **Vehicle overlay** | Live positions from `DeviceStatusInfo`. Click a vehicle → nearest charging + fuel with **≈ km / min**, then **“drive time by road”** (OSRM) on demand. |
| **Availability badge** | Charging cards show **FREE 2/4** or **BUSY** where the data source reports it. |
| **Prices** | EV: shown when the CPO/roaming feed exposes a tariff (NDW `tariff_ids`, OCM `UsageCost`). Fuel: **no open price feed exists in NL** — see *Fuel prices* below. |
| **Map** | Esri light / dark gray canvas + place labels (no key). Light & dark theme, NL / EN. |
| **Navigation** | “Navigate” opens Google Maps directions in a new tab. “Show on MyGeotab map” jumps the parent window to the live map at that point. |

Nothing is written anywhere. All POI data is read-only external data; the only
MyGeotab calls are `Get Device` + `Get DeviceStatusInfo`.

---

## Deploy

### 1. Host the four files on any HTTPS static host

`index.html`, `style.css`, `main.js`, `icon.svg` — GitHub Pages, Netlify,
Cloudflare Pages, Firebase Hosting, an S3 bucket, … anything with
`Access-Control-Allow-Origin: *` (all of the above do this by default).

### 2. Add the config in MyGeotab

**Administration → System… → Add-Ins → New Add-In**, paste:

```json
{
  "name": "Charge & Fuel Map",
  "supportEmail": "servicedesk@transscope.nl",
  "version": "1.0.0",
  "items": [
    {
      "url": "https://YOURHOST/path/index.html",
      "path": "ActivityLink/",
      "menuName": { "en": "Charge & Fuel Map", "nl": "Laad- & Tankkaart" },
      "icon": "https://YOURHOST/path/icon.svg"
    }
  ],
  "isSigned": false
}
```

(The bundled `config.json` uses relative paths — fine if you upload the folder
as a zip Add-In instead of hosting it. Hosting is recommended: smaller, no
size ceiling, easier updates.)

### 3. Configure data sources

Two options — do **A** for the full experience, or skip straight to **B**.

Set them either by editing `CONFIG` at the top of `main.js`, **or** without
touching `main.js` by adding a small inline script *before* it in `index.html`:

```html
<script>
  window.CFM_CONFIG = {
    chargeProxyUrl: "https://charge-proxy.YOURNAME.workers.dev",
    ocmKey: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  };
</script>
<script src="main.js"></script>
```

#### A. NDW live charging data (recommended — best NL coverage + FREE/BUSY)

The NDW *DOT-NL* API is open but sends no CORS header, so the browser can't call
it directly. Deploy the tiny proxy in [`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js):

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create Worker**
2. Paste `proxy/cloudflare-worker.js`, **Deploy** (free plan is plenty —
   100k requests/day, and the worker edge-caches each area for 30 s).
3. Copy the `*.workers.dev` URL into `CFM_CONFIG.chargeProxyUrl`.

Netlify / Vercel / Deno Deploy work too — it's ~40 lines, just needs to
forward `?bbox=` to NDW and add `Access-Control-Allow-Origin`.

#### B. Open Charge Map (fallback, or if you don't want a proxy)

1. Free account → <https://openchargemap.org/site/profile/applications>
2. Create an API key, put it in `CFM_CONFIG.ocmKey`.

Coverage is good but **static** — no real-time free/busy, fewer points than NDW.

#### Nothing configured?

The map still runs: real fuel stations from OpenStreetMap, plus **demo**
charging points so the layout is visible. The footer shows `Demo · sample data`.

---

## Fuel prices

There is **no free, open, licensable feed of Dutch pump prices.** Options if you
need them:

- **Your fuel-card provider** (Travelcard / MultiTankcard / Shell Card / DKV…) —
  most expose a station + price API to business customers. Map their station IDs
  to the OSM markers and fill `station.tariff`.
- A commercial POI provider (TomTom, HERE) — paid.
- Crowd-sourced sites exist but their terms don't allow redistribution.

Hook: `normFuel()` sets `tariff: null`. Populate it (e.g. from a lookup keyed by
`brand` or kenteken-area) and the panel will render it automatically.

---

## Live charger availability elsewhere

NDW already gives free/busy for the points it carries. To extend coverage or add
predicted occupancy, the usual commercial feed is **Eco-Movement**; **TomTom**
has an *EV Charging Stations Availability* API. Both are paid. Wire either into
`fetchCharge()` and set `station.availablePoints` / `totalPoints`.

---

## Tuning (`CONFIG` in `main.js`)

| Key | Default | Meaning |
|---|---|---|
| `chargeProxyUrl` | `""` | NDW proxy URL |
| `ocmKey` | `""` | Open Charge Map key |
| `roadFactor` | `1.35` | straight-line km → road km for the quick estimate |
| `avgSpeedKmh` | `48` | speed for the quick drive-time estimate |
| `minZoomFetch` | `11` | below this zoom the POI APIs aren't called |
| `availabilityRefreshMs` | `60000` | how often charging free/busy re-polls |
| `tiles` | Esri gray | swap for CARTO / Stadia / MapTiler (needs their key) |
| `osrmUrl` | public demo | replace with your own OSRM / routing host for volume |

### Nicer basemaps (optional, need a key/account)

- **CARTO** `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png` (Positron / Voyager / Dark Matter)
- **Stadia Maps** `alidade_smooth` / `alidade_smooth_dark` — very close to the GRID look
- **MapTiler** `streets-v2` / `dataviz`

---

## Files

```
config.json                 zip-Add-In manifest (relative paths)
index.html                  page shell + CDN <script>/<link> (Leaflet, fonts)
style.css                   all styling, light + dark tokens
main.js                     everything: data, map, filters, vehicles, i18n
icon.svg                    menu icon
proxy/cloudflare-worker.js  NDW DOT-NL CORS proxy
```

CDN libraries (from cdnjs, allowed in Add-Ins): Leaflet 1.9.4 +
Leaflet.markercluster 1.5.3.

---

## Known limits

- Public **OSRM** / **Overpass** demo servers rate-limit; the app rotates
  through 3 Overpass mirrors and caches fuel per ~5 km tile for 30 min. For a
  large team, host your own or use paid endpoints.
- **Opening-hours** parsing is best-effort (handles `24/7` and simple
  `Mo-Fr HH:MM-HH:MM`); when unsure it treats the station as open.
- `minZoomFetch` keeps the whole-country view from loading tens of thousands of
  points — zoom to a city/region to see stations.
