/* ============================================================================
   Charge & Fuel Map — NDW DOT-NL proxy  (Cloudflare Worker)
   ----------------------------------------------------------------------------
   The NDW "DOT-NL" charging-point API is open data but sends no CORS header,
   so a browser add-in can't call it directly. This ~40-line worker forwards
   the request, adds `Access-Control-Allow-Origin`, and edge-caches the result
   for 30 s so you stay well under NDW's 10 req/s limit.

   DEPLOY (free tier is plenty):
     1. https://dash.cloudflare.com  ->  Workers & Pages  ->  Create Worker
     2. Paste this file, click Deploy.
     3. Copy the *.workers.dev URL.
     4. In the add-in host page set:
          window.CFM_CONFIG = { chargeProxyUrl: "https://charge-proxy.<you>.workers.dev" };
        (or edit CONFIG.chargeProxyUrl in main.js)

   Optional hardening: set ALLOW_ORIGINS to your add-in's exact origin(s).
   ========================================================================= */

const NDW = "https://dotnl.ndw.nu/api/rest/geojson/dynamic-road-status/charge-point-data/v1/features";
const ALLOW_ORIGINS = ["*"]; // e.g. ["https://yourname.github.io"]
const CACHE_SECONDS = 30;

function cors(origin) {
  const allow = ALLOW_ORIGINS.includes("*")
    ? "*"
    : (ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url = new URL(request.url);
    const bbox = url.searchParams.get("bbox");
    if (!bbox || !/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(bbox)) {
      return new Response(JSON.stringify({ error: "bbox=minLon,minLat,maxLon,maxLat required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors(origin) }
      });
    }

    const target = `${NDW}?bbox=${encodeURIComponent(bbox)}`;
    const cacheKey = new Request(target, { method: "GET" });
    const cache = caches.default;

    let resp = await cache.match(cacheKey);
    if (!resp) {
      const upstream = await fetch(target, { headers: { "Accept": "application/geo+json" } });
      resp = new Response(upstream.body, upstream);
      resp.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
      resp.headers.set("Content-Type", "application/geo+json");
      if (upstream.ok) await cache.put(cacheKey, resp.clone());
    }

    const out = new Response(resp.body, resp);
    const c = cors(origin);
    Object.keys(c).forEach((k) => out.headers.set(k, c[k]));
    return out;
  }
};
