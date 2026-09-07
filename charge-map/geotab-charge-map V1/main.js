/* ============================================================================
   Charge & Fuel Map  —  MyGeotab Add-In
   ----------------------------------------------------------------------------
   A GRID-style live map of EV charging points and fuel stations in the
   Netherlands, with the fleet's own vehicles overlaid and the nearest
   charger / fuel station (distance + drive time) for any selected vehicle.

   DATA SOURCES
     - Charging   NDW "DOT-NL" open GeoJSON API  (≈60,000 public points,
                  real-time availability + power + connector + operator).
                  NDW sends no CORS header, so it is read through a tiny
                  same-origin proxy — see proxy/cloudflare-worker.js and the
                  README. Set CONFIG.chargeProxyUrl to the deployed worker.
     - Charging   Open Charge Map  (fallback / outside NL). CORS-enabled,
                  needs a free API key in CONFIG.ocmKey.
     - Fuel       OpenStreetMap via the Overpass API (amenity=fuel).
                  CORS-enabled, no key. Brand, address, fuel types,
                  opening hours. No pump prices — no open feed exists.
     - Tiles      Esri light / dark gray canvas + place labels (no key).
     - Routing    OSRM demo server (no key) for on-demand drive time.
     - Vehicles   MyGeotab  DeviceStatusInfo + Device.

   Nothing here needs a MyGeotab entity beyond the standard vehicle roster
   and live positions; all POI data is external and read-only.
   ========================================================================= */

