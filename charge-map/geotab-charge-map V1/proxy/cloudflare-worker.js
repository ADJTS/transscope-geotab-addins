/* ============================================================================
   Charge & Fuel Map — NDW DOT-NL proxy  (Cloudflare Worker)
   ----------------------------------------------------------------------------
   The NDW "DOT-NL" charging-point API is open data but sends no CORS header,
   so a browser add-in can't call it directly. This worker forwards the
   request, adds `Access-Control-Allow-Origin`, edge-caches each area, and —
   when NDW is rate-limiting or slow — serves the last good copy instead of
   an error, so the map never goes blank.

   DEPLOY (free plan is plenty):
     1. https://dash.cloudflare.com  ->  Compute (Workers)  ->  Create
        ->  Start with Hello World  ->  Create Worker
     2. Name it e.g. "charge-proxy", Deploy.
     3. Edit code  ->  select all, delete, paste THIS whole file  ->  Deploy.
     4. Copy the worker address (…​.workers.dev) into the add-in:
          window.CFM_CONFIG = { chargeProxyUrl: "https://charge-proxy.<you>.workers.dev" };

   Optional hardening: set ALLOW_ORIGINS to your add-in's exact origin(s).
   ========================================================================= */

const NDW = "https://dotnl.ndw.nu/api/rest/geojson/dynamic-road-status/charge-point-data/v1/features";
const ALLOW_ORIGINS = ["*"];   // e.g. ["https://yourname.github.io"]
const FRESH_SECONDS = 40;      // reuse a result this long without re-asking NDW
const STALE_SECONDS = 3600;    // keep a fallback copy up to this long
const NDW_TIMEOUT_MS = 9000;

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

    const bbox = new URL(request.url).searchParams.get("bbox");
    if (!bbox || !/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(bbox)) {
      return json('{"error":"bbox=minLon,minLat,maxLon,maxLat required"}', 400, origin);
    }

    const target = `${NDW}?bbox=${encodeURIComponent(bbox)}`;
    const cache = caches.default;
    const freshKey = new Request(`https://cache/fresh?b=${encodeURIComponent(bbox)}`);
    const staleKey = new Request(`https://cache/stale?b=${encodeURIComponent(bbox)}`);

    // 1. recent copy? use it.
    const fresh = await cache.match(freshKey);
    if (fresh) return pass(fresh, origin);

    // 2. ask NDW (with a timeout + one retry).
    let body = null;
    for (let i = 0; i < 2 && body === null; i++) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), NDW_TIMEOUT_MS);
        const up = await fetch(target, { headers: { "Accept": "application/geo+json" }, signal: ac.signal });
        clearTimeout(timer);
        if (up.ok) body = await up.text();
      } catch (e) { /* timeout / network — try again */ }
      if (body === null && i === 0) await new Promise((r) => setTimeout(r, 400));
    }

    if (body !== null) {
      await cache.put(freshKey, geo(body, FRESH_SECONDS));
      await cache.put(staleKey, geo(body, STALE_SECONDS));
      return json(body, 200, origin);
    }

    // 3. NDW unavailable — last good copy for this area, else empty.
    const stale = await cache.match(staleKey);
    if (stale) return pass(stale, origin, "stale");
    return json('{"type":"FeatureCollection","features":[]}', 200, origin, "empty");
  }
};

function geo(body, maxAge) {
  return new Response(body, {
    headers: { "Content-Type": "application/geo+json", "Cache-Control": `public, max-age=${maxAge}` }
  });
}
function json(body, status, origin, note) {
  const h = { "Content-Type": "application/geo+json", ...cors(origin) };
  if (note) h["X-Proxy-Source"] = note;
  return new Response(body, { status, headers: h });
}
async function pass(cached, origin, note) {
  const h = new Headers(cached.headers);
  const c = cors(origin);
  Object.keys(c).forEach((k) => h.set(k, c[k]));
  if (note) h.set("X-Proxy-Source", note);
  return new Response(await cached.text(), { status: 200, headers: h });
}
