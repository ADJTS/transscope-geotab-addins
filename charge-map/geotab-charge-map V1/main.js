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
    // Deployed proxy for NDW. Empty = skip NDW (charging falls back to OCM;
    // the live traffic/roadworks/warnings layers need this set — they're
    // served by the same worker via ?feed=jams|roadworks|warnings&bbox=...
    // e.g. "https://charge-proxy.yourname.workers.dev"
    chargeProxyUrl: "",
    // Open Charge Map key (https://openchargemap.org/site/profile/applications)
    ocmKey: "",
    ocmMaxResults: 250,
    // Modern vector basemap (OpenFreeMap, keyless) + keyless satellite / weather
    // overlays.
    basemap: {
      light: "https://tiles.openfreemap.org/styles/positron",
      dark: "https://tiles.openfreemap.org/styles/dark"
    },
    satelliteTiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    satelliteLabels: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    // Real weather (temperature, frost/ice risk) — Open-Meteo, keyless, no proxy needed.
    openMeteoUrl: "https://api.open-meteo.com/v1/forecast",
    wxGridSize: 4,            // NxN sample points across the current view
    wxCacheMs: 600000,        // reuse a grid's readings for 10 min
    wxIceTempC: 1,            // at/below this + any precipitation -> ice-risk styling
    // POI search: OpenStreetMap Nominatim - free, keyless, NOT Google Maps
    // (there's no free/keyless Google search API). Coverage is generally
    // solid for NL addresses; business names only resolve if that business
    // is itself mapped in OSM - searching the street address always works.
    nominatimUrl: "https://nominatim.openstreetmap.org/search",
    poiCountryCode: "nl",
    baseAttribution: '&copy; OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap',
    satAttribution: '&copy; Esri, Maxar, Earthstar Geographics',
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
      fAll: "Alle", fCharge: "Laden", fFuel: "Tanken", fNone: "Geen",
      toggleVehicles: "Voertuigen tonen/verbergen", fitFleet: "Zoom naar wagenpark",
      myLocation: "Mijn locatie", locFail: "Kon je locatie niet bepalen — wagenpark getoond",
      vehiclesOnly: "Alleen voertuigen",
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
      demoVeh: "Demo-voertuig", routing: "Route berekenen\u2026", routeFail: "Route niet beschikbaar",
      layers: "Kaartlagen", lyrMap: "Kaart", lyrSat: "Satelliet", lyrWeather: "Weer (temperatuur & gladheid)",
      wxFail: "Weerlaag niet beschikbaar", wxTitle: "Temperatuur", wxRiskTitle: "Kans op gladheid",
      wxFeels: "gevoelt als", wxRiskNote: "Rond het vriespunt met neerslag — kans op ijzel/sneeuw.",
      wxRiskShort: "gladheid",
      lyrJams: "Verkeer (files)", lyrRoadworks: "Wegwerkzaamheden & afsluitingen", lyrWarnings: "Waarschuwingen",
      lyrEz: "Milieu- & zero-emissiezones",
      lyrNdwSection: "Live · NDW", lyrNdwCaption: "Live verkeersdata van NDW (Nationale Databank Wegverkeersgegevens).",
      sitDelay: "Vertraging", sitSince: "Sinds", sitUntil: "Tot", sitFail: "Laag tijdelijk niet beschikbaar",
      ezZeroTitle: "Zero-emissiezone (bestel-/vrachtverkeer)", ezLowTitle: "Milieuzone (diesel)",
      ezFrom: "Vanaf", ezSince: "Sinds", ezUntil: "Tot", ezMoreInfo: "Meer informatie",
      charge: "Lading", fuelLevel: "Brandstofniveau", weather: "Weer",
      expandMap: "Kaart volledig scherm", tripsToday: "Trips vandaag", streetView: "Street View",
      msgToDriver: "Bericht", proximityAlert: "Melding", navFail: "Kon niet navigeren binnen MyGeotab",
      driver: "Bestuurder", noDriver: "Geen bestuurder toegewezen",
      msgAttachLoc: "Stuur dichtstbijzijnde {kind} als navigatiedoel",
      msgLocNone: "Geen locatie meesturen",
      chargeLocKind: "laadlocatie", fuelLocKind: "tankstation",
      msgDefault: "Hoi, kun je met {veh} naar het opgegeven punt rijden?",
      send: "Verstuur", msgNeedsLive: "Alleen beschikbaar binnen MyGeotab (niet in de preview).",
      msgNoTarget: "Geen laad-/tanklocatie gevonden om te delen.",
      msgSent: "Bericht verzonden naar Geotab Drive ✓", msgFailed: "Versturen mislukt — probeer opnieuw.",
      alertEnable: "Meld me als dit voertuig in de buurt komt", alertDistance: "Afstand",
      alertConnector: "Stekker", alertOn: "Melding ingeschakeld", alertOff: "Melding uitgeschakeld",
      alertChargeTitle: "Laadlocatie dichtbij", alertFuelTitle: "Tankstation dichtbij",
      alertBody: "{veh} is nu {km} km van {name}",
      alertHint: "Werkt zolang deze pagina open staat in je browser — controleert elke paar minuten en toont een melding.",
      save: "Opslaan",
      poiBtn: "POI", poiHead: "Eigen locaties (POI)", poiSearchPh: "Zoek adres of bedrijfsnaam…",
      poiSearch: "Zoek", poiListHead: "Jouw POI's", poiEmpty: "Nog geen POI's toegevoegd.",
      poiAttrib: "Zoeken via OpenStreetMap Nominatim (gratis, geen sleutel) — geen Google Maps.",
      poiSearching: "Zoeken…", poiNoResults: "Niets gevonden. Probeer het adres in plaats van de bedrijfsnaam.",
      poiSearchFail: "Zoeken mislukt — probeer opnieuw.", poiAdd: "Toevoegen als POI",
      poiAdded: "★ {name} toegevoegd", poiKicker: "Eigen locatie",
      poiDelete: "Verwijderen", poiDeleteConfirm: "\"{name}\" verwijderen?",
      alertTarget: "Doel", alertTargetStation: "Laadpunt / tankstation", alertTargetPoi: "Mijn POI's",
      alertPoiTitle: "POI dichtbij"
    },
    en: {
      eyebrow: "Charge & fuel", title: "Charge & Fuel Map",
      fAll: "All", fCharge: "Charging", fFuel: "Fuel", fNone: "None",
      toggleVehicles: "Show / hide vehicles", fitFleet: "Zoom to fleet",
      myLocation: "My location", locFail: "Couldn't get your location — showing fleet instead",
      vehiclesOnly: "Vehicles only",
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
      demoVeh: "Demo vehicle", routing: "Calculating route\u2026", routeFail: "Route unavailable",
      layers: "Map layers", lyrMap: "Map", lyrSat: "Satellite", lyrWeather: "Weather (temperature & ice risk)",
      wxFail: "Weather layer unavailable", wxTitle: "Temperature", wxRiskTitle: "Ice risk",
      wxFeels: "feels like", wxRiskNote: "Near freezing with precipitation — risk of ice/snow.",
      wxRiskShort: "ice risk",
      lyrJams: "Traffic (jams)", lyrRoadworks: "Roadworks & closures", lyrWarnings: "Warnings",
      lyrEz: "Low- & zero-emission zones",
      lyrNdwSection: "Live · NDW", lyrNdwCaption: "Live traffic data from NDW (Dutch national traffic database).",
      sitDelay: "Delay", sitSince: "Since", sitUntil: "Until", sitFail: "Layer temporarily unavailable",
      ezZeroTitle: "Zero-emission zone (vans/trucks)", ezLowTitle: "Low-emission zone (diesel)",
      ezFrom: "From", ezSince: "Since", ezUntil: "Until", ezMoreInfo: "More information",
      charge: "Charge", fuelLevel: "Fuel level", weather: "Weather",
      expandMap: "Expand map", tripsToday: "Trips today", streetView: "Street View",
      msgToDriver: "Message", proximityAlert: "Alert", navFail: "Couldn't navigate inside MyGeotab",
      driver: "Driver", noDriver: "No driver assigned",
      msgAttachLoc: "Send nearest {kind} as a navigation destination",
      msgLocNone: "Don't attach a location",
      chargeLocKind: "charging location", fuelLocKind: "fuel station",
      msgDefault: "Hi, can you drive {veh} to the location I've shared?",
      send: "Send", msgNeedsLive: "Only available inside MyGeotab (not in this preview).",
      msgNoTarget: "No charging/fuel location found to share.",
      msgSent: "Message sent to Geotab Drive ✓", msgFailed: "Sending failed — try again.",
      alertEnable: "Notify me when this vehicle gets close", alertDistance: "Distance",
      alertConnector: "Connector", alertOn: "Alert turned on", alertOff: "Alert turned off",
      alertChargeTitle: "Charging location nearby", alertFuelTitle: "Fuel station nearby",
      alertBody: "{veh} is now {km} km from {name}",
      alertHint: "Works as long as this page stays open in your browser — checks every few minutes and shows a notification.",
      save: "Save",
      poiBtn: "POI", poiHead: "Custom locations (POI)", poiSearchPh: "Search address or business name…",
      poiSearch: "Search", poiListHead: "Your POIs", poiEmpty: "No POIs added yet.",
      poiAttrib: "Search via OpenStreetMap Nominatim (free, no key) — not Google Maps.",
      poiSearching: "Searching…", poiNoResults: "Nothing found. Try the street address instead of the business name.",
      poiSearchFail: "Search failed — try again.", poiAdd: "Add as POI",
      poiAdded: "★ {name} added", poiKicker: "Custom location",
      poiDelete: "Delete", poiDeleteConfirm: "Delete \"{name}\"?",
      alertTarget: "Target", alertTargetStation: "Charging point / fuel station", alertTargetPoi: "My POIs",
      alertPoiTitle: "POI nearby"
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
    nodes = document.querySelectorAll("[data-i18n-placeholder]");
    for (i = 0; i < nodes.length; i++) { n = nodes[i]; n.placeholder = t(n.getAttribute("data-i18n-placeholder")); }
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
  function apiErrText(err) {
    if (!err) return "unknown error";
    if (typeof err === "string") return err;
    return err.message || err.name || (err.data && (err.data.message || err.data.name)) || JSON.stringify(err);
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
      ["EV-021", "Opel Movano-e", 52.0907, 5.1214, true, 54, 78, null, "Auke de Vries"],
      ["EV-034", "Peugeot e-Expert", 52.2158, 5.1680, false, 0, 34, null, "Eef Jansen"],
      ["VAN-034", "Ford E-Transit", 52.0110, 4.7080, true, 72, 61, null, "Willem Bakker"],
      ["CAR-071", "Kia e-Niro", 52.3702, 4.8952, false, 0, 15, null, "Jasper Hendriks"],
      ["EV-052", "Renault Kangoo E-Tech", 51.9410, 4.9310, true, 38, 92, null, ""],
      ["EV-067", "Mercedes eVito", 52.1560, 5.3880, false, 0, 47, null, ""],
      ["BUS-012", "Volkswagen Transporter (diesel)", 52.0450, 5.2100, false, 0, null, 63, "Sanne Visser"]
    ];
    return base.map(function (r) {
      return { id: r[0], name: r[0], model: r[1], lat: r[2], lng: r[3], driving: r[4], speed: r[5],
               soc: r[6], fuel: r[7], driverId: r[8] ? r[0] + "-drv" : null, driverName: r[8] || "",
               driverContact: r[8] ? r[8].toLowerCase().replace(/\s+/g, ".") + "@transscope.nl" : "",
               updated: new Date(Date.now() - 3e5).toISOString() };
    });
  }

  /* ==========================================================================
     Add-in
     ========================================================================= */
  geotab.addin.chargeFuelMap = function () {
    var map, baseMapLayer, satLayer, wxLayer, poiLayer, chargeCluster, fuelCluster, vehLayer, routeLine;
    var currentBase = "map";      // "map" | "sat"
    var wxOn = false;
    var pois = [];   // {id, name, address, lat, lng}
    var sitOn = { jams: false, roadworks: false, warnings: false, emissionzones: false };
    var sitLayers = { jams: null, roadworks: null, warnings: null, emissionzones: null };
    var sitLoading = { jams: false, roadworks: false, warnings: false, emissionzones: false };
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
      type: "none", availOnly: false, fastOnly: false, minPower: 0,
      connector: "", fuelKind: "", openNow: false
    };
    function wantCharge() { return filters.type === "all" || filters.type === "charge"; }
    function wantFuel() { return filters.type === "all" || filters.type === "fuel"; }

    var GLYPH = {
      bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
      fuel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M4 21h12"/><path d="M15 9h2.5A1.5 1.5 0 0 1 19 10.5V16a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7 8h6"/></svg>',
      car: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l2-5.5A2 2 0 0 1 6.9 6h10.2a2 2 0 0 1 1.9 1.5L21 13v6h-3v-2H6v2H3z"/><circle cx="7.5" cy="15.5" r="1.3"/><circle cx="16.5" cy="15.5" r="1.3"/></svg>',
      batt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10.5v3"/></svg>'
    };
    function battClass(pct) { return pct == null ? "lvl-na" : pct < 20 ? "lvl-low" : pct < 50 ? "lvl-mid" : "lvl-ok"; }
    function vehBadgeHtml(v) {
      if (v.soc != null) return '<span class="cfm-veh-badge kind-ev ' + battClass(v.soc) + '">' + GLYPH.batt + Math.round(v.soc) + "%</span>";
      if (v.fuel != null) return '<span class="cfm-veh-badge kind-fuel ' + battClass(v.fuel) + '">' + GLYPH.fuel + Math.round(v.fuel) + "%</span>";
      return "";
    }
    // GRID-style: a soft circular chip with a small pointer, colour by state.
    function markerIcon(kind, fast) {
      var glyph = kind === "fuel" ? GLYPH.fuel : GLYPH.bolt;
      return L.divIcon({
        className: "cfm-divicon",
        html: '<div class="cfm-pin p-' + kind + (fast ? " is-fast" : "") + '"><span class="cfm-pin-body">' + glyph + "</span></div>",
        iconSize: [28, 34], iconAnchor: [14, 32], popupAnchor: [0, -30]
      });
    }
    function clusterIcon(kind) {
      return function (cluster) {
        var n = cluster.getChildCount();
        var size = n < 10 ? 32 : n < 50 ? 38 : 44;
        return L.divIcon({
          html: '<div class="cfm-cluster c-' + kind + '">' + n + "</div>",
          className: "cfm-cluster-wrap",
          iconSize: [size, size]
        });
      };
    }
    function vehIcon(sel, badgeHtml) {
      return L.divIcon({
        className: "cfm-divicon",
        html: '<div class="cfm-veh-marker' + (sel ? " is-selected" : "") + '">' +
          (sel ? '<span class="cfm-veh-ping"></span>' : "") + GLYPH.car + (badgeHtml || "") + "</div>",
        iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18]
      });
    }

    /* ---- setup ---- */
    function initMap() {
      map = L.map("cfmMap", { zoomControl: true, attributionControl: true, worldCopyJump: true, minZoom: 3, maxZoom: 19 })
        .setView(CONFIG.defaultCenter, CONFIG.defaultZoom);
      map.attributionControl.setPrefix("");

      // dedicated panes so basemap < situations < weather chips < markers
      map.createPane("cfmBase");   map.getPane("cfmBase").style.zIndex = 200;
      map.createPane("cfmSituations"); map.getPane("cfmSituations").style.zIndex = 380;
      map.createPane("cfmWx");     map.getPane("cfmWx").style.zIndex = 390;

      currentBase = "map";
      buildBasemap(currentTheme());

      chargeCluster = L.markerClusterGroup({ maxClusterRadius: 46, disableClusteringAtZoom: 15, chunkedLoading: true, iconCreateFunction: clusterIcon("charge") });
      fuelCluster = L.markerClusterGroup({ maxClusterRadius: 46, disableClusteringAtZoom: 15, chunkedLoading: true, iconCreateFunction: clusterIcon("fuel") });
      vehLayer = L.layerGroup();
      map.addLayer(chargeCluster); map.addLayer(fuelCluster); map.addLayer(vehLayer);

      addLayerControl();
      addExpandControl();

      map.on("moveend", debounce(onMove, 600));
      map.on("click", function () { closePanel(); });
      if (STANDALONE) { window.__cfmMap = map; window.__cfmCache = cache; }
      onMove();
    }

    /* ---- basemaps + overlays ---- */
    var baseIsRaster = false;
    function styleFor(mode) { return mode === "dark" ? CONFIG.basemap.dark : CONFIG.basemap.light; }
    function buildBasemap(mode) {
      // Swap style in place if the GL layer already exists (avoids a teardown).
      if (baseMapLayer && !baseIsRaster && baseMapLayer.getMaplibreMap) {
        try { baseMapLayer.getMaplibreMap().setStyle(styleFor(mode)); return; } catch (e) {}
      }
      if (baseMapLayer && baseIsRaster) {
        baseMapLayer.setUrl("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_" +
          (mode === "dark" ? "Dark" : "Light") + "_Gray_Base/MapServer/tile/{z}/{y}/{x}");
        return;
      }
      if (typeof L.maplibreGL === "function") {
        baseIsRaster = false;
        baseMapLayer = L.maplibreGL({ style: styleFor(mode), attribution: CONFIG.baseAttribution });
      } else {
        baseIsRaster = true;
        baseMapLayer = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_" +
          (mode === "dark" ? "Dark" : "Light") + "_Gray_Base/MapServer/tile/{z}/{y}/{x}",
          { attribution: "&copy; Esri", pane: "cfmBase", maxZoom: 19 });
      }
      if (currentBase === "map") baseMapLayer.addTo(map);
    }
    function satGroup() {
      return L.layerGroup([
        L.tileLayer(CONFIG.satelliteTiles, { attribution: CONFIG.satAttribution, pane: "cfmBase", maxZoom: 19 }),
        L.tileLayer(CONFIG.satelliteLabels, { pane: "cfmBase", maxZoom: 19, opacity: 0.9 })
      ]);
    }
    function applyBase(key) {
      currentBase = key;
      if (baseMapLayer && map.hasLayer(baseMapLayer)) map.removeLayer(baseMapLayer);
      if (satLayer && map.hasLayer(satLayer)) map.removeLayer(satLayer);
      if (key === "sat") {
        if (!satLayer) satLayer = satGroup();
        satLayer.addTo(map);
      } else {
        if (!baseMapLayer) buildBasemap(currentTheme());
        baseMapLayer.addTo(map);
      }
    }
    /* ---- weather: real temperature + frost/ice risk (Open-Meteo, keyless) --
       A small grid of points across the current view, each a "12°" chip;
       chips at/below wxIceTempC with any precipitation/snow signal (current
       OR the WMO code predicting freezing rain/drizzle/snow) get the ice
       styling. No proxy needed - called directly from the browser. Readings
       are cached client-side per ~0.01° point for wxCacheMs so re-panning a
       few metres doesn't re-query; panning further only fetches the new
       points, all still in one batched request (Open-Meteo accepts a
       comma-list of lat/lon and returns one entry per point, same order). */
    var WX_RISK_CODES = [56, 57, 66, 67, 71, 73, 75, 77, 85, 86]; // freezing drizzle/rain, snow
    var wxCache = {};   // "lat,lon" -> {temp, feels, precip, snow, code, ts}
    function wxKey(lat, lon) { return lat.toFixed(2) + "," + lon.toFixed(2); }
    function wxIsIceRisk(c) {
      return c.temp <= CONFIG.wxIceTempC && ((c.precip || 0) > 0 || (c.snow || 0) > 0 || WX_RISK_CODES.indexOf(c.code) > -1);
    }
    function wxGridPoints(bx) {
      var n = CONFIG.wxGridSize, pts = [];
      for (var i = 0; i < n; i++) {
        for (var j = 0; j < n; j++) {
          pts.push([bx.s + (bx.n - bx.s) * (i + 0.5) / n, bx.w + (bx.e - bx.w) * (j + 0.5) / n]);
        }
      }
      return pts;
    }
    var WX_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M4.5 7l15 10M19.5 7l-15 10"/></svg>';
    function wxChipIcon(temp, risk) {
      var cls = risk ? "is-risk" : (temp <= CONFIG.wxIceTempC ? "is-cold" : "is-mild");
      var label = Math.round(temp) + "°";
      var w = risk ? 44 : 34;
      return L.divIcon({
        className: "cfm-divicon",
        html: '<div class="cfm-wx-chip ' + cls + '">' + (risk ? '<span class="cfm-wx-ico">' + WX_ICON + "</span>" : "") + "<span>" + label + "</span></div>",
        iconSize: [w, 22], iconAnchor: [w / 2, 11], popupAnchor: [0, -12]
      });
    }
    function wxPopup(c, risk) {
      var html = '<div class="cfm-sit-pop"><b>' + esc(t(risk ? "wxRiskTitle" : "wxTitle")) + "</b>";
      html += "<div>" + Math.round(c.temp) + "°C";
      if (c.feels != null && Math.round(c.feels) !== Math.round(c.temp)) html += " &middot; " + esc(t("wxFeels")) + " " + Math.round(c.feels) + "°C";
      html += "</div>";
      if (risk) html += '<div class="cfm-sit-meta">' + esc(t("wxRiskNote")) + "</div>";
      html += "</div>";
      return html;
    }
    function renderWeatherLayer(pts) {
      if (wxLayer) map.removeLayer(wxLayer);
      wxLayer = L.layerGroup();
      pts.forEach(function (p) {
        var c = wxCache[wxKey(p[0], p[1])];
        if (!c || c.temp == null) return;
        var risk = wxIsIceRisk(c);
        L.marker(p, { icon: wxChipIcon(c.temp, risk), pane: "cfmWx" }).bindPopup(wxPopup(c, risk)).addTo(wxLayer);
      });
      wxLayer.addTo(map);
    }
    function loadWeatherLayer() {
      if (!wxOn) return;
      var bx = boundsToBbox(map.getBounds(), 0.05);
      var pts = wxGridPoints(bx), now = Date.now();
      var need = pts.filter(function (p) { var c = wxCache[wxKey(p[0], p[1])]; return !c || now - c.ts > CONFIG.wxCacheMs; });
      if (!need.length) { renderWeatherLayer(pts); return; }
      setSitLoading("weather", true);
      var url = CONFIG.openMeteoUrl +
        "?latitude=" + need.map(function (p) { return p[0].toFixed(3); }).join(",") +
        "&longitude=" + need.map(function (p) { return p[1].toFixed(3); }).join(",") +
        "&current=temperature_2m,apparent_temperature,precipitation,snowfall,weather_code&timezone=auto";
      tfetch(url, {}, 10000).then(function (r) {
        if (!r.ok) throw new Error("open-meteo " + r.status);
        return r.json();
      }).then(function (j) {
        var arr = Array.isArray(j) ? j : [j];
        arr.forEach(function (d, i) {
          var p = need[i];
          if (!p || !d || !d.current) return;
          wxCache[wxKey(p[0], p[1])] = {
            temp: d.current.temperature_2m, feels: d.current.apparent_temperature,
            precip: d.current.precipitation, snow: d.current.snowfall, code: d.current.weather_code, ts: now
          };
        });
        setSitLoading("weather", false);
        if (wxOn) renderWeatherLayer(pts);
      }).catch(function (e) {
        setSitLoading("weather", false);
        console.warn("weather load failed", e);
        toast(t("wxFail"));
      });
    }
    function toggleWeather(on) {
      wxOn = on;
      if (!on) { if (wxLayer) { map.removeLayer(wxLayer); wxLayer = null; } return; }
      loadWeatherLayer();
    }
    // Small helper the vehicle panel uses to show "weather here" - reads the
    // nearest cached grid reading (no extra request) when the layer is on.
    function nearestWxReading(lat, lon) {
      var best = null, bd = Infinity;
      for (var k in wxCache) {
        var c = wxCache[k], parts = k.split(","), d = haversineKm([lat, lon], [Number(parts[0]), Number(parts[1])]);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    /* ---- Custom POIs: search (OpenStreetMap Nominatim, free/keyless — NOT
       Google, there's no free keyless Google search) and drop a bronze star.
       Persisted in localStorage, so they're private to this browser/viewer -
       there's no shared/team POI list yet. ---------------------------------- */
    var POIS_KEY = "cfmPois";
    var POI_STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.7 6.3 6.8.6-5.2 4.5 1.6 6.7L12 16.9l-5.9 3.7 1.6-6.7-5.2-4.5 6.8-.6z"/></svg>';
    var poiSearchSeq = 0;
    function loadPois() { try { return JSON.parse(localStorage.getItem(POIS_KEY) || "[]"); } catch (e) { return []; } }
    function savePois() { try { localStorage.setItem(POIS_KEY, JSON.stringify(pois)); } catch (e) {} }
    function poiIcon() {
      return L.divIcon({
        className: "cfm-divicon",
        html: '<div class="cfm-poi-marker"><span class="cfm-poi-marker-body">' + POI_STAR_SVG + "</span></div>",
        iconSize: [30, 34], iconAnchor: [15, 32], popupAnchor: [0, -30]
      });
    }
    function renderPois() {
      if (!poiLayer) poiLayer = L.layerGroup().addTo(map);
      poiLayer.clearLayers();
      pois.forEach(function (p) {
        L.marker([p.lat, p.lng], { icon: poiIcon(), zIndexOffset: 500 })
          .on("click", function () { openPoiPanel(p.id); })
          .addTo(poiLayer);
      });
    }
    function shortAddress(displayName) { return (displayName || "").split(",").slice(0, 3).join(",").trim(); }
    function poiSearchQuery(q) {
      var url = CONFIG.nominatimUrl + "?format=json&limit=6&addressdetails=0&q=" + encodeURIComponent(q) +
        (CONFIG.poiCountryCode ? "&countrycodes=" + CONFIG.poiCountryCode : "");
      return tfetch(url, { headers: { "Accept-Language": LANG } }, 8000).then(function (r) {
        if (!r.ok) throw new Error("nominatim " + r.status);
        return r.json();
      });
    }
    function runPoiSearch() {
      var input = $("cfmPoiQuery"), resultsEl = $("cfmPoiResults");
      var q = input.value.trim();
      if (!q) { resultsEl.innerHTML = ""; return; }
      var seq = ++poiSearchSeq;
      resultsEl.innerHTML = '<p class="cfm-poi-empty">' + esc(t("poiSearching")) + "</p>";
      poiSearchQuery(q).then(function (list) {
        if (seq !== poiSearchSeq) return;
        if (!list || !list.length) { resultsEl.innerHTML = '<p class="cfm-poi-empty">' + esc(t("poiNoResults")) + "</p>"; return; }
        resultsEl.innerHTML = list.map(function (r, i) {
          return '<div class="cfm-poi-result"><div class="cfm-poi-result-main"><div class="cfm-poi-result-name">' +
            esc(r.name || shortAddress(r.display_name)) + '</div><div class="cfm-poi-result-addr">' + esc(shortAddress(r.display_name)) + "</div></div>" +
            '<button class="cfm-poi-add-btn" data-poi-add="' + i + '" title="' + esc(t("poiAdd")) + '">+</button></div>';
        }).join("");
        resultsEl.querySelectorAll("[data-poi-add]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var r = list[Number(btn.getAttribute("data-poi-add"))];
            addPoi(r.name || shortAddress(r.display_name), shortAddress(r.display_name), Number(r.lat), Number(r.lon));
            resultsEl.innerHTML = "";
            input.value = "";
          });
        });
      }).catch(function () {
        if (seq !== poiSearchSeq) return;
        resultsEl.innerHTML = '<p class="cfm-poi-empty">' + esc(t("poiSearchFail")) + "</p>";
      });
    }
    function addPoi(name, address, lat, lng) {
      pois.push({ id: "poi_" + Date.now() + "_" + Math.round(Math.random() * 1e4), name: name, address: address, lat: lat, lng: lng });
      savePois();
      renderPois();
      renderPoiListUI();
      toast(t("poiAdded", { name: name }));
    }
    function renderPoiListUI() {
      var el = $("cfmPoiList");
      if (!el) return;
      if (!pois.length) { el.innerHTML = '<p class="cfm-poi-empty">' + esc(t("poiEmpty")) + "</p>"; return; }
      el.innerHTML = pois.map(function (p) {
        return '<div class="cfm-poi-item"><span class="cfm-poi-item-star">' + POI_STAR_SVG + "</span>" +
          '<div class="cfm-poi-item-main" data-poi-go="' + esc(p.id) + '"><div class="cfm-poi-item-name">' + esc(p.name) + '</div><div class="cfm-poi-item-addr">' + esc(p.address || "") + "</div></div>" +
          '<button class="cfm-poi-del-btn" data-poi-del="' + esc(p.id) + '" title="' + esc(t("poiDelete")) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button></div>';
      }).join("");
      el.querySelectorAll("[data-poi-go]").forEach(function (n) {
        n.addEventListener("click", function () {
          var id = n.getAttribute("data-poi-go"), p = null;
          for (var i = 0; i < pois.length; i++) if (pois[i].id === id) p = pois[i];
          if (p) { map.flyTo([p.lat, p.lng], 15, { duration: 0.6 }); openPoiPanel(id); closePoiDropdown(); }
        });
      });
      el.querySelectorAll("[data-poi-del]").forEach(function (n) {
        n.addEventListener("click", function (e) {
          e.stopPropagation();
          var id = n.getAttribute("data-poi-del"), p = null;
          for (var i = 0; i < pois.length; i++) if (pois[i].id === id) p = pois[i];
          if (p && !confirm(t("poiDeleteConfirm", { name: p.name }))) return;
          pois = pois.filter(function (x) { return x.id !== id; });
          savePois(); renderPois(); renderPoiListUI();
        });
      });
    }
    function closePoiDropdown() {
      var panel = $("cfmPoiPanel"); if (panel) panel.hidden = true;
      var btn = $("cfmPoiBtn"); if (btn) btn.classList.remove("is-on");
    }
    function openPoiPanel(id) {
      var p = null;
      for (var i = 0; i < pois.length; i++) if (pois[i].id === id) p = pois[i];
      if (!p) return;
      var html = "";
      html += '<div class="cfm-p-kicker">' + esc(t("poiKicker")) + "</div>";
      html += '<div class="cfm-p-title">' + esc(p.name) + "</div>";
      if (p.address) html += '<div class="cfm-p-addr">' + esc(p.address) + "</div>";
      html += '<div class="cfm-p-actions">' +
        '<a class="cfm-btn primary" href="https://www.google.com/maps/dir/?api=1&destination=' + p.lat + "," + p.lng + '&travelmode=driving" target="_blank" rel="noopener noreferrer">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>' + esc(t("navigate")) + "</a>" +
        '<button class="cfm-btn" id="cfmPoiStreet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M6 21c0-3.5 2.7-6 6-6s6 2.5 6 6"/></svg>' + esc(t("streetView")) + "</button>" +
        '<button class="cfm-btn" id="cfmPoiDelete" style="color:var(--cfm-full)">' + esc(t("poiDelete")) + "</button>" +
        "</div>";
      openPanel(html);
      map.panTo([p.lat, p.lng], { animate: true });
      var sb = $("cfmPoiStreet"); if (sb) sb.onclick = function () { window.open(streetViewUrl(p.lat, p.lng), "_blank", "noopener"); };
      var db = $("cfmPoiDelete"); if (db) db.onclick = function () {
        if (!confirm(t("poiDeleteConfirm", { name: p.name }))) return;
        pois = pois.filter(function (x) { return x.id !== id; });
        savePois(); renderPois(); renderPoiListUI(); closePanel();
      };
    }
    function nearestPoi(from) {
      var best = null, bd = Infinity;
      pois.forEach(function (p) {
        var d = haversineKm(from, [p.lat, p.lng]);
        if (d < bd) { bd = d; best = p; }
      });
      return best ? { s: { name: best.name, address: best.address, lat: best.lat, lng: best.lng }, km: bd } : null;
    }

    /* ---- live NDW situation layers: jams / roadworks / warnings ----------
       All three come from the same worker (?feed=...&bbox=...), which parses
       NDW's national DATEX II feeds server-side and returns only what's in
       view. Re-fetched on pan/zoom like charge/fuel, while their checkbox is on. */
    function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }
    var DELAY_LABEL = {
      noDelay: { nl: "Geen vertraging", en: "No delay" },
      upToTenMinutes: { nl: "tot 10 min", en: "up to 10 min" },
      tenToTwentyMinutes: { nl: "10-20 min", en: "10-20 min" },
      twentyToThirtyMinutes: { nl: "20-30 min", en: "20-30 min" },
      thirtyToFortyMinutes: { nl: "30-40 min", en: "30-40 min" },
      fortyToFiftyMinutes: { nl: "40-50 min", en: "40-50 min" },
      fiftyToSixtyMinutes: { nl: "50-60 min", en: "50-60 min" },
      greaterThanOneHour: { nl: "meer dan 1 uur", en: "over 1 hour" }
    };
    var SIT_TYPE_LABEL = {
      AbnormalTraffic: { nl: "Filevorming", en: "Traffic jam" },
      RoadOrCarriagewayOrLaneManagement: { nl: "Wegwerkzaamheden", en: "Roadworks" },
      ReroutingManagement: { nl: "Omleiding", en: "Rerouting" },
      GeneralNetworkManagement: { nl: "Verkeersmaatregel", en: "Traffic measure" },
      Accident: { nl: "Ongeval", en: "Accident" },
      VehicleObstruction: { nl: "Obstakel op de weg", en: "Vehicle obstruction" },
      GeneralObstruction: { nl: "Obstakel", en: "Obstruction" },
      NonWeatherRelatedRoadConditions: { nl: "Wegconditie", en: "Road condition" }
    };
    function sitLabel(map2, key, fallback) {
      var e = map2[key];
      return e ? e[LANG] || e.en : fallback || key;
    }
    function sitIcon(kind) {
      var glyph = kind === "roadwork"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 3 20h18L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/></svg>';
      return L.divIcon({
        className: "cfm-divicon",
        html: '<div class="cfm-sit-marker s-' + kind + '">' + glyph + "</div>",
        iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12]
      });
    }
    function sitPopup(feed, p) {
      var title = feed === "jams" ? sitLabel(SIT_TYPE_LABEL, "AbnormalTraffic") : sitLabel(SIT_TYPE_LABEL, p.type, p.type);
      var html = '<div class="cfm-sit-pop"><b>' + esc(title) + "</b>";
      if (p.comment) html += "<div>" + esc(p.comment) + "</div>";
      if (p.delayBand || p.delaySec) {
        var dl = p.delayBand && DELAY_LABEL[p.delayBand] ? DELAY_LABEL[p.delayBand][LANG] || DELAY_LABEL[p.delayBand].en
          : Math.round((p.delaySec || 0) / 60) + " min";
        html += '<div class="cfm-sit-meta">' + esc(t("sitDelay")) + ": " + esc(dl) + "</div>";
      }
      if (p.start) html += '<div class="cfm-sit-meta">' + esc(t("sitSince")) + " " + esc(relTime(p.start)) + "</div>";
      if (p.end) html += '<div class="cfm-sit-meta">' + esc(t("sitUntil")) + " " + esc(new Date(p.end).toLocaleString(LANG === "nl" ? "nl-NL" : "en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })) + "</div>";
      html += "</div>";
      return html;
    }
    function ezPopup(p) {
      var title = p.zoneType === "zero" ? t("ezZeroTitle") : t("ezLowTitle");
      var html = '<div class="cfm-sit-pop"><b>' + esc(p.name) + "</b>";
      html += '<div class="cfm-sit-meta">' + esc(title) + "</div>";
      var fmt = function (iso) { return new Date(iso).toLocaleDateString(LANG === "nl" ? "nl-NL" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }); };
      if (p.start) {
        var future = new Date(p.start) > new Date();
        html += '<div class="cfm-sit-meta">' + esc(t(future ? "ezFrom" : "ezSince")) + " " + esc(fmt(p.start)) + "</div>";
      }
      if (p.end) html += '<div class="cfm-sit-meta">' + esc(t("ezUntil")) + " " + esc(fmt(p.end)) + "</div>";
      if (p.url) html += '<div style="margin-top:7px"><a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">' + esc(t("ezMoreInfo")) + " &rarr;</a></div>";
      html += "</div>";
      return html;
    }
    function renderSituationLayer(feed, fc) {
      var group = L.layerGroup();
      if (feed === "emissionzones") {
        fc.features.forEach(function (f) {
          var p = f.properties, g = f.geometry;
          var color = p.zoneType === "zero" ? cssVar("--cfm-ez-zero") : cssVar("--cfm-ez-low");
          g.coordinates.forEach(function (poly) {
            var rings = poly.map(function (ring) { return ring.map(function (c) { return [c[1], c[0]]; }); });
            L.polygon(rings, {
              color: color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.12,
              dashArray: p.zoneType === "low" ? "6 4" : null, pane: "cfmSituations"
            }).bindPopup(ezPopup(p)).addTo(group);
          });
        });
        return group;
      }
      var lineColor = feed === "jams" ? cssVar("--cfm-jam") : cssVar("--cfm-roadwork");
      fc.features.forEach(function (f) {
        var p = f.properties, g = f.geometry;
        if (g.type === "MultiLineString") {
          var w = feed === "jams" && p.delaySec ? Math.max(3, Math.min(9, 3 + p.delaySec / 300)) : 4;
          var pl = L.polyline(g.coordinates.map(function (line) { return line.map(function (c) { return [c[1], c[0]]; }); }), {
            color: lineColor, weight: w, opacity: 0.82, dashArray: feed === "roadworks" ? "7 5" : null, pane: "cfmSituations"
          });
          pl.bindPopup(sitPopup(feed, p));
          pl.addTo(group);
          if (feed === "roadworks") {
            var mid = g.coordinates[0][Math.floor(g.coordinates[0].length / 2)];
            L.marker([mid[1], mid[0]], { icon: sitIcon("roadwork"), pane: "cfmSituations" }).bindPopup(sitPopup(feed, p)).addTo(group);
          }
        } else if (g.type === "Point") {
          L.marker([g.coordinates[1], g.coordinates[0]], { icon: sitIcon("warn"), pane: "cfmSituations" })
            .bindPopup(sitPopup(feed, p)).addTo(group);
        }
      });
      return group;
    }
    function situationUrl(feed, bx) {
      return CONFIG.chargeProxyUrl.replace(/\/$/, "") + "?feed=" + feed +
        "&bbox=" + [bx.w, bx.s, bx.e, bx.n].map(function (x) { return x.toFixed(5); }).join(",");
    }
    function setSitLoading(feed, on) {
      sitLoading[feed] = on;
      if (!lcEl) return;
      var sp = lcEl.querySelector('[data-spin="' + feed + '"]');
      if (sp) sp.hidden = !on;
    }
    function loadSituationLayer(feed) {
      if (!sitOn[feed] || !CONFIG.chargeProxyUrl) return;
      if (map.getZoom() < CONFIG.minZoomFetch) {
        if (sitLayers[feed]) { map.removeLayer(sitLayers[feed]); sitLayers[feed] = null; updateLayerCount(); }
        return;
      }
      var bx = boundsToBbox(map.getBounds(), 0.15);
      setSitLoading(feed, true);
      tfetch(situationUrl(feed, bx), {}, 20000).then(function (r) {
        if (!r.ok) throw new Error("sit " + r.status);
        return r.json();
      }).then(function (fc) {
        setSitLoading(feed, false);
        if (!sitOn[feed]) return;
        if (sitLayers[feed]) map.removeLayer(sitLayers[feed]);
        sitLayers[feed] = renderSituationLayer(feed, fc).addTo(map);
        updateLayerCount();
      }).catch(function (e) {
        setSitLoading(feed, false);
        console.warn(feed + " load failed", e);
        toast(t("sitFail"));
      });
    }
    function toggleSituation(feed, on) {
      sitOn[feed] = on;
      if (!on) {
        if (sitLayers[feed]) { map.removeLayer(sitLayers[feed]); sitLayers[feed] = null; }
        updateLayerCount();
        return;
      }
      loadSituationLayer(feed);
    }
    function refreshActiveSituationLayers() {
      ["jams", "roadworks", "warnings", "emissionzones"].forEach(function (feed) { if (sitOn[feed]) loadSituationLayer(feed); });
    }
    function updateLayerCount() {
      if (!lcEl) return;
      var n = 0;
      ["jams", "roadworks", "warnings", "emissionzones"].forEach(function (feed) {
        if (sitLayers[feed]) n += sitLayers[feed].getLayers().length;
      });
      var el = lcEl.querySelector(".cfm-layers-count");
      if (!el) return;
      if (n > 0) { el.textContent = n > 99 ? "99+" : String(n); el.hidden = false; } else { el.hidden = true; }
    }

    var lcEl = null;
    function addLayerControl() {
      var Ctl = L.Control.extend({
        options: { position: "topright" },
        onAdd: function () {
          var d = L.DomUtil.create("div", "cfm-layers");
          d.innerHTML =
            '<button class="cfm-layers-toggle" title="' + esc(t("layers")) + '" aria-label="' + esc(t("layers")) + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5zM2 13l10 5 10-5M2 18l10 5 10-5"/></svg>' +
              '<span data-i18n="layers">Kaartlagen</span>' +
              '<span class="cfm-layers-count" hidden></span>' +
            '</button>' +
            '<div class="cfm-layers-panel" hidden>' +
              '<div class="cfm-layers-head" data-i18n="layers">Kaartlagen</div>' +
              '<div class="cfm-layers-group">' +
                '<label><input type="radio" name="cfmbase" value="map" checked> <span data-i18n="lyrMap">Kaart</span></label>' +
                '<label><input type="radio" name="cfmbase" value="sat"> <span data-i18n="lyrSat">Satelliet</span></label>' +
              '</div>' +
              '<div class="cfm-layers-sep"></div>' +
              '<div class="cfm-layers-group">' +
                '<label><span class="cfm-layers-sublabel"><input type="checkbox" data-ov="wx"> <span data-i18n="lyrWeather">Weer (temperatuur &amp; gladheid)</span></span><span class="cfm-layers-spin" data-spin="weather" hidden></span></label>' +
              '</div>' +
              '<div class="cfm-layers-sectitle" data-i18n="lyrNdwSection">Live · NDW</div>' +
              '<div class="cfm-layers-group">' +
                '<label><span class="cfm-layers-sublabel"><span class="cfm-lyr-dot jam"></span><input type="checkbox" data-sit="jams"> <span data-i18n="lyrJams">Verkeer (files)</span></span><span class="cfm-layers-spin" data-spin="jams" hidden></span></label>' +
                '<label><span class="cfm-layers-sublabel"><span class="cfm-lyr-dot roadwork"></span><input type="checkbox" data-sit="roadworks"> <span data-i18n="lyrRoadworks">Wegwerkzaamheden &amp; afsluitingen</span></span><span class="cfm-layers-spin" data-spin="roadworks" hidden></span></label>' +
                '<label><span class="cfm-layers-sublabel"><span class="cfm-lyr-dot warn"></span><input type="checkbox" data-sit="warnings"> <span data-i18n="lyrWarnings">Waarschuwingen</span></span><span class="cfm-layers-spin" data-spin="warnings" hidden></span></label>' +
                '<label><span class="cfm-layers-sublabel"><span class="cfm-lyr-dot ez"></span><input type="checkbox" data-sit="emissionzones"> <span data-i18n="lyrEz">Milieu- &amp; zero-emissiezones</span></span><span class="cfm-layers-spin" data-spin="emissionzones" hidden></span></label>' +
              '</div>' +
              '<div class="cfm-layers-caption" data-i18n="lyrNdwCaption">Live verkeersdata van NDW (Nationale Databank Wegverkeersgegevens).</div>' +
            '</div>';
          L.DomEvent.disableClickPropagation(d);
          L.DomEvent.disableScrollPropagation(d);
          var toggle = d.querySelector(".cfm-layers-toggle");
          var panel = d.querySelector(".cfm-layers-panel");
          toggle.addEventListener("click", function () { panel.hidden = !panel.hidden; });
          d.querySelectorAll('input[name="cfmbase"]').forEach(function (r) {
            r.addEventListener("change", function () { if (r.checked) applyBase(r.value); });
          });
          d.querySelector('input[data-ov="wx"]').addEventListener("change", function () { toggleWeather(this.checked); });
          d.querySelectorAll("input[data-sit]").forEach(function (cb) {
            cb.addEventListener("change", function () { toggleSituation(cb.getAttribute("data-sit"), cb.checked); });
          });
          lcEl = d;
          return d;
        }
      });
      map.addControl(new Ctl());
      applyStaticI18n();
    }
    function syncLayerControl() {
      if (!lcEl) return;
      var w = lcEl.querySelector('input[data-ov="wx"]'); if (w) w.checked = wxOn;
      ["jams", "roadworks", "warnings", "emissionzones"].forEach(function (feed) {
        var cb = lcEl.querySelector('input[data-sit="' + feed + '"]');
        if (cb) cb.checked = sitOn[feed];
      });
    }
    /* ---- expand / fullscreen ---- */
    function isExpanded() { return document.getElementById("cfmApp").classList.contains("is-fullscreen"); }
    function toggleFullscreen() {
      var app = document.getElementById("cfmApp");
      var goingFull = !isExpanded();
      app.classList.toggle("is-fullscreen", goingFull);
      if (goingFull && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(function () {}); // MyGeotab's iframe may not allow this - the CSS-only expand above still works either way
      } else if (!goingFull && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
      var btn = document.getElementById("cfmExpandBtn");
      if (btn) btn.innerHTML = goingFull ? EXPAND_ICON.collapse : EXPAND_ICON.expand;
      setTimeout(function () { map.invalidateSize(); }, 260);
    }
    var EXPAND_ICON = {
      expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
      collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4"/></svg>'
    };
    function addExpandControl() {
      var Ctl = L.Control.extend({
        options: { position: "topleft" },
        onAdd: function () {
          var d = L.DomUtil.create("div", "leaflet-bar cfm-expand-ctl");
          d.innerHTML = '<a href="#" id="cfmExpandBtn" role="button" title="' + esc(t("expandMap")) + '" data-i18n-title="expandMap">' + EXPAND_ICON.expand + "</a>";
          L.DomEvent.disableClickPropagation(d);
          d.querySelector("a").addEventListener("click", function (e) { e.preventDefault(); toggleFullscreen(); });
          return d;
        }
      });
      map.addControl(new Ctl());
      document.addEventListener("fullscreenchange", function () {
        if (!document.fullscreenElement) {
          document.getElementById("cfmApp").classList.remove("is-fullscreen");
          var btn = document.getElementById("cfmExpandBtn");
          if (btn) btn.innerHTML = EXPAND_ICON.expand;
          setTimeout(function () { map.invalidateSize(); }, 260);
        }
      });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isExpanded()) toggleFullscreen(); });
    }
    function setTiles(mode) {   // kept name: called by the theme toggle
      buildBasemap(mode);
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
      refreshActiveSituationLayers();
      if (wxOn) loadWeatherLayer();
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
      if (wantCharge()) {
        pending++;
        fetchCharge(bx).then(function (r) {
          lastSrc.charge = r.src; mergeCache("charge", r.list);
        }).catch(function (e) { lastSrc.charge = "err"; console.warn("charge load", e); }).then(settle);
      }
      if (wantFuel() && fuelNeedsFetch(bx)) {
        pending++;
        fetchFuel(bx).then(function (r) {
          lastSrc.fuel = r.src; mergeCache("fuel", r.list); markFuelTiles(bx);
        }).catch(function (e) { lastSrc.fuel = "err"; console.warn("fuel load", e); }).then(settle);
      }
      if (pending === 0) { renderMarkers(); setSource("done"); }
    }
    function refreshAvailability() {
      if (!wantCharge()) return;
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
      if (wantCharge()) {
        for (var id in cache.charge) if (passCharge(cache.charge[id])) out.push(cache.charge[id]);
      }
      if (wantFuel()) {
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
        var mk = L.marker([s.lat, s.lng], { icon: markerIcon(st === "fuel" ? "fuel" : st, s.kind === "charge" && s.isFast) });
        mk.__sid = s.id; mk.__skind = s.kind;
        mk.on("click", (function (station) { return function () { openStationPanel(station); }; })(s));
        if (s.kind === "charge") { cLayers.push(mk); cc++; } else { fLayers.push(mk); fc++; }
      }
      chargeCluster.addLayers(cLayers);
      fuelCluster.addLayers(fLayers);
      $("cfmCount").textContent = filters.type === "none" ? t("vehiclesOnly") : t("countTpl", { c: cc, f: fc });
      renderVehicles();
    }

    function renderVehicles() {
      vehLayer.clearLayers();
      vehMarkers = {};
      if (!showVehicles) return;
      vehicles.forEach(function (v) {
        if (typeof v.lat !== "number" || typeof v.lng !== "number" || (!v.lat && !v.lng)) return;
        var mk = L.marker([v.lat, v.lng], { icon: vehIcon(v.id === selectedVehId, vehBadgeHtml(v)), zIndexOffset: 1000 });
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
      if (filters.type === "none") { el.innerHTML = dot + t("vehiclesOnly"); return; }
      var sc = lastSrc.charge, sf = lastSrc.fuel, txt;
      if (sc === "err" || sf === "err") { el.className = "cfm-source is-error"; }
      if (sc === "demo") { el.className = "cfm-source is-stale"; txt = t("demoSource"); }
      else {
        var parts = [];
        if (wantCharge() && sc && sc !== "err") parts.push(sc);
        if (wantFuel() && sf && sf !== "err") parts.push(sf);
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
      var ico = '<span class="cfm-near-chip n-' + st + '">' + (kind === "fuel" ? GLYPH.fuel : GLYPH.bolt) + "</span>";
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
        ico +
        '<div class="cfm-near-main"><div class="cfm-near-name">' + esc(res.s.name) + " " + badge + "</div>" +
        '<div class="cfm-near-sub">' + esc(sub) + "</div></div>" +
        '<div class="cfm-near-dist"><b>' + fmtMin(min) + " min</b><span>\u2248 " + fmtKm(roadKm) + " " + t("kmUnit") + "</span></div></div>";
    }

    var TOOL_ICON = {
      trips: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11a3 3 0 0 1 0 6H7a3 3 0 0 0 0 6h14"/><circle cx="19" cy="7" r="1.5"/><circle cx="5" cy="19" r="1.5"/></svg>',
      msg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-11.9 7.8L3 21l1.7-6.1A8.5 8.5 0 1 1 21 11.5Z"/></svg>',
      street: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M6 21c0-3.5 2.7-6 6-6s6 2.5 6 6"/></svg>',
      bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>'
    };
    function tripsUrl(deviceId) {
      var start = new Date(); start.setHours(0, 0, 0, 0);
      return "tripsHistory,devices:!(" + deviceId + "),dateRange:(startDate:'" + start.toISOString() + "',endDate:'" + new Date().toISOString() + "')";
    }
    function streetViewUrl(lat, lng) {
      return "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + lat + "," + lng;
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

      html += '<div class="cfm-p-toolrow">' +
        '<button class="cfm-tool-btn" id="cfmTripsBtn" data-i18n-title="tripsToday" title="Trips today">' + TOOL_ICON.trips + '<span data-i18n="tripsToday">Trips vandaag</span></button>' +
        '<button class="cfm-tool-btn" id="cfmStreetBtn" data-i18n-title="streetView" title="Street View">' + TOOL_ICON.street + '<span data-i18n="streetView">Street View</span></button>' +
        '<button class="cfm-tool-btn" id="cfmMsgToggleBtn" data-i18n-title="msgToDriver" title="Message">' + TOOL_ICON.msg + '<span data-i18n="msgToDriver">Bericht</span></button>' +
        '<button class="cfm-tool-btn" id="cfmAlertToggleBtn" data-i18n-title="proximityAlert" title="Alert">' + TOOL_ICON.bell + '<span data-i18n="proximityAlert">Melding</span></button>' +
        "</div>";

      html += '<div class="cfm-p-rows">';
      html += pRow(t("status"), v.driving ? t("driving") : t("parked"));
      if (v.driving) html += pRow(t("speed"), Math.round(v.speed || 0) + " km/h");
      if (v.soc != null) html += pRow(t("charge"), Math.round(v.soc) + "%");
      else if (v.fuel != null) html += pRow(t("fuelLevel"), Math.round(v.fuel) + "%");
      if (v.updated) html += pRow(t("lastSeen"), relTime(v.updated));
      if (wxOn) {
        var wx = nearestWxReading(v.lat, v.lng);
        if (wx) {
          var wxRisk = wxIsIceRisk(wx);
          html += pRow(t("weather"), Math.round(wx.temp) + "°C" + (wxRisk ? " ❄ " + t("wxRiskShort") : ""));
        }
      }
      html += "</div>";

      html += '<div class="cfm-driver">' +
        '<div class="cfm-driver-label">' + esc(t("driver")) + "</div>";
      if (v.driverName) {
        html += '<div class="cfm-driver-name">' + esc(v.driverName) + "</div>";
        if (v.driverContact) html += '<div class="cfm-driver-contact">' + esc(v.driverContact) + "</div>";
      } else {
        html += '<div class="cfm-driver-none">' + esc(t("noDriver")) + "</div>";
      }
      html += "</div>";

      // message-to-Drive compose (hidden until the toolrow button opens it)
      html += '<div class="cfm-p-expand" id="cfmMsgBox" hidden>' +
        '<div class="cfm-msg-loc-group" style="margin-bottom:8px">' +
        '<label class="cfm-check"><input type="radio" name="cfmMsgLocTarget" id="cfmMsgLocNone" value="none" checked> <span data-i18n="msgLocNone">' + esc(t("msgLocNone")) + "</span></label>" +
        '<label class="cfm-check"><input type="radio" name="cfmMsgLocTarget" id="cfmMsgLocCharge" value="charge"' + (nc ? "" : " disabled") + "> <span>" + esc(t("msgAttachLoc", { kind: t("chargeLocKind") })) + "</span></label>" +
        '<label class="cfm-check"><input type="radio" name="cfmMsgLocTarget" id="cfmMsgLocFuel" value="fuel"' + (nf ? "" : " disabled") + "> <span>" + esc(t("msgAttachLoc", { kind: t("fuelLocKind") })) + "</span></label>" +
        "</div>" +
        '<textarea id="cfmMsgText" class="cfm-textarea" rows="3">' + esc(t("msgDefault", { veh: v.name })) + "</textarea>" +
        '<div class="cfm-p-actions"><button class="cfm-btn primary" id="cfmMsgSend">' + TOOL_ICON.msg + '<span data-i18n="send">Verstuur</span></button></div>' +
        '<div class="cfm-msg-note" id="cfmMsgNote"></div>' +
        "</div>";

      // proximity-alert config (hidden until the bell button opens it)
      var alertCfg = loadAlertSettings()[v.id] || { enabled: false, km: 3, mode: "any", target: "station" };
      html += '<div class="cfm-p-expand" id="cfmAlertBox" hidden>' +
        '<label class="cfm-check" style="margin-bottom:10px"><input type="checkbox" id="cfmAlertEnabled"' + (alertCfg.enabled ? " checked" : "") + '> <span data-i18n="alertEnable">Meld me als dit voertuig in de buurt komt</span></label>' +
        '<div class="cfm-alert-row"><span data-i18n="alertTarget">Doel</span><select id="cfmAlertTarget" class="cfm-mini-select">' +
        '<option value="station"' + (alertCfg.target !== "poi" ? " selected" : "") + ' data-i18n="alertTargetStation">Laadpunt / tankstation</option>' +
        '<option value="poi"' + (alertCfg.target === "poi" ? " selected" : "") + ' data-i18n="alertTargetPoi">Mijn POI’s</option>' +
        "</select></div>" +
        '<div class="cfm-alert-row"><span data-i18n="alertDistance">Afstand</span><input type="number" id="cfmAlertKm" min="1" max="20" step="1" value="' + (alertCfg.km || 3) + '" class="cfm-alert-km" /> km</div>' +
        '<div class="cfm-alert-row" id="cfmAlertModeRow"' + (v.soc == null || alertCfg.target === "poi" ? " hidden" : "") + '><span data-i18n="alertConnector">Stekker</span><select id="cfmAlertMode" class="cfm-mini-select">' +
        '<option value="any"' + (alertCfg.mode === "any" ? " selected" : "") + ' data-i18n="connAny">Alle stekkers</option>' +
        '<option value="ac"' + (alertCfg.mode === "ac" ? " selected" : "") + '>AC</option>' +
        '<option value="dc"' + (alertCfg.mode === "dc" ? " selected" : "") + '>DC</option>' +
        "</select></div>";
      html += '<div class="cfm-p-actions"><button class="cfm-btn primary" id="cfmAlertSave"><span data-i18n="save">Opslaan</span></button></div>' +
        '<p class="cfm-alert-hint" data-i18n="alertHint">Werkt zolang deze pagina open staat in je browser — controleert elke paar minuten en toont een melding.</p>' +
        "</div>";

      html += '<div class="cfm-nearest"><h4>' + esc(t("nearestCharge")) + "</h4>" + nearCard(nc, "charge") + "</div>";
      html += '<div class="cfm-nearest"><h4>' + esc(t("nearestFuel")) + "</h4>" + nearCard(nf, "fuel") + "</div>";
      if (nc || nf) {
        html += '<div class="cfm-p-actions" style="margin-top:12px">' +
          '<button class="cfm-btn" id="cfmRouteBtn">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19h6a4 4 0 0 0 0-8H8a4 4 0 0 1 0-8h8"/></svg>' +
          esc(t("routeVia")) + "</button></div>";
      }
      openPanel(html);
      applyStaticI18n();
      bindVehiclePanelTools(v, nc, nf);
      if (!keepView) {
        // zoom IN on the vehicle so nearby charge/fuel is visible; nudge the
        // centre left a little so the right-hand panel doesn't cover it.
        var targetZoom = Math.max(map.getZoom(), 14);
        map.flyTo(from, targetZoom, { duration: 0.6 });
        map.once("moveend", function () {
          if (window.innerWidth > 720) map.panBy([-140, 0], { animate: true });
        });
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

    /* ---- vehicle panel tool buttons: trips / street view / message / alert ---- */
    function bindVehiclePanelTools(v, nc, nf) {
      var tripsBtn = $("cfmTripsBtn");
      if (tripsBtn) tripsBtn.onclick = function () {
        try { window.parent.location.hash = tripsUrl(v.id); }
        catch (e) { toast(t("navFail")); }
      };
      var streetBtn = $("cfmStreetBtn");
      if (streetBtn) streetBtn.onclick = function () {
        window.open(streetViewUrl(v.lat, v.lng), "_blank", "noopener");
      };

      var msgBox = $("cfmMsgBox"), alertBox = $("cfmAlertBox");
      var msgToggle = $("cfmMsgToggleBtn"), alertToggle = $("cfmAlertToggleBtn");
      if (msgToggle) msgToggle.onclick = function () {
        alertBox.hidden = true;
        msgBox.hidden = !msgBox.hidden;
      };
      if (alertToggle) alertToggle.onclick = function () {
        msgBox.hidden = true;
        alertBox.hidden = !alertBox.hidden;
      };

      var sendBtn = $("cfmMsgSend");
      if (sendBtn) sendBtn.onclick = function () {
        if (!apiRef) { $("cfmMsgNote").textContent = t("msgNeedsLive"); return; }
        var locTargetEl = document.querySelector('input[name="cfmMsgLocTarget"]:checked');
        var locKind = locTargetEl ? locTargetEl.value : "none";
        var useLoc = locKind !== "none";
        var text = $("cfmMsgText").value.trim();
        var target = locKind === "charge" ? nc : locKind === "fuel" ? nf : null;
        if (useLoc && !target) { $("cfmMsgNote").textContent = t("msgNoTarget"); return; }
        sendBtn.disabled = true;
        apiRef.getSession(function (credentials) {
          apiRef.call("Get", { typeName: "User", search: { name: credentials.userName } }, function (users) {
            var me = users && users[0];
            var entity = {
              isDirectionToVehicle: true,
              device: { id: v.id },
              messageContent: useLoc
                ? { contentType: "Location", message: text, address: (target.s.name + (target.s.address ? " — " + target.s.address : "")).slice(0, 80), latitude: Number(target.s.lat), longitude: Number(target.s.lng) }
                : { contentType: "Normal", message: text },
              user: me ? { id: me.id } : undefined
            };
            apiRef.call("Add", { typeName: "TextMessage", entity: entity }, function () {
              sendBtn.disabled = false;
              $("cfmMsgNote").textContent = t("msgSent");
              toast(t("msgSent"));
            }, function (err) {
              sendBtn.disabled = false;
              $("cfmMsgNote").textContent = t("msgFailed") + " (" + apiErrText(err) + ")";
              console.warn("send TextMessage failed", err, entity);
            });
          }, function (err) { sendBtn.disabled = false; $("cfmMsgNote").textContent = t("msgFailed") + " (" + apiErrText(err) + ")"; console.warn(err); });
        }, false);
      };

      var targetSel = $("cfmAlertTarget"), modeRow = $("cfmAlertModeRow");
      if (targetSel) targetSel.onchange = function () {
        if (modeRow) modeRow.hidden = v.soc == null || targetSel.value === "poi";
      };

      var alertSave = $("cfmAlertSave");
      if (alertSave) alertSave.onclick = function () {
        var enabled = $("cfmAlertEnabled").checked;
        var km = Math.max(1, Math.min(20, Number($("cfmAlertKm").value) || 3));
        var modeSel = $("cfmAlertMode");
        var mode = modeSel ? modeSel.value : "any";
        var target = targetSel ? targetSel.value : "station";
        var all = loadAlertSettings();
        if (enabled) {
          all[v.id] = { enabled: true, km: km, mode: mode, target: target };
          if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
        } else {
          delete all[v.id];
        }
        saveAlertSettings(all);
        alertFiredState[v.id] = false;
        toast(t(enabled ? "alertOn" : "alertOff"));
        checkProximityAlerts();
      };
    }

    /* ---- proximity alerts: "tell me when this vehicle is near a matching
       charge point / fuel station". Foreground-only - it works for as long as
       this browser tab stays open (it polls every ALERT_POLL_MS and shows a
       Web Notification + in-app toast). It checks against stations already
       known to the map cache, pulling a fresh batch around each alert vehicle
       on every check so you don't have to have panned there yourself. There
       is no server-side/background piece - closing the tab stops it. */
    var ALERTS_KEY = "cfmAlerts";
    var ALERT_POLL_MS = 120000;
    var alertTimer = null;
    var alertFiredState = {};
    function loadAlertSettings() { try { return JSON.parse(localStorage.getItem(ALERTS_KEY) || "{}"); } catch (e) { return {}; } }
    function saveAlertSettings(obj) { try { localStorage.setItem(ALERTS_KEY, JSON.stringify(obj)); } catch (e) {} }
    function boxAround(v, pad) { return { w: v.lng - pad, s: v.lat - pad, e: v.lng + pad, n: v.lat + pad }; }
    function nearestForAlert(kind, from, mode) {
      var best = null, bd = Infinity, pool = cache[kind];
      for (var id in pool) {
        var s = pool[id];
        if (kind === "charge" && mode && mode !== "any") {
          var hasType = s.connectors.some(function (c) { return mode === "dc" ? c.powerType === "DC" : c.powerType === "AC"; });
          if (!hasType) continue;
        }
        var d = haversineKm(from, [s.lat, s.lng]);
        if (d < bd) { bd = d; best = s; }
      }
      return best ? { s: best, km: bd } : null;
    }
    function fireProximityNotification(v, res, kind) {
      var title = kind === "charge" ? t("alertChargeTitle") : kind === "poi" ? t("alertPoiTitle") : t("alertFuelTitle");
      var body = t("alertBody", { veh: v.name, name: res.s.name, km: fmtKm(res.km) });
      toast(body);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification(title, { body: body, tag: "cfm-alert-" + v.id }); } catch (e) {}
      }
    }
    function checkProximityAlerts() {
      var settings = loadAlertSettings();
      var enabledIds = Object.keys(settings).filter(function (id) { return settings[id] && settings[id].enabled; });
      if (!enabledIds.length) { if (alertTimer) { clearInterval(alertTimer); alertTimer = null; } return; }
      if (!alertTimer) alertTimer = setInterval(loadVehicles, ALERT_POLL_MS);
      var jobs = [];
      enabledIds.forEach(function (id) {
        var v = null;
        for (var i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) v = vehicles[i];
        if (!v || settings[id].target === "poi") return;   // POI mode needs no fetch - already in memory
        var kind = v.soc != null ? "charge" : "fuel";
        var bx = boxAround(v, 0.15);
        jobs.push((kind === "charge" ? fetchCharge(bx) : fetchFuel(bx))
          .then(function (r) { mergeCache(kind, r.list); })
          .catch(function () {}));
      });
      Promise.all(jobs).then(function () {
        enabledIds.forEach(function (id) {
          var v = null;
          for (var i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) v = vehicles[i];
          if (!v) return;
          var cfg = settings[id];
          var isPoi = cfg.target === "poi";
          var kind = isPoi ? "poi" : (v.soc != null ? "charge" : "fuel");
          var res = isPoi ? nearestPoi([v.lat, v.lng]) : nearestForAlert(kind, [v.lat, v.lng], cfg.mode);
          if (!res) return;
          var within = res.km <= (cfg.km || 3);
          if (within && !alertFiredState[id]) { alertFiredState[id] = true; fireProximityNotification(v, res, kind); }
          else if (!within) { alertFiredState[id] = false; }
        });
      });
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
    // Current EV charge / fuel level "above the pin" badge. NOTE: the exact
    // 0-100 vs 0-1 scale Geotab returns for these two diagnostics can differ
    // per fleet/firmware - normPct() below assumes <=1.5 means "fraction",
    // otherwise "already a percent". Sanity-check the first real readings
    // against a vehicle's own MyGeotab page once this is deployed, and adjust
    // normPct() if it's ever off by a factor of 100.
    var SOC_DIAGNOSTIC_ID = "DiagnosticStateOfChargeId";
    var FUEL_DIAGNOSTIC_ID = "DiagnosticFuelLevelId";
    var VEH_STATUS_LOOKBACK_H = 48;
    function normPct(v) {
      if (typeof v !== "number" || isNaN(v)) return null;
      var pct = v <= 1.5 ? v * 100 : v;
      return Math.max(0, Math.min(100, pct));
    }
    function latestByDevice(rows) {
      var out = {};
      (rows || []).forEach(function (row) {
        var did = row.device && row.device.id;
        if (!did || typeof row.data !== "number") return;
        var prev = out[did];
        if (!prev || new Date(row.dateTime) > new Date(prev.dateTime)) out[did] = { value: row.data, dateTime: row.dateTime };
      });
      return out;
    }
    function driverDisplayName(u) {
      if (!u) return "";
      var full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      return full || u.name || "";
    }
    function loadVehicles() {
      if (!apiRef) { vehicles = demoVehicles(); renderVehicles(); return; }
      var since = new Date(Date.now() - VEH_STATUS_LOOKBACK_H * 3600000).toISOString();
      apiRef.multiCall([
        ["Get", { typeName: "Device", search: {}, resultsLimit: 5000 }],
        ["Get", { typeName: "DeviceStatusInfo", search: {} }],
        ["Get", { typeName: "StatusData", search: { diagnosticSearch: { id: SOC_DIAGNOSTIC_ID }, fromDate: since } }],
        ["Get", { typeName: "StatusData", search: { diagnosticSearch: { id: FUEL_DIAGNOSTIC_ID }, fromDate: since } }],
        ["Get", { typeName: "User", search: { isDriver: true } }]
      ], function (r) {
        var devs = r[0] || [], dsi = r[1] || [];
        var socByDevice = latestByDevice(r[2]), fuelByDevice = latestByDevice(r[3]);
        var users = r[4] || [];
        var nameById = {}, userById = {};
        devs.forEach(function (d) { nameById[d.id] = d; });
        users.forEach(function (u) { userById[u.id] = u; });
        var out = [];
        dsi.forEach(function (s) {
          var did = s.device && s.device.id;
          if (!did) return;
          if (typeof s.latitude !== "number" || typeof s.longitude !== "number") return;
          if (!s.latitude && !s.longitude) return;
          var d = nameById[did] || {};
          var soc = socByDevice[did] ? normPct(socByDevice[did].value) : null;
          var fuel = soc == null && fuelByDevice[did] ? normPct(fuelByDevice[did].value) : null;
          var drv = s.driver && s.driver.id ? userById[s.driver.id] : null;
          out.push({
            id: did,
            name: d.name || did,
            model: d.licensePlate || "",
            lat: s.latitude, lng: s.longitude,
            driving: !!s.isDriving, speed: s.speed || 0,
            soc: soc, fuel: fuel,
            driverId: drv ? drv.id : null,
            driverName: driverDisplayName(drv),
            driverContact: drv && /@/.test(drv.name || "") ? drv.name : (drv && drv.phoneNumber) || "",
            updated: s.dateTime || ""
          });
        });
        vehicles = out;
        renderVehicles();
        if (selectedVehId) openVehiclePanel(selectedVehId, true);
        checkProximityAlerts();
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

    function goToMyLocation() {
      if (!navigator.geolocation) { toast(t("locFail")); fitFleet(); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        map.setView([pos.coords.latitude, pos.coords.longitude], 14);
      }, function () {
        toast(t("locFail"));
        fitFleet();
      }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    }

    /* ---- controls ---- */
    function setType(type) {
      filters.type = type;
      var segs = $("cfmTypeSeg").children;
      for (var i = 0; i < segs.length; i++) segs[i].classList.toggle("is-active", segs[i].getAttribute("data-type") === type);
      $("cfmChargeFilters").hidden = type === "fuel" || type === "none";
      $("cfmFuelFilters").hidden = type === "charge" || type === "none";
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
      $("cfmLocateBtn").addEventListener("click", goToMyLocation);
      $("cfmRefreshBtn").addEventListener("click", function () { loadVehicles(); onMove(); });
      $("cfmPoiBtn").addEventListener("click", function (e) {
        e.stopPropagation();
        var panel = $("cfmPoiPanel"), willOpen = panel.hidden;
        panel.hidden = !willOpen;
        this.classList.toggle("is-on", willOpen);
        if (willOpen) setTimeout(function () { $("cfmPoiQuery").focus(); }, 30);
      });
      document.addEventListener("click", function (e) {
        var wrap = document.querySelector(".cfm-poi-wrap");
        if (wrap && !wrap.contains(e.target)) closePoiDropdown();
      });
      $("cfmPoiPanel").addEventListener("click", function (e) { e.stopPropagation(); });
      $("cfmPoiSearchBtn").addEventListener("click", runPoiSearch);
      $("cfmPoiQuery").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runPoiSearch(); } });
      $("cfmPoiQuery").addEventListener("input", debounce(runPoiSearch, 700));
      $("cfmLangBtn").addEventListener("click", function () {
        LANG = LANG === "nl" ? "en" : "nl";
        try { localStorage.setItem(LANG_KEY, LANG); } catch (e) {}
        $("cfmLangCode").textContent = LANG.toUpperCase();
        applyStaticI18n();
        renderMarkers();
        setSource("done");
        if (selectedVehId) openVehiclePanel(selectedVehId, true);
        refreshActiveSituationLayers();   // re-render so popup text matches the new language
        if (wxOn) loadWeatherLayer();
      });
      $("cfmThemeBtn").addEventListener("click", function () {
        var next = currentTheme() === "dark" ? "light" : "dark";
        applyTheme(next);
        setTiles(next);
        refreshActiveSituationLayers();   // re-render so jam/roadwork colours match the new theme
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
      pois = loadPois();
      renderPois();
      renderPoiListUI();
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