(function () {
  "use strict";

  var STANDALONE = typeof window.geotab === "undefined";
  if (STANDALONE) { window.geotab = { addin: {} }; }

  /* ==========================================================================
     CONFIG  —  override any of these by defining window.CFM_CONFIG before
     main.js loads (handy when hosting: no need to edit this file).
     ========================================================================= */
  var CONFIG = {
    // Deployed proxy for the NDW DOT-NL charging API. Empty = skip NDW.
    // e.g. "https://charge-proxy.yourname.workers.dev"
    chargeProxyUrl: "",
    // Open Charge Map key (https://openchargemap.org/site/profile/applications)
    ocmKey: "",
    ocmMaxResults: 250,
    // Keyless "clean" basemap: Esri gray canvas + a place-label reference layer.
    // Swap in CARTO / Stadia / MapTiler here if you have a key (see README).
    tiles: {
      lightBase: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      lightRef: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      darkBase: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      darkRef: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
    },
    tileAttribution: '&copy; OpenStreetMap contributors &copy; Esri',
    osrmUrl: "https://router.project-osrm.org",
    roadFactor: 1.35,        // straight-line km -> road km, when OSRM not called
    avgSpeedKmh: 48,         // for the quick drive-time estimate
    minZoomFetch: 11,        // below this, don't hammer the POI APIs
    availabilityRefreshMs: 60000,
    defaultCenter: [52.13, 5.29],
    defaultZoom: 8,
    maxCache: 2500
  };
  if (window.CFM_CONFIG) {
    for (var ck in window.CFM_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(window.CFM_CONFIG, ck)) CONFIG[ck] = window.CFM_CONFIG[ck];
    }
  }

  /* ==========================================================================
     i18n
     ========================================================================= */
  var LANG_KEY = "cfmLang";
  var LANG = "nl";
  try { var sl = localStorage.getItem(LANG_KEY); if (sl === "en" || sl === "nl") LANG = sl; } catch (e) {}

  var I18N = {
    nl: {
      eyebrow: "Laden & tanken", title: "Charge & Fuel Map",
      fAll: "Alle", fCharge: "Laden", fFuel: "Tanken",
      toggleVehicles: "Voertuigen tonen/verbergen", fitFleet: "Zoom naar wagenpark",
      refresh: "Verversen", language: "Taal", theme: "Thema",
      availOnly: "Alleen beschikbaar", fastOnly: "Alleen snelladen (\u226550 kW)",
      minPower: "Min. vermogen", connector: "Stekker", connAny: "Alle stekkers",
      fuelKind: "Brandstof", fuelAny: "Alle brandstof", fuelDiesel: "Diesel",
      fuelE95: "Euro 95 / E10", fuelE98: "Super 98 / E5", fuelLpg: "LPG", fuelCng: "CNG",
      fuelHgv: "Truck diesel", openNow: "Nu geopend",
      legFree: "Laadpunt vrij", legFull: "Laadpunt bezet", legUnknown: "Status onbekend",
      legFuel: "Tankstation", legVehicle: "Eigen voertuig",
      attrib: "Laaddata: NDW / Open Charge Map \u00b7 Tankstations: OpenStreetMap \u00b7 Kaart: Esri",
      countTpl: "{c} laadlocaties \u00b7 {f} tankstations",
      zoomIn: "Zoom in om laad- en tanklocaties te laden",
      loading: "Laden\u2026", live: "Live", stale: "Verouderd", errSource: "Bron niet bereikbaar",
      demoSource: "Demo \u00b7 voorbeelddata", updated: "bijgewerkt {t}",
      chargePoint: "Laadlocatie", fuelStation: "Tankstation",
      operator: "Exploitant", connectors: "Aansluitingen", power: "Vermogen",
      points: "Laadpunten", tariff: "Tarief", tariffViaCpo: "Via laadpas / CPO",
      tariffUnknown: "Onbekend", fuelTypes: "Brandstoffen", hours: "Openingstijden",
      status: "Status", free1: "Vrij", full1: "Bezet", unknown1: "Onbekend",
      avAvailable: "{a} van {t} vrij", avFull: "Alle {t} bezet", avUnknown: "Bezetting onbekend",
      navigate: "Navigeer", showOnMap: "Toon op MyGeotab-kaart",
      routeVia: "Rijtijd via wegen", nearestCharge: "Dichtstbijzijnde laadlocatie",
      nearestFuel: "Dichtstbijzijnde tankstation", vehicle: "Voertuig", speed: "Snelheid",
      lastSeen: "Laatst gezien", driving: "Rijdt", parked: "Stilstand",
      approx: "\u2248 {km} km \u00b7 {min} min", byRoad: "{km} km \u00b7 {min} min over de weg",
      noVehiclesPos: "Geen voertuigen met een positie.",
      noneNearby: "Niets in de buurt \u2014 zoom of verplaats de kaart.",
      kmUnit: "km", fast: "Snellader", ac: "AC", dc: "DC",
      demoVeh: "Demo-voertuig", routing: "Route berekenen\u2026", routeFail: "Route niet beschikbaar"
    },
    en: {
      eyebrow: "Charge & fuel", title: "Charge & Fuel Map",
      fAll: "All", fCharge: "Charging", fFuel: "Fuel",
      toggleVehicles: "Show / hide vehicles", fitFleet: "Zoom to fleet",
      refresh: "Refresh", language: "Language", theme: "Theme",
      availOnly: "Available only", fastOnly: "Fast charging only (\u226550 kW)",
      minPower: "Min. power", connector: "Connector", connAny: "Any connector",
      fuelKind: "Fuel", fuelAny: "Any fuel", fuelDiesel: "Diesel",
      fuelE95: "Euro 95 / E10", fuelE98: "Super 98 / E5", fuelLpg: "LPG", fuelCng: "CNG",
      fuelHgv: "Truck diesel", openNow: "Open now",
      legFree: "Charge point free", legFull: "Charge point busy", legUnknown: "Status unknown",
      legFuel: "Fuel station", legVehicle: "Own vehicle",
      attrib: "Charging: NDW / Open Charge Map \u00b7 Fuel: OpenStreetMap \u00b7 Map: Esri",
      countTpl: "{c} charging \u00b7 {f} fuel stations",
      zoomIn: "Zoom in to load charging and fuel locations",
      loading: "Loading\u2026", live: "Live", stale: "Stale", errSource: "Source unreachable",
      demoSource: "Demo \u00b7 sample data", updated: "updated {t}",
      chargePoint: "Charging location", fuelStation: "Fuel station",
      operator: "Operator", connectors: "Connectors", power: "Power",
      points: "Charge points", tariff: "Tariff", tariffViaCpo: "Via charge card / CPO",
      tariffUnknown: "Unknown", fuelTypes: "Fuels", hours: "Opening hours",
      status: "Status", free1: "Free", full1: "Busy", unknown1: "Unknown",
      avAvailable: "{a} of {t} free", avFull: "All {t} in use", avUnknown: "Occupancy unknown",
      navigate: "Navigate", showOnMap: "Show on MyGeotab map",
      routeVia: "Drive time by road", nearestCharge: "Nearest charging location",
      nearestFuel: "Nearest fuel station", vehicle: "Vehicle", speed: "Speed",
      lastSeen: "Last seen", driving: "Driving", parked: "Parked",
      approx: "\u2248 {km} km \u00b7 {min} min", byRoad: "{km} km \u00b7 {min} min by road",
      noVehiclesPos: "No vehicles with a position.",
      noneNearby: "Nothing nearby \u2014 zoom or pan the map.",
      kmUnit: "km", fast: "Fast", ac: "AC", dc: "DC",
      demoVeh: "Demo vehicle", routing: "Calculating route\u2026", routeFail: "Route unavailable"
    }
  };
  function t(key, vars) {
    var s = (I18N[LANG] && I18N[LANG][key]) || (I18N.en[key]) || key;
    if (vars) for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  }
  function applyStaticI18n() {
    var i, n, nodes = document.querySelectorAll("[data-i18n]");
    for (i = 0; i < nodes.length; i++) { n = nodes[i]; n.textContent = t(n.getAttribute("data-i18n")); }
    nodes = document.querySelectorAll("[data-i18n-title]");
    for (i = 0; i < nodes.length; i++) { n = nodes[i]; n.title = t(n.getAttribute("data-i18n-title")); }
    document.documentElement.lang = LANG;
  }

  /* ==========================================================================
     Theme
     ========================================================================= */
  var THEME_KEY = "cfmTheme";
  function currentTheme() {
    try { return localStorage.getItem(THEME_KEY) || "light"; } catch (e) { return "light"; }
  }
  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode === "dark" ? "dark" : "light");
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
  }

  /* ==========================================================================
     Small helpers
     ========================================================================= */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function debounce(fn, ms) {
    var h;
    return function () {
      var a = arguments, self = this;
      clearTimeout(h);
      h = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }
  function haversineKm(a, b) {
    var R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180;
    var la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(la1) * Math.cos(la2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function fmtKm(km) { return km < 10 ? km.toFixed(1) : Math.round(km).toString(); }
  function fmtMin(min) { return Math.max(1, Math.round(min)).toString(); }
  function relTime(iso) {
    if (!iso) return "";
    var d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (isNaN(s)) return "";
    if (s < 90) return LANG === "nl" ? "zojuist" : "just now";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 86400) return Math.round(s / 3600) + " " + (LANG === "nl" ? "uur" : "h");
    return Math.round(s / 86400) + " " + (LANG === "nl" ? "dgn" : "d");
  }

  /* ==========================================================================
     Connector normalisation
     ========================================================================= */
  function normConnector(raw) {
    var s = String(raw || "").toUpperCase();
    if (s.indexOf("COMBO") > -1 || s.indexOf("CCS") > -1) return "CCS";
    if (s.indexOf("CHADEMO") > -1) return "CHADEMO";
    if (s.indexOf("T2") > -1 || s.indexOf("TYPE 2") > -1 || s.indexOf("TYPE2") > -1 || s.indexOf("MENNEKES") > -1 || s.indexOf("62196_2") > -1) return "T2";
    if (s.indexOf("T1") > -1 || s.indexOf("TYPE 1") > -1 || s.indexOf("J1772") > -1) return "T1";
    if (s.indexOf("DOMESTIC") > -1 || s.indexOf("SCHUKO") > -1 || s.indexOf("HOUSEHOLD") > -1 || s.indexOf("TYPE F") > -1) return "SCHUKO";
    if (s.indexOf("TESLA") > -1) return "CCS";
    return "OTHER";
  }
  var CONN_LABEL = { T2: "Type 2", CCS: "CCS", CHADEMO: "CHAdeMO", T1: "Type 1", SCHUKO: "Schuko", OTHER: "\u2014" };

  /* ==========================================================================
     Normalisers  ->  common Station shape
       { id, kind:'charge'|'fuel', lat, lng, name, address, operator,
         connectors:[{conn,kw,count,available,powerType}],
         totalPoints, availablePoints, maxKw, isFast, tariff, fuels[],
         hours, updated, source }
     ========================================================================= */
  function stationStatus(s) {
    if (s.kind !== "charge") return "fuel";
    if (s.availablePoints == null || s.totalPoints == null || s.totalPoints === 0) return "unknown";
    return s.availablePoints > 0 ? "free" : "full";
  }

  function normNDW(f) {
    var p = f.properties || {}, g = f.geometry || {};
    var c = g.coordinates || [];
    var conns = [], total = 0, avail = 0, hasAvail = false, maxKw = 0;
    (p.availabilities || []).forEach(function (a) {
      var kw = (a.power_max || 0) / 1000;
      if (kw > maxKw) maxKw = kw;
      var cnt = a.total || 0;
      total += cnt;
      if (typeof a.available === "number") { hasAvail = true; avail += a.available; }
      conns.push({
        conn: normConnector(a.connector_type),
        kw: kw,
        count: cnt,
        available: typeof a.available === "number" ? a.available : null,
        powerType: String(a.power_type || "").indexOf("DC") > -1 ? "DC" : "AC"
      });
    });
    return {
      id: "ndw:" + f.id,
      kind: "charge",
      lat: c[1], lng: c[0],
      name: p.operator_name || p.owner_name || (LANG === "nl" ? "Laadlocatie" : "Charging location"),
      address: p.address || "",
      operator: p.operator_name || p.owner_name || "",
      connectors: conns,
      totalPoints: total || null,
      availablePoints: hasAvail ? avail : null,
      maxKw: maxKw,
      isFast: maxKw >= 50,
      tariff: (p.availabilities || []).some(function (a) { return (a.tariff_ids || []).length; }) ? "cpo" : null,
      fuels: [],
      hours: p.open === true ? "open" : (p.open === false ? "closed" : ""),
      updated: p.last_updated || "",
      source: "NDW"
    };
  }

  function normOCM(poi) {
    var ai = poi.AddressInfo || {};
    var conns = [], maxKw = 0;
    (poi.Connections || []).forEach(function (c) {
      var kw = c.PowerKW || 0;
      if (kw > maxKw) maxKw = kw;
      conns.push({
        conn: normConnector((c.ConnectionType && c.ConnectionType.Title) || ""),
        kw: kw,
        count: c.Quantity || 1,
        available: null,
        powerType: (c.CurrentType && /DC/.test(c.CurrentType.Title || "")) ? "DC" : "AC"
      });
    });
    var pts = poi.NumberOfPoints || null;
    return {
      id: "ocm:" + poi.ID,
      kind: "charge",
      lat: ai.Latitude, lng: ai.Longitude,
      name: (poi.OperatorInfo && poi.OperatorInfo.Title && poi.OperatorInfo.Title !== "(Unknown Operator)" ? poi.OperatorInfo.Title : (ai.Title || "Charging location")),
      address: [ai.AddressLine1, ai.Town].filter(Boolean).join(", "),
      operator: (poi.OperatorInfo && poi.OperatorInfo.Title) || "",
      connectors: conns,
      totalPoints: pts,
      availablePoints: null,
      maxKw: maxKw,
      isFast: maxKw >= 50,
      tariff: poi.UsageCost ? String(poi.UsageCost) : null,
      fuels: [],
      hours: "",
      updated: poi.DateLastStatusUpdate || "",
      source: "OCM"
    };
  }

  var FUEL_TAGS = {
    diesel: "fuel:diesel", octane_95: "fuel:octane_95", octane_98: "fuel:octane_98",
    lpg: "fuel:lpg", cng: "fuel:cng", hgv_diesel: "fuel:HGV_diesel", e85: "fuel:e85",
    adblue: "fuel:adblue", electricity: "fuel:electricity"
  };
  function normFuel(elm) {
    var tg = elm.tags || {};
    var lat = elm.lat != null ? elm.lat : (elm.center && elm.center.lat);
    var lng = elm.lon != null ? elm.lon : (elm.center && elm.center.lon);
    var fuels = [];
    for (var k in FUEL_TAGS) if (tg[FUEL_TAGS[k]] === "yes") fuels.push(k);
    var addr = [tg["addr:street"], tg["addr:housenumber"]].filter(Boolean).join(" ");
    if (tg["addr:city"]) addr += (addr ? ", " : "") + tg["addr:city"];
    return {
      id: "osm:" + elm.type + "/" + elm.id,
      kind: "fuel",
      lat: lat, lng: lng,
      name: tg.brand || tg.name || tg.operator || (LANG === "nl" ? "Tankstation" : "Fuel station"),
      address: addr,
      operator: tg.operator || tg.brand || "",
      connectors: [],
      totalPoints: null, availablePoints: null, maxKw: 0, isFast: false, tariff: null,
      fuels: fuels,
      hours: tg.opening_hours || "",
      updated: "",
      source: "OSM"
    };
  }

  /* ==========================================================================
     Fetchers
     ========================================================================= */
  function boundsToBbox(b, padRatio) {
    var pad = padRatio || 0;
    var dLat = (b.getNorth() - b.getSouth()) * pad;
    var dLng = (b.getEast() - b.getWest()) * pad;
    return {
      s: b.getSouth() - dLat, w: b.getWest() - dLng,
      n: b.getNorth() + dLat, e: b.getEast() + dLng
    };
  }

  // fetch with a hard timeout so one dead endpoint can't stall the map
  function tfetch(url, opts, ms) {
    opts = opts || {};
    if (typeof AbortController === "function") {
      var ac = new AbortController();
      opts.signal = ac.signal;
      var timer = setTimeout(function () { ac.abort(); }, ms || 12000);
      return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; },
        function (e) { clearTimeout(timer); throw e; });
    }
    return fetch(url, opts);
  }

  function ndwFetch(bx) {
    var n = Math.min(bx.n, bx.s + 0.9), e = Math.min(bx.e, bx.w + 0.9);
    var url = CONFIG.chargeProxyUrl.replace(/\/$/, "") +
      "?bbox=" + [bx.w, bx.s, e, n].map(function (x) { return x.toFixed(5); }).join(",");
    return tfetch(url, { headers: { "Accept": "application/json" } }, 12000)
      .then(function (r) { if (!r.ok) throw new Error("ndw " + r.status); return r.json(); })
      .then(function (j) {
        var list = (j.features || []).map(normNDW).filter(validPt);
        if (!list.length) throw new Error("ndw empty");   // let OCM fill in
        return { src: "NDW", list: list };
      });
  }
  function ocmFetch(bx) {
    var ourl = "https://api.openchargemap.io/v3/poi/?output=json&compact=false&verbose=false&includecomments=false" +
      "&maxresults=" + CONFIG.ocmMaxResults +
      "&boundingbox=(" + bx.n.toFixed(5) + "," + bx.w.toFixed(5) + "),(" + bx.s.toFixed(5) + "," + bx.e.toFixed(5) + ")" +
      "&key=" + encodeURIComponent(CONFIG.ocmKey);
    return tfetch(ourl, {}, 14000)
      .then(function (r) { if (!r.ok) throw new Error("ocm " + r.status); return r.json(); })
      .then(function (j) { return { src: "OCM", list: (j || []).map(normOCM).filter(validPt) }; });
  }
  function fetchCharge(bx) {
    // Try NDW (live free/busy) -> Open Charge Map -> demo, in that order.
    var steps = [];
    if (CONFIG.chargeProxyUrl) steps.push(function () { return ndwFetch(bx); });
    if (CONFIG.ocmKey) steps.push(function () { return ocmFetch(bx); });
    steps.push(function () { return Promise.resolve({ src: "demo", list: demoCharge(bx) }); });
    return steps.reduce(function (p, fn) {
      return p.catch(function (err) {
        if (err && err.__init) return fn();
        console.warn("charge source failed, trying next", err);
        return fn();
      });
    }, Promise.reject({ __init: true }));
  }

  var OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  var overpassIdx = 0;
  function fetchFuel(bx) {
    var q = "[out:json][timeout:20];(" +
      'nwr["amenity"="fuel"](' + bx.s + "," + bx.w + "," + bx.n + "," + bx.e + ");" +
      ");out center tags;";
    var attempt = 0;
    function tryOne() {
      var ep = OVERPASS_ENDPOINTS[(overpassIdx + attempt) % OVERPASS_ENDPOINTS.length];
      return tfetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q)
      }, 15000).then(function (r) {
        if (!r.ok) throw new Error("overpass " + r.status);
        return r.json();
      }).then(function (j) {
        overpassIdx = (overpassIdx + attempt) % OVERPASS_ENDPOINTS.length; // stick with the one that worked
        return { src: "OSM", list: (j.elements || []).map(normFuel).filter(validPt) };
      }).catch(function (e) {
        attempt++;
        if (attempt < OVERPASS_ENDPOINTS.length) return tryOne();
        throw e;
      });
    }
    return tryOne();
  }
  function validPt(s) { return s && typeof s.lat === "number" && typeof s.lng === "number" && s.lat && s.lng; }

  /* ==========================================================================
     OSRM drive time (on demand)
     ========================================================================= */
  function osrmRoute(from, to) {
    var u = CONFIG.osrmUrl.replace(/\/$/, "") + "/route/v1/driving/" +
      from[1] + "," + from[0] + ";" + to[1] + "," + to[0] + "?overview=false";
    return tfetch(u, {}, 10000).then(function (r) {
      if (!r.ok) throw new Error("osrm " + r.status);
      return r.json();
    }).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error("no route");
      return { km: j.routes[0].distance / 1000, min: j.routes[0].duration / 60 };
    });
  }

  /* ==========================================================================
     Demo data (standalone preview / no live source)
     ========================================================================= */
  function demoCharge(bx) {
    var cLat = (bx.n + bx.s) / 2, cLng = (bx.e + bx.w) / 2;
    var spanLat = (bx.n - bx.s) || 0.1, spanLng = (bx.e - bx.w) || 0.1;
    var out = [];
    for (var i = 0; i < 14; i++) {
      var seed = i * 47.13;
      var lat = cLat + (Math.sin(seed) * 0.34) * spanLat;
      var lng = cLng + (Math.cos(seed * 1.7) * 0.34) * spanLng;
      var fast = i % 4 === 0;
      var total = fast ? 4 : 2;
      var av = Math.floor((Math.abs(Math.sin(seed * 3.3)) * (total + 1)));
      if (av > total) av = total;
      out.push({
        id: "demo:c" + i, kind: "charge", lat: lat, lng: lng,
        name: fast ? "Fastned" : ["Vattenfall", "Allego", "Shell Recharge", "TotalEnergies"][i % 4],
        address: "Voorbeeldweg " + (10 + i), operator: "Demo",
        connectors: fast
          ? [{ conn: "CCS", kw: 150, count: 2, available: Math.min(av, 2), powerType: "DC" },
             { conn: "CHADEMO", kw: 50, count: 1, available: av > 2 ? 1 : 0, powerType: "DC" }]
          : [{ conn: "T2", kw: 11, count: total, available: av, powerType: "AC" }],
        totalPoints: total, availablePoints: av, maxKw: fast ? 150 : 11, isFast: fast,
        tariff: null, fuels: [], hours: "open", updated: new Date(Date.now() - i * 6e4).toISOString(),
        source: "demo"
      });
    }
    return out;
  }
  function demoVehicles() {
    var base = [
      ["EV-021", "Opel Movano-e", 52.0907, 5.1214, true, 54],
      ["EV-034", "Peugeot e-Expert", 52.2158, 5.1680, false, 0],
      ["VAN-034", "Ford E-Transit", 52.0110, 4.7080, true, 72],
      ["CAR-071", "Kia e-Niro", 52.3702, 4.8952, false, 0],
      ["EV-052", "Renault Kangoo E-Tech", 51.9410, 4.9310, true, 38],
      ["EV-067", "Mercedes eVito", 52.1560, 5.3880, false, 0]
    ];
    return base.map(function (r) {
      return { id: r[0], name: r[0], model: r[1], lat: r[2], lng: r[3], driving: r[4], speed: r[5],
               updated: new Date(Date.now() - 3e5).toISOString() };
    });
  }

  /* ==========================================================================
     Add-in
     ========================================================================= */
  geotab.addin.chargeFuelMap = function () {
    var map, tileLayer, refLayer, chargeCluster, fuelCluster, vehLayer, routeLine;
    var apiRef = null;
    var cache = { charge: {}, fuel: {} };   // id -> station
    var vehicles = [];                       // {id,name,model,lat,lng,driving,speed,updated}
    var vehMarkers = {};
    var selectedVehId = null;
    var showVehicles = true;
    var lastSrc = { charge: null, fuel: null };
    var loadSeq = 0;
    var availTimer = null;

    var filters = {
      type: "all", availOnly: false, fastOnly: false, minPower: 0,
      connector: "", fuelKind: "", openNow: false
    };

    var ICON = {
      free: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
      full: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
      unknown: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
      fuel: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M4 21h12"/><path d="M15 9h2.5A1.5 1.5 0 0 1 19 10.5V16a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7 8h6"/></svg>',
      vehicle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l2-5.5A2 2 0 0 1 6.9 6h10.2a2 2 0 0 1 1.9 1.5L21 13v6h-3v-2H6v2H3z"/><circle cx="7.5" cy="15.5" r="1.3"/><circle cx="16.5" cy="15.5" r="1.3"/></svg>'
    };
    function markerIcon(kind) {
      return L.divIcon({
        className: "cfm-divicon",
        html: '<div class="cfm-marker m-' + kind + '">' + ICON[kind] + "</div>",
        iconSize: [30, 30], iconAnchor: [15, 29], popupAnchor: [0, -27]
      });
    }
    function clusterIcon(kind) {
      return function (cluster) {
        var n = cluster.getChildCount();
        var size = n < 10 ? 34 : n < 50 ? 40 : 46;
        return L.divIcon({
          html: '<div class="cfm-cluster c-' + kind + '">' + n + "</div>",
          className: "cfm-cluster-wrap",
          iconSize: [size, size]
        });
      };
    }
    function vehIcon(sel) {
      return L.divIcon({
        className: "cfm-divicon",
        html: '<div class="cfm-veh-marker' + (sel ? " is-selected" : "") + '">' + ICON.vehicle + "</div>",
        iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16]
      });
    }

    /* ---- setup ---- */
    function initMap() {
      map = L.map("cfmMap", { zoomControl: true, attributionControl: true })
        .setView(CONFIG.defaultCenter, CONFIG.defaultZoom);
      map.attributionControl.setPrefix("");
      setTiles(currentTheme());
      chargeCluster = L.markerClusterGroup({ maxClusterRadius: 46, disableClusteringAtZoom: 15, chunkedLoading: true, iconCreateFunction: clusterIcon("charge") });
      fuelCluster = L.markerClusterGroup({ maxClusterRadius: 46, disableClusteringAtZoom: 15, chunkedLoading: true, iconCreateFunction: clusterIcon("fuel") });
      vehLayer = L.layerGroup();
      map.addLayer(chargeCluster); map.addLayer(fuelCluster); map.addLayer(vehLayer);
      map.on("moveend", debounce(onMove, 600));
      map.on("click", function () { closePanel(); });
      if (STANDALONE) { window.__cfmMap = map; window.__cfmCache = cache; }
      onMove();
    }
    function setTiles(mode) {
      var dark = mode === "dark";
      if (tileLayer) map.removeLayer(tileLayer);
      if (refLayer) map.removeLayer(refLayer);
      tileLayer = L.tileLayer(dark ? CONFIG.tiles.darkBase : CONFIG.tiles.lightBase, {
        attribution: CONFIG.tileAttribution, maxZoom: 19, maxNativeZoom: 16, detectRetina: true
      }).addTo(map);
      var ref = dark ? CONFIG.tiles.darkRef : CONFIG.tiles.lightRef;
      if (ref) {
        refLayer = L.tileLayer(ref, { maxZoom: 19, maxNativeZoom: 16, detectRetina: true, opacity: dark ? 0.7 : 0.9 }).addTo(map);
      }
      tileLayer.bringToBack();
    }

    /* ---- data load on pan/zoom ---- */
    // Fuel POIs don't move: remember which ~5 km tiles we've already pulled
    // (for 30 min) so panning around doesn't re-hammer Overpass.
    var fuelTiles = {};
    function fuelTileKeys(bx) {
      var keys = [], step = 0.05;
      for (var la = Math.floor(bx.s / step); la <= Math.ceil(bx.n / step); la++) {
        for (var lo = Math.floor(bx.w / step); lo <= Math.ceil(bx.e / step); lo++) keys.push(la + "_" + lo);
      }
      return keys;
    }
    function fuelNeedsFetch(bx) {
      var keys = fuelTileKeys(bx), now = Date.now();
      for (var i = 0; i < keys.length; i++) {
        if (!fuelTiles[keys[i]] || now - fuelTiles[keys[i]] > 1800000) return keys;
      }
      return null;
    }
    function markFuelTiles(bx) {
      var keys = fuelTileKeys(bx), now = Date.now();
      for (var i = 0; i < keys.length; i++) fuelTiles[keys[i]] = now;
    }

    function onMove() {
      var z = map.getZoom();
      if (z < CONFIG.minZoomFetch) {
        setSource("zoom");
        renderMarkers();
        return;
      }
      var bx = boundsToBbox(map.getBounds(), 0.15);
      var seq = ++loadSeq;
      setSource("loading");

      // Each source renders as soon as it lands - one slow/dead endpoint can
      // never hold back the other, and the map fills in progressively.
      var pending = 0;
      function settle() {
        if (seq !== loadSeq) return;
        pending--;
        pruneCache(bx);
        renderMarkers();
        setSource(pending > 0 ? "loading" : "done");
        if (selectedVehId) openVehiclePanel(selectedVehId, true);
      }
      if (filters.type !== "fuel") {
        pending++;
        fetchCharge(bx).then(function (r) {
          lastSrc.charge = r.src; mergeCache("charge", r.list);
        }).catch(function (e) { lastSrc.charge = "err"; console.warn("charge load", e); }).then(settle);
      }
      if (filters.type !== "charge" && fuelNeedsFetch(bx)) {
        pending++;
        fetchFuel(bx).then(function (r) {
          lastSrc.fuel = r.src; mergeCache("fuel", r.list); markFuelTiles(bx);
        }).catch(function (e) { lastSrc.fuel = "err"; console.warn("fuel load", e); }).then(settle);
      }
      if (pending === 0) { renderMarkers(); setSource("done"); }
    }
    function refreshAvailability() {
      if (filters.type === "fuel") return;
      if (!map || map.getZoom() < CONFIG.minZoomFetch) return;
      if (!CONFIG.chargeProxyUrl && !CONFIG.ocmKey) return;
      var bx = boundsToBbox(map.getBounds(), 0.15);
      fetchCharge(bx).then(function (r) {
        lastSrc.charge = r.src;
        mergeCache("charge", r.list);
        renderMarkers();
        setSource("done");
        if (selectedVehId) openVehiclePanel(selectedVehId, true);
      }).catch(function () {});
    }
    function mergeCache(kind, list) {
      for (var i = 0; i < list.length; i++) cache[kind][list[i].id] = list[i];
    }
    function pruneCache(bx) {
      ["charge", "fuel"].forEach(function (kind) {
        var ids = Object.keys(cache[kind]);
        if (ids.length <= CONFIG.maxCache) return;
        ids.forEach(function (id) {
          var s = cache[kind][id];
          if (s.lat < bx.s - 0.4 || s.lat > bx.n + 0.4 || s.lng < bx.w - 0.4 || s.lng > bx.e + 0.4) delete cache[kind][id];
        });
      });
    }

    /* ---- filtering ---- */
    function passCharge(s) {
      if (filters.availOnly && stationStatus(s) !== "free") return false;
      if (filters.fastOnly && !s.isFast) return false;
      if (filters.minPower && s.maxKw < filters.minPower) return false;
      if (filters.connector) {
        var has = s.connectors.some(function (c) { return c.conn === filters.connector; });
        if (!has) return false;
      }
      return true;
    }
    function passFuel(s) {
      if (filters.fuelKind && s.fuels.indexOf(filters.fuelKind) === -1) return false;
      if (filters.openNow && s.hours && !openNow(s.hours)) return false;
      return true;
    }
    function openNow(oh) {
      if (!oh || /24\/7/.test(oh)) return true;
      // best-effort: only handle the simple "Mo-Fr HH:MM-HH:MM" style; otherwise assume open
      var now = new Date(), day = now.getDay(), hm = now.getHours() * 60 + now.getMinutes();
      var days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
      var m = oh.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (!m) return true;
      var open = +m[1] * 60 + +m[2], close = +m[3] * 60 + +m[4];
      var dayOk = true;
      if (/Mo-Fr/.test(oh)) dayOk = day >= 1 && day <= 5;
      else if (/Mo-Sa/.test(oh)) dayOk = day >= 1 && day <= 6;
      return dayOk && hm >= open && hm <= close && days.length > 0;
    }

    function visibleStations() {
      var out = [];
      if (filters.type !== "fuel") {
        for (var id in cache.charge) if (passCharge(cache.charge[id])) out.push(cache.charge[id]);
      }
      if (filters.type !== "charge") {
        for (var fid in cache.fuel) if (passFuel(cache.fuel[fid])) out.push(cache.fuel[fid]);
      }
      return out;
    }

    /* ---- render ---- */
    function renderMarkers() {
      chargeCluster.clearLayers();
      fuelCluster.clearLayers();
      var list = visibleStations(), cc = 0, fc = 0;
      var cLayers = [], fLayers = [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var st = stationStatus(s);
        var mk = L.marker([s.lat, s.lng], { icon: markerIcon(st === "fuel" ? "fuel" : st) });
        mk.__sid = s.id; mk.__skind = s.kind;
        mk.on("click", (function (station) { return function () { openStationPanel(station); }; })(s));
        if (s.kind === "charge") { cLayers.push(mk); cc++; } else { fLayers.push(mk); fc++; }
      }
      chargeCluster.addLayers(cLayers);
      fuelCluster.addLayers(fLayers);
      $("cfmCount").textContent = t("countTpl", { c: cc, f: fc });
      renderVehicles();
    }

    function renderVehicles() {
      vehLayer.clearLayers();
      vehMarkers = {};
      if (!showVehicles) return;
      vehicles.forEach(function (v) {
        if (typeof v.lat !== "number" || typeof v.lng !== "number" || (!v.lat && !v.lng)) return;
        var mk = L.marker([v.lat, v.lng], { icon: vehIcon(v.id === selectedVehId), zIndexOffset: 1000 });
        mk.on("click", (function (id) { return function () { openVehiclePanel(id); }; })(v.id));
        mk.bindTooltip(esc(v.name) + (v.model ? " \u00b7 " + esc(v.model) : ""), { direction: "top", offset: [0, -14] });
        mk.addTo(vehLayer);
        vehMarkers[v.id] = mk;
      });
    }

    /* ---- source pill ---- */
    function setSource(state) {
      var el = $("cfmSource"), dot = '<span class="cfm-live-dot"></span>';
      el.className = "cfm-source";
      if (state === "loading") { el.innerHTML = dot + t("loading"); return; }
      if (state === "zoom") { el.className = "cfm-source is-stale"; el.innerHTML = dot + t("zoomIn"); return; }
      var sc = lastSrc.charge, sf = lastSrc.fuel, txt;
      if (sc === "err" || sf === "err") { el.className = "cfm-source is-error"; }
      if (sc === "demo") { el.className = "cfm-source is-stale"; txt = t("demoSource"); }
      else {
        var parts = [];
        if (filters.type !== "fuel" && sc && sc !== "err") parts.push(sc);
        if (filters.type !== "charge" && sf && sf !== "err") parts.push(sf);
        txt = t("live") + (parts.length ? " \u00b7 " + parts.join(" + ") : "") +
              (sc === "err" || sf === "err" ? " \u00b7 " + t("errSource") : "");
      }
      el.innerHTML = dot + esc(txt);
    }

    /* ---- panel ---- */
    function closePanel() { $("cfmPanel").hidden = true; selectedVehId = null; clearRoute(); renderVehicles(); }
    function clearRoute() { if (routeLine) { map.removeLayer(routeLine); routeLine = null; } }
    function openPanel(html) { $("cfmPanelBody").innerHTML = html; $("cfmPanel").hidden = false; }

    function connRow(c) {
      var av = "";
      if (typeof c.available === "number" && c.count) {
        var cls = c.available > 0 ? "free" : "full";
        av = '<span class="cfm-conn-av ' + cls + '">' + c.available + "/" + c.count + "</span>";
      } else if (c.count) {
        av = '<span class="cfm-conn-av">\u00d7' + c.count + "</span>";
      }
      return '<div class="cfm-conn"><span class="cfm-conn-pill">' + esc(CONN_LABEL[c.conn] || c.conn) + "</span>" +
        "<span>" + (c.kw ? c.kw + " kW " : "") + (c.powerType || "") + "</span>" + av + "</div>";
    }

    function navBtn(s) {
      var url = "https://www.google.com/maps/dir/?api=1&destination=" + s.lat + "," + s.lng + "&travelmode=driving";
      return '<a class="cfm-btn primary" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>' +
        esc(t("navigate")) + "</a>";
    }
    function geotabMapBtn(s) {
      return '<button class="cfm-btn" data-gomap="' + s.lat + "," + s.lng + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 20l-5.5 2V6L9 4m0 16l6-2m-6 2V4m6 14l5.5 2V6L15 4m0 14V4m-6 0l6 2"/></svg>' +
        esc(t("showOnMap")) + "</button>";
    }

    function openStationPanel(s) {
      selectedVehId = null; clearRoute(); renderVehicles();
      var st = stationStatus(s);
      var html = "";
      html += '<div class="cfm-p-kicker">' + esc(s.kind === "charge" ? t("chargePoint") : t("fuelStation")) +
              (s.source ? " \u00b7 " + esc(s.source) : "") + "</div>";
      html += '<div class="cfm-p-title">' + esc(s.name) + "</div>";
      if (s.address) html += '<div class="cfm-p-addr">' + esc(s.address) + "</div>";

      if (s.kind === "charge") {
        var badge = st === "free"
          ? '<span class="cfm-badge is-free">\u25cf ' + esc(t("avAvailable", { a: s.availablePoints, t: s.totalPoints })) + "</span>"
          : st === "full"
          ? '<span class="cfm-badge is-full">\u25cf ' + esc(t("avFull", { t: s.totalPoints })) + "</span>"
          : '<span class="cfm-badge is-unknown">\u25cf ' + esc(t("avUnknown")) + "</span>";
        html += badge;
        html += '<div class="cfm-p-rows">';
        if (s.operator) html += pRow(t("operator"), s.operator);
        html += pRow(t("power"), (s.maxKw ? s.maxKw + " kW" : "\u2014") + (s.isFast ? " \u00b7 " + t("fast") : ""));
        html += pRow(t("tariff"), s.tariff === "cpo" ? t("tariffViaCpo") : (s.tariff ? s.tariff : t("tariffUnknown")));
        if (s.updated) html += pRow(t("lastSeen"), relTime(s.updated));
        html += "</div>";
        if (s.connectors.length) {
          html += '<div class="cfm-conn-list">' + s.connectors.map(connRow).join("") + "</div>";
        }
      } else {
        html += '<span class="cfm-badge is-fuel">\u25cf ' + esc(t("fuelStation")) + "</span>";
        html += '<div class="cfm-p-rows">';
        if (s.operator) html += pRow(t("operator"), s.operator);
        if (s.hours) html += pRow(t("hours"), s.hours);
        html += "</div>";
        if (s.fuels.length) {
          html += '<div class="cfm-chips">' + s.fuels.map(function (f) {
            return '<span class="cfm-chip">' + esc(fuelLabel(f)) + "</span>";
          }).join("") + "</div>";
        }
      }
      html += '<div class="cfm-p-actions">' + navBtn(s) + geotabMapBtn(s) + "</div>";
      openPanel(html);
      map.panTo([s.lat, s.lng], { animate: true });
    }
    function pRow(k, v) { return '<div class="cfm-p-row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span></div>"; }
    function fuelLabel(f) {
      var m = { diesel: t("fuelDiesel"), octane_95: t("fuelE95"), octane_98: t("fuelE98"),
        lpg: "LPG", cng: "CNG", hgv_diesel: t("fuelHgv"), e85: "E85", adblue: "AdBlue", electricity: t("fCharge") };
      return m[f] || f;
    }

    /* ---- vehicle panel + nearest ---- */
    function nearest(kind, from) {
      var best = null, bd = Infinity;
      var pool = cache[kind];
      for (var id in pool) {
        var s = pool[id];
        if (kind === "charge" && !passCharge(s)) continue;
        if (kind === "fuel" && !passFuel(s)) continue;
        var d = haversineKm(from, [s.lat, s.lng]);
        if (d < bd) { bd = d; best = s; }
      }
      return best ? { s: best, km: bd } : null;
    }
    function nearCard(res, kind) {
      if (!res) return '<div class="cfm-near-sub">' + esc(t("noneNearby")) + "</div>";
      var roadKm = res.km * CONFIG.roadFactor;
      var min = roadKm / CONFIG.avgSpeedKmh * 60;
      var st = kind === "charge" ? stationStatus(res.s) : "fuel";
      var ico = '<div class="cfm-marker m-' + (st === "fuel" ? "fuel" : st) + '" style="position:static;box-shadow:none">' + ICON[st === "fuel" ? "fuel" : st] + "</div>";
      var sub = kind === "charge"
        ? (res.s.maxKw ? res.s.maxKw + " kW" : "") + (res.s.isFast ? " \u00b7 " + t("fast") : "")
        : (res.s.address || "");
      var badge = "";
      if (kind === "charge") {
        badge = st === "free"
          ? '<span class="cfm-near-badge free">' + esc(t("free1")) + (res.s.totalPoints ? " " + res.s.availablePoints + "/" + res.s.totalPoints : "") + "</span>"
          : st === "full"
          ? '<span class="cfm-near-badge full">' + esc(t("full1")) + "</span>"
          : '<span class="cfm-near-badge unk">' + esc(t("unknown1")) + "</span>";
      }
      return '<div class="cfm-near-card" data-near="' + esc(res.s.id) + '" data-kind="' + kind + '">' +
        '<div class="cfm-near-ico">' + ico + "</div>" +
        '<div class="cfm-near-main"><div class="cfm-near-name">' + esc(res.s.name) + " " + badge + "</div>" +
        '<div class="cfm-near-sub">' + esc(sub) + "</div></div>" +
        '<div class="cfm-near-dist"><b>' + fmtMin(min) + " min</b><span>\u2248 " + fmtKm(roadKm) + " " + t("kmUnit") + "</span></div></div>";
    }

    function openVehiclePanel(id, keepView) {
      var v = null;
      for (var i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) v = vehicles[i];
      if (!v) return;
      selectedVehId = id; clearRoute(); renderVehicles();
      var from = [v.lat, v.lng];
      var nc = nearest("charge", from), nf = nearest("fuel", from);
      var html = "";
      html += '<div class="cfm-p-kicker">' + esc(t("vehicle")) + "</div>";
      html += '<div class="cfm-p-title">' + esc(v.name) + "</div>";
      if (v.model) html += '<div class="cfm-p-addr">' + esc(v.model) + "</div>";
      html += '<div class="cfm-p-rows">';
      html += pRow(t("status"), v.driving ? t("driving") : t("parked"));
      if (v.driving) html += pRow(t("speed"), Math.round(v.speed || 0) + " km/h");
      if (v.updated) html += pRow(t("lastSeen"), relTime(v.updated));
      html += "</div>";

      html += '<div class="cfm-nearest"><h4>' + esc(t("nearestCharge")) + "</h4>" + nearCard(nc, "charge") + "</div>";
      html += '<div class="cfm-nearest"><h4>' + esc(t("nearestFuel")) + "</h4>" + nearCard(nf, "fuel") + "</div>";
      if (nc || nf) {
        html += '<div class="cfm-p-actions" style="margin-top:12px">' +
          '<button class="cfm-btn" id="cfmRouteBtn">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19h6a4 4 0 0 0 0-8H8a4 4 0 0 1 0-8h8"/></svg>' +
          esc(t("routeVia")) + "</button></div>";
      }
      openPanel(html);
      if (!keepView && (nc || nf)) {
        var pts = [from];
        if (nc) pts.push([nc.s.lat, nc.s.lng]);
        if (nf) pts.push([nf.s.lat, nf.s.lng]);
        map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 14 });
      }
      // wire the route button
      var rb = $("cfmRouteBtn");
      if (rb) rb.onclick = function () {
        rb.disabled = true; rb.textContent = t("routing");
        var targets = [];
        if (nc) targets.push({ kind: "charge", res: nc });
        if (nf) targets.push({ kind: "fuel", res: nf });
        Promise.all(targets.map(function (tg) {
          return osrmRoute(from, [tg.res.s.lat, tg.res.s.lng]).then(function (r) { tg.r = r; }).catch(function () { tg.r = null; });
        })).then(function () {
          clearRoute();
          var cards = $("cfmPanelBody").querySelectorAll(".cfm-near-card");
          targets.forEach(function (tg) {
            var el = $("cfmPanelBody").querySelector('.cfm-near-card[data-near="' + cssEsc(tg.res.s.id) + '"]');
            if (el && tg.r) {
              el.querySelector(".cfm-near-dist").innerHTML =
                "<b>" + fmtMin(tg.r.min) + " min</b><span>" + fmtKm(tg.r.km) + " " + t("kmUnit") + " · " +
                esc(LANG === "nl" ? "weg" : "road") + "</span>";
            }
          });
          // draw the shortest one
          var best = targets.filter(function (x) { return x.r; }).sort(function (a, b) { return a.r.km - b.r.km; })[0];
          rb.disabled = false; rb.textContent = t("routeVia");
          if (!best) { toast(t("routeFail")); return; }
          var to = [best.res.s.lat, best.res.s.lng];
          routeLine = L.polyline([from, to], { color: "#00AEEF", weight: 4, opacity: 0.9, dashArray: "1 8", lineCap: "round" }).addTo(map);
          map.fitBounds(L.latLngBounds([from, to]).pad(0.25), { maxZoom: 14 });
        });
      };
    }
    function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

    /* ---- toast ---- */
    var toastTimer = null;
    function toast(msg) {
      var el = $("cfmToast");
      el.textContent = msg; el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
    }

    /* ---- vehicles from MyGeotab ---- */
    function loadVehicles() {
      if (!apiRef) { vehicles = demoVehicles(); renderVehicles(); return; }
      apiRef.multiCall([
        ["Get", { typeName: "Device", search: {}, resultsLimit: 5000 }],
        ["Get", { typeName: "DeviceStatusInfo", search: {} }]
      ], function (r) {
        var devs = r[0] || [], dsi = r[1] || [];
        var nameById = {};
        devs.forEach(function (d) { nameById[d.id] = d; });
        var out = [];
        dsi.forEach(function (s) {
          var did = s.device && s.device.id;
          if (!did) return;
          if (typeof s.latitude !== "number" || typeof s.longitude !== "number") return;
          if (!s.latitude && !s.longitude) return;
          var d = nameById[did] || {};
          out.push({
            id: did,
            name: d.name || did,
            model: d.licensePlate || "",
            lat: s.latitude, lng: s.longitude,
            driving: !!s.isDriving, speed: s.speed || 0,
            updated: s.dateTime || ""
          });
        });
        vehicles = out;
        renderVehicles();
        if (selectedVehId) openVehiclePanel(selectedVehId, true);
      }, function (err) {
        console.warn("vehicle load failed", err);
        vehicles = demoVehicles(); renderVehicles();
      });
    }

    function fitFleet() {
      var pts = vehicles.filter(function (v) { return v.lat && v.lng; }).map(function (v) { return [v.lat, v.lng]; });
      if (!pts.length) { toast(t("noVehiclesPos")); return; }
      if (pts.length === 1) map.setView(pts[0], 13);
      else map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 13 });
    }

    /* ---- controls ---- */
    function setType(type) {
      filters.type = type;
      var segs = $("cfmTypeSeg").children;
      for (var i = 0; i < segs.length; i++) segs[i].classList.toggle("is-active", segs[i].getAttribute("data-type") === type);
      $("cfmChargeFilters").hidden = type === "fuel";
      $("cfmFuelFilters").hidden = type === "charge";
      onMove();
    }

    function bind() {
      var seg = $("cfmTypeSeg").children;
      for (var i = 0; i < seg.length; i++) {
        seg[i].addEventListener("click", (function (b) { return function () { setType(b.getAttribute("data-type")); }; })(seg[i]));
      }
      $("cfmVehBtn").addEventListener("click", function () {
        showVehicles = !showVehicles;
        this.classList.toggle("is-on", showVehicles);
        this.setAttribute("aria-pressed", showVehicles ? "true" : "false");
        if (!showVehicles) { closePanel(); }
        renderVehicles();
      });
      $("cfmLocateBtn").addEventListener("click", fitFleet);
      $("cfmRefreshBtn").addEventListener("click", function () { loadVehicles(); onMove(); });
      $("cfmLangBtn").addEventListener("click", function () {
        LANG = LANG === "nl" ? "en" : "nl";
        try { localStorage.setItem(LANG_KEY, LANG); } catch (e) {}
        $("cfmLangCode").textContent = LANG.toUpperCase();
        applyStaticI18n();
        renderMarkers();
        setSource("done");
        if (selectedVehId) openVehiclePanel(selectedVehId, true);
      });
      $("cfmThemeBtn").addEventListener("click", function () {
        var next = currentTheme() === "dark" ? "light" : "dark";
        applyTheme(next);
        setTiles(next);
      });
      $("cfmPanelClose").addEventListener("click", closePanel);

      $("cfmAvailOnly").addEventListener("change", function () { filters.availOnly = this.checked; renderMarkers(); });
      $("cfmFastOnly").addEventListener("change", function () { filters.fastOnly = this.checked; renderMarkers(); });
      $("cfmMinPower").addEventListener("input", function () {
        filters.minPower = +this.value;
        $("cfmMinPowerVal").textContent = this.value + " kW";
        renderMarkers();
      });
      $("cfmConnector").addEventListener("change", function () { filters.connector = this.value; renderMarkers(); });
      $("cfmFuelKind").addEventListener("change", function () { filters.fuelKind = this.value; renderMarkers(); });
      $("cfmOpenNow").addEventListener("change", function () { filters.openNow = this.checked; renderMarkers(); });

      // delegated: nearest-card click + "show on MyGeotab map"
      $("cfmPanelBody").addEventListener("click", function (e) {
        var nc = e.target.closest ? e.target.closest(".cfm-near-card") : null;
        if (nc) {
          var kind = nc.getAttribute("data-kind"), sid = nc.getAttribute("data-near");
          var s = cache[kind][sid];
          if (s) openStationPanel(s);
          return;
        }
        var gm = e.target.closest ? e.target.closest("[data-gomap]") : null;
        if (gm) {
          var ll = gm.getAttribute("data-gomap");
          try { window.parent.location.hash = "map,zoom:16,center:(" + ll.split(",")[0] + "," + ll.split(",")[1] + ")"; }
          catch (err) { toast("MyGeotab"); }
        }
      });

      window.addEventListener("resize", debounce(function () { if (map) map.invalidateSize(); }, 200));
    }

    /* ---- lifecycle ---- */
    function start() {
      applyTheme(currentTheme());
      applyStaticI18n();
      $("cfmLangCode").textContent = LANG.toUpperCase();
      bind();
      initMap();
      loadVehicles();
      if (availTimer) clearInterval(availTimer);
      availTimer = setInterval(refreshAvailability, CONFIG.availabilityRefreshMs);
      setTimeout(function () { if (map) map.invalidateSize(); }, 250);
    }

    return {
      initialize: function (api, state, cb) {
        apiRef = api || null;
        start();
        if (cb) cb();
      },
      focus: function (api) {
        apiRef = api || apiRef;
        if (map) { map.invalidateSize(); loadVehicles(); onMove(); }
      },
      blur: function () {
        if (availTimer) { clearInterval(availTimer); availTimer = null; }
      }
    };
  };

  if (STANDALONE) {
    var addin = geotab.addin.chargeFuelMap();
    addin.initialize(null, {}, function () {});
  }
})();
