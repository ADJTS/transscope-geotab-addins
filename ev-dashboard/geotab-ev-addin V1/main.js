/* ============================================================================
   EV Fleet Dashboard - MyGeotab Add-In
   ----------------------------------------------------------------------------
   Reads live EV data from the MyGeotab API:
     - Device                      list of vehicles
     - StatusData                  latest reported diagnostic values
         DiagnosticStateOfChargeId               (%% state of charge)
         DiagnosticElectricVehicleChargingStateId (0 not charging / 1 AC / 2 DC)
     - BatteryStateOfHealth        battery degradation vs. original capacity
     - ChargeEvent                 completed charging session history
     - StatusData (fossil fleet)   DiagnosticFuelLevelId / DiagnosticOdometerId /
                                    DiagnosticEngineHoursId, for the "Other
                                    Vehicles" panel
     - Trip / FuelUsed             distance + fuel volume, combined into a
                                    best-effort fuel economy / emissions
                                    intensity estimate (see DIESEL_CO2_G_PER_LITRE
                                    comment below - FuelUsed's volume field
                                    name is unverified, degrades to "-" if wrong)

   The toolbar's charging-period filter (current/last week, last month,
   custom range) only scopes the "Total Charged" KPI's ChargeEvent lookup -
   live status (state of charge, charging now, current kWh) always reflects
   the last LOOKBACK_HOURS. Because "Current Charge" is inherently a live
   snapshot, it's blanked to "—" whenever the filter isn't "Current Week" -
   showing a live number next to a historical period was misleading (looked
   like the filter wasn't doing anything).

   Diagnostic IDs and object schemas are per the MyGeotab SDK / API reference
   (developers.geotab.com). Diagnostic support varies by OEM/telematics
   device - confirm availability for your fleet with:
       api.call("Get", { typeName: "Diagnostic", search: { searchText: "state of charge" } })
   before relying on this in production.

   Language (EN/NL) and dark-mode preferences are stored in localStorage and
   re-applied on load. The external build's dark mode is driven almost
   entirely by CSS variables (see style.css [data-theme="dark"]) - JS only
   toggles the data-theme attribute and re-renders dynamic content so
   translated text/labels regenerate too.
   ========================================================================= */

(function () {
  "use strict";

  // Production build: no demo/mock data or standalone self-bootstrap - only
  // real MyGeotab API data ever renders. A tiny defensive stub keeps this
  // script from throwing if it's ever opened outside MyGeotab by accident;
  // nothing renders without a real host calling initialize().
  if (typeof window.geotab === "undefined") { window.geotab = { addin: {} }; }

  var SOC_DIAGNOSTIC_ID = "DiagnosticStateOfChargeId";
  var CHARGE_STATE_DIAGNOSTIC_ID = "DiagnosticElectricVehicleChargingStateId";
  var LOOKBACK_HOURS = 24;

  // Fossil-fuel vehicle diagnostics ("Other Vehicles" panel) - documented
  // MyGeotab diagnostic IDs with their raw units:
  //   DiagnosticFuelLevelId    - percentage, no conversion
  //   DiagnosticOdometerId     - meters, divide by 1000 for km
  //   DiagnosticEngineHoursId  - seconds, divide by 3600 for hours
  var FUEL_LEVEL_DIAGNOSTIC_ID = "DiagnosticFuelLevelId";
  var ODOMETER_DIAGNOSTIC_ID = "DiagnosticOdometerId";
  var ENGINE_HOURS_DIAGNOSTIC_ID = "DiagnosticEngineHoursId";

  // Fuel Economy / Emissions Intensity (Other Vehicles panel) - BEST-EFFORT
  // ESTIMATE, unlike the diagnostics above. There's no single documented
  // MyGeotab field for either: real fuel economy is normally only available
  // pre-computed via the Data Connector (VehicleKpi_Daily's Distance_Km /
  // TotalFuel_Litres), which - like Make/Model - isn't reachable from
  // Add-Ins. This approximates it instead from two real-time-API entities:
  // Trip.distance (km, documented) and the FuelUsed entity (real entity,
  // but its exact volume field name ISN'T documented anywhere consulted for
  // this build - `.litres` below is an educated guess). Confirm with
  // api.call("Get", { typeName: "FuelUsed", ... }) against your live
  // database and adjust the field name if needed; this degrades gracefully
  // to "-" if the guess is wrong rather than throwing.
  var DIESEL_CO2_G_PER_LITRE = 2680; // adjust for your fleet's actual fuel type

  // Simple inline leaf glyph (SVG, no external icon font/CDN) - reused for
  // the title and the EV Vehicles KPI. currentColor lets CSS control tint.
  var LEAF_ICON_SVG = '<svg class="evfd-leaf-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" d="M17 3c-7 0-13 5-13 12 0 2 .5 3.5 1.5 5 1.5-6 4.5-11 11.5-14-5 3-8 8-9.5 13 1 .3 2 .4 3 .4 6.5 0 10.5-5.9 10.5-12.4 0-1-.3-2-1-3-1 0-2 0-3 0Z"/>' +
    '</svg>';

  // Emissions-avoided estimate (Fleet Composition panel): EV_KM_PER_KWH
  // reuses the same efficiency assumption as estRangeKm below; ICE_CO2_G_PER_KM
  // is a rough average-passenger-car tailpipe figure, not this fleet's actual
  // vehicle mix. Both are approximations, same as Geotab's own Green Fleet
  // metrics use per-vehicle-class factors - replace with real figures (or a
  // per-vehicle-class table) for production use.
  var EV_KM_PER_KWH = 5.5;
  var ICE_CO2_G_PER_KM = 192;

  // Charging Status cards (below Fleet Composition): simple SoC/charge-state
  // thresholds, not a MyGeotab "rule" object - adjust to match your fleet's
  // definition of "full" / "low" if needed.
  var FULL_CHARGE_SOC_THRESHOLD = 95;
  var LOW_CHARGE_SOC_THRESHOLD = 20;

  // Names of the MyGeotab Rules the customer creates under Rules & Groups ->
  // Rules. Matched via RuleSearch's wildcard name search, so a rule named
  // e.g. "EV lage acculading (fleet)" still matches. Edit these two strings
  // if the customer's actual rule names differ from what's shown here.
  var EV_ALERT_RULE_NAMES = { lowSoc: "EV lage acculading", chargeComplete: "EV klaar met laden" };
  // Confirmed by the user directly from their MyGeotab address bar: the
  // Rules configuration page is #rules.
  var RULES_PAGE_HASH = "rules";

  // "Charge & Fuel Map" companion add-in. CHARGE_MAP_HASH is the page name
  // MyGeotab gives that add-in's menu item - if the button below opens the
  // wrong page, open "Charge & Fuel Map" from the MyGeotab menu once, copy the
  // text after "#" in the browser address bar, and paste it here.
  // CHARGE_MAP_URL is a fallback: the public https address of the map page;
  // used to open it in a new browser tab if in-app navigation fails.
  var CHARGE_MAP_HASH = "chargeFuelMap";
  var CHARGE_MAP_URL = "";

  // Inline icon glyphs (SVG, no external icon font/CDN) for the Charging
  // Status cards - sized via CSS (width/height: 1em) rather than fixed
  // attributes, same approach as LEAF_ICON_SVG above.
  // Small clock/history glyph for the "Charging Sessions" button.
  var SESSIONS_ICON_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';

  var STATUS_ICONS = {
    full: '<svg class="evfd-status-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="7" width="18" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="21" y="10" width="2" height="4" fill="currentColor"/><rect x="4.5" y="9" width="13" height="6" fill="currentColor"/></svg>',
    low: '<svg class="evfd-status-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="7" width="18" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="21" y="10" width="2" height="4" fill="currentColor"/><rect x="4.5" y="9" width="3" height="6" fill="currentColor"/></svg>',
    charging: '<svg class="evfd-status-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    idle: '<svg class="evfd-status-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="7" width="18" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="21" y="10" width="2" height="4" fill="currentColor"/><line x1="1" y1="5" x2="21" y2="19" stroke="currentColor" stroke-width="1.8"/></svg>'
  };

  // ---- i18n ----------------------------------------------------------------
  // Every user-facing string lives here in English + Dutch. t(key, vars)
  // looks it up for the current language and substitutes {placeholders}.
  // Static markup elements carry data-i18n / data-i18n-title attributes;
  // applyStaticI18n() (re)paints those on load and on language change.
  // Dynamically-rendered content (KPIs, tables, alerts, etc.) calls t()
  // directly inside its own render*() function, so a language switch just
  // needs a fresh render() call using the last-loaded model.
  var I18N = {
    en: {
      title: "EV Fleet Dashboard",
      subtitle: "Battery health & charging status",
      periodCurrentWeek: "Current Week",
      periodLastWeek: "Last Week",
      periodLastMonth: "Last Month",
      periodCustom: "Custom Range",
      refresh: "Refresh",
      chargeFuelMap: "Charge & Fuel Map",
      chargingPeriod: "Charging period",
      alerts: "Alerts",
      alertsDropdownHead: "Alerts & Notifications",
      manageEvAlertRules: "Manage EV Alert Rules →",
      unknownVehicle: "Unknown vehicle",
      noAlerts: "No alerts.",
      noActiveAlerts: "No active alerts.",
      kpiTotalVehicles: "Total Vehicles",
      kpiEvVehicles: "EV Vehicles",
      kpiChargingNow: "Charging Now",
      kpiCurrentCharge: "Current Charge",
      kpiTotalCharged: "Total Charged",
      ofFleet: "% of fleet",
      acDcFast: "{ac} AC / {dc} DC fast",
      acDcSpec: "AC: up to 11 kW &middot; DC: over 11 kW",
      acDcKwhBreakdown: "{ac} kWh AC / {dc} kWh DC",
      avgKwhEv: "avg {avg} kWh/EV",
      currentChargeLiveOnly: "live value - n/a for {period}",
      zeroChargeEventsFound: " / 0 charge events found",
      fleetComposition: "Fleet Composition",
      fleetCompositionSub: "Electric vs. fossil fuel vehicles",
      electric: "Electric",
      fossilFuel: "Fossil Fuel",
      emissionsLabel: "Est. tailpipe emissions avoided ({period})",
      emissionsNote: "Based on {km} EV km charged vs. an average ICE vehicle at ~{gpkm} g CO2/km - adjust both factors for your actual fleet efficiency and vehicle mix.",
      chargingStatus: "Charging Status",
      chargingStatusSub: "EV fleet charge-state breakdown",
      fullCharge: "Full Charge",
      lowCharge: "Low Charge",
      charging: "Charging",
      notCharging: "Not Charging",
      assets: "Assets",
      fullChargeTooltip: "EVs at {pct}% state of charge or higher",
      lowChargeTooltip: "EVs at {pct}% state of charge or lower",
      chargingTooltip: "EVs currently charging (AC or DC fast)",
      notChargingTooltip: "EVs not currently charging",
      evFleetMonitoring: "EV Fleet Monitoring",
      evFleetMonitoringSub: "State of charge, state of health & estimated range",
      activeChargingSessions: "Active Charging Sessions",
      fromChargeEvent: "From ChargeEvent",
      otherVehicles: "Other Vehicles",
      otherVehiclesSub: "Fossil fuel fleet - fuel level, odometer & engine hours",
      colName: "Name",
      colLicensePlate: "License Plate",
      colMakeModel: "Make / Model",
      colStateOfCharge: "State of Charge",
      colCurrentKwh: "Current kWh",
      colTotalCapacity: "Total Capacity",
      colBatteryHealth: "Battery Health",
      colEstRange: "Est. Range",
      colChargingState: "Charging State",
      colLastReport: "Last Report",
      colAction: "Action",
      colFuelLevel: "Fuel Level",
      colFuelEconomy: "Fuel Economy",
      colOdometer: "Odometer",
      colEngineHours: "Engine Hours",
      colEmissionsIntensity: "Emissions Intensity",
      connecting: "Connecting to MyGeotab…",
      noEvsReporting: "No EVs reporting state-of-charge data in the last {h}h.",
      noFossilFound: "No fossil fuel vehicles found.",
      noActiveSessions: "No active sessions loaded yet.",
      noVehiclesCharging: "No vehicles are currently charging.",
      chipNotCharging: "Not charging",
      acCharging: "AC charging",
      dcFastCharging: "DC fast charging",
      dcFastBadge: "DC FAST",
      acLevel2Badge: "AC LEVEL 2",
      trips: "Trips",
      localizeVehicle: "Localize Vehicle",
      openVehicleAssetPage: "Open vehicle asset page",
      lookingUp: "Looking up...",
      estToFull: "Est. to full: {eta}",
      socLabel: "% state of charge",
      lowSocAlertTitle: "Low state of charge - {name}",
      lowSocAlertDetailRange: "{soc}% SoC, {range} km est. range",
      lowSocAlertDetail: "{soc}% SoC",
      batteryDegradingTitle: "Battery health degrading - {name}",
      batteryDegradingDetail: "State of health at {pct}%",
      syncedAt: "Synced {time}",
      loading: "Loading…",
      errorLoadingData: "Error loading data",
      minAgo: "<1 min ago",
      minsAgo: "{n} min ago",
      hrsAgo: "{n} hr ago",
      toggleDarkMode: "Toggle dark mode",
      chargingSessions: "Charging Sessions",
      close: "Close",
      periodToday: "Today",
      periodThisWeek: "This Week",
      noSessionsFound: "No charging sessions in this period.",
      localize: "Localize",
      locating: "Locating...",
      locationUnavailable: "Location unavailable"
    },
    nl: {
      title: "EV Wagenpark Dashboard",
      subtitle: "Batterijstatus & laadstatus",
      periodCurrentWeek: "Huidige Week",
      periodLastWeek: "Vorige Week",
      periodLastMonth: "Vorige Maand",
      periodCustom: "Aangepaste Periode",
      refresh: "Vernieuwen",
      chargeFuelMap: "Laad- & Tankkaart",
      chargingPeriod: "Laadperiode",
      alerts: "Meldingen",
      alertsDropdownHead: "Meldingen & Waarschuwingen",
      manageEvAlertRules: "Regels Beheren →",
      unknownVehicle: "Onbekend voertuig",
      noAlerts: "Geen meldingen.",
      noActiveAlerts: "Geen actieve meldingen.",
      kpiTotalVehicles: "Totaal Voertuigen",
      kpiEvVehicles: "Elektrische Voertuigen",
      kpiChargingNow: "Nu Aan Het Laden",
      kpiCurrentCharge: "Huidige Lading",
      kpiTotalCharged: "Totaal Geladen",
      ofFleet: "% van wagenpark",
      acDcFast: "{ac} AC / {dc} DC snel",
      acDcSpec: "AC: tot 11 kW &middot; DC: boven 11 kW",
      acDcKwhBreakdown: "{ac} kWh AC / {dc} kWh DC",
      avgKwhEv: "gem. {avg} kWh/EV",
      currentChargeLiveOnly: "live waarde - n.v.t. voor {period}",
      zeroChargeEventsFound: " / 0 laadsessies gevonden",
      fleetComposition: "Wagenparksamenstelling",
      fleetCompositionSub: "Elektrisch vs. fossiele brandstof voertuigen",
      electric: "Elektrisch",
      fossilFuel: "Fossiele Brandstof",
      emissionsLabel: "Geschatte vermeden uitlaatemissies ({period})",
      emissionsNote: "Gebaseerd op {km} elektrische km geladen vs. een gemiddeld verbrandingsmotorvoertuig op ~{gpkm} g CO2/km - pas beide factoren aan voor de werkelijke efficiëntie en samenstelling van uw wagenpark.",
      chargingStatus: "Laadstatus",
      chargingStatusSub: "Overzicht laadstatus elektrisch wagenpark",
      fullCharge: "Volledig Opgeladen",
      lowCharge: "Laag Opgeladen",
      charging: "Aan Het Laden",
      notCharging: "Niet Aan Het Laden",
      assets: "Voertuigen",
      fullChargeTooltip: "EV's met {pct}% laadstatus of hoger",
      lowChargeTooltip: "EV's met {pct}% laadstatus of lager",
      chargingTooltip: "EV's die momenteel worden opgeladen (AC of DC snel)",
      notChargingTooltip: "EV's die momenteel niet worden opgeladen",
      evFleetMonitoring: "EV Wagenpark Bewaking",
      evFleetMonitoringSub: "Laadstatus, batterijgezondheid & geschatte actieradius",
      activeChargingSessions: "Actieve Laadsessies",
      fromChargeEvent: "Van ChargeEvent",
      otherVehicles: "Overige Voertuigen",
      otherVehiclesSub: "Fossiele brandstof wagenpark - brandstofniveau, kilometerstand & motoruren",
      colName: "Naam",
      colLicensePlate: "Kenteken",
      colMakeModel: "Merk / Model",
      colStateOfCharge: "Laadstatus",
      colCurrentKwh: "Huidige kWh",
      colTotalCapacity: "Totale Capaciteit",
      colBatteryHealth: "Batterijgezondheid",
      colEstRange: "Geschatte Actieradius",
      colChargingState: "Laadstatus",
      colLastReport: "Laatste Melding",
      colAction: "Actie",
      colFuelLevel: "Brandstofniveau",
      colFuelEconomy: "Brandstofverbruik",
      colOdometer: "Kilometerstand",
      colEngineHours: "Motoruren",
      colEmissionsIntensity: "Emissie-intensiteit",
      connecting: "Verbinden met MyGeotab…",
      noEvsReporting: "Geen EV's met laadstatusgegevens in de afgelopen {h}u.",
      noFossilFound: "Geen voertuigen op fossiele brandstof gevonden.",
      noActiveSessions: "Nog geen actieve sessies geladen.",
      noVehiclesCharging: "Er wordt momenteel geen enkel voertuig opgeladen.",
      chipNotCharging: "Niet aan het laden",
      acCharging: "AC laden",
      dcFastCharging: "DC snelladen",
      dcFastBadge: "DC SNEL",
      acLevel2Badge: "AC NIVEAU 2",
      trips: "Ritten",
      localizeVehicle: "Voertuig Lokaliseren",
      openVehicleAssetPage: "Open voertuigpagina",
      lookingUp: "Opzoeken...",
      estToFull: "Geschat tot vol: {eta}",
      socLabel: "% laadstatus",
      lowSocAlertTitle: "Lage laadstatus - {name}",
      lowSocAlertDetailRange: "{soc}% laadstatus, {range} km geschatte actieradius",
      lowSocAlertDetail: "{soc}% laadstatus",
      batteryDegradingTitle: "Batterijgezondheid neemt af - {name}",
      batteryDegradingDetail: "Batterijgezondheid op {pct}%",
      syncedAt: "Gesynchroniseerd {time}",
      loading: "Laden…",
      errorLoadingData: "Fout bij laden van data",
      minAgo: "<1 min geleden",
      minsAgo: "{n} min geleden",
      hrsAgo: "{n} uur geleden",
      toggleDarkMode: "Donkere modus wisselen",
      chargingSessions: "Laadsessies",
      close: "Sluiten",
      periodToday: "Vandaag",
      periodThisWeek: "Deze Week",
      noSessionsFound: "Geen laadsessies in deze periode.",
      localize: "Lokaliseren",
      locating: "Lokaliseren...",
      locationUnavailable: "Locatie niet beschikbaar"
    }
  };

  var LANG_STORAGE_KEY = "evfdLang";
  var THEME_STORAGE_KEY = "evfdTheme";

  function getStoredLang() {
    try { return localStorage.getItem(LANG_STORAGE_KEY) || "en"; } catch (e) { return "en"; }
  }
  function setStoredLang(v) {
    try { localStorage.setItem(LANG_STORAGE_KEY, v); } catch (e) { /* private mode etc. - non-fatal */ }
  }
  function getStoredTheme() {
    try { return localStorage.getItem(THEME_STORAGE_KEY) || "light"; } catch (e) { return "light"; }
  }
  function setStoredTheme(v) {
    try { localStorage.setItem(THEME_STORAGE_KEY, v); } catch (e) { /* private mode etc. - non-fatal */ }
  }

  var currentLang = getStoredLang();
  if (!I18N[currentLang]) currentLang = "en";

  function t(key, vars) {
    var str = (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        str = str.split("{" + k + "}").join(vars[k]);
      });
    }
    return str;
  }

  // ---- Charging-period filter: controls the date range used only for the
  // ---- "Total Charged" KPI (ChargeEvent aggregation). Live status (state of
  // ---- charge, charging now, current kWh) always reflects the last
  // ---- LOOKBACK_HOURS, independent of this filter. Returns an i18n KEY
  // ---- (periodLabelKey), not a literal string, so callers translate it via
  // ---- t() at display time.
  function startOfWeek(d) {
    var date = new Date(d);
    var day = date.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function getPeriodRange(period, customFrom, customTo) {
    var now = new Date();
    if (period === "last_week") {
      var thisWeekStart = startOfWeek(now);
      var from = new Date(thisWeekStart);
      from.setDate(from.getDate() - 7);
      var to = new Date(thisWeekStart);
      to.setMilliseconds(-1);
      return { from: from, to: to, labelKey: "periodLastWeek" };
    }
    if (period === "last_month") {
      var y = now.getFullYear(), m = now.getMonth();
      var lmFrom = new Date(y, m - 1, 1, 0, 0, 0, 0);
      var lmTo = new Date(y, m, 1, 0, 0, 0, 0);
      lmTo.setMilliseconds(-1);
      return { from: lmFrom, to: lmTo, labelKey: "periodLastMonth" };
    }
    if (period === "custom") {
      var cFrom = customFrom ? new Date(customFrom + "T00:00:00") : startOfWeek(now);
      var cTo = customTo ? new Date(customTo + "T23:59:59") : now;
      return { from: cFrom, to: cTo, labelKey: "periodCustom" };
    }
    // default: current_week
    return { from: startOfWeek(now), to: now, labelKey: "periodCurrentWeek" };
  }

  geotab.addin.evFleetDashboard = function () {
    var elTableBody = document.getElementById("evfdTableBody");
    var elOtherTableBody = document.getElementById("evfdOtherTableBody");
    var elKpis = document.getElementById("evfdKpis");
    var elChargeCards = document.getElementById("evfdChargeCards");
    var elChargingStatus = document.getElementById("evfdChargingStatus");
    var elAlerts = document.getElementById("evfdAlerts");
    var elAlertBadge = document.getElementById("evfdAlertBadge");
    var elAlertCount = document.getElementById("evfdAlertCount");
    var elAlertDropdown = document.getElementById("evfdAlertDropdown");
    var elManageRulesBtn = document.getElementById("evfdManageRulesBtn");
    var elComposition = document.getElementById("evfdComposition");
    var elSyncText = document.getElementById("evfdSyncText");
    var elRefreshBtn = document.getElementById("evfdRefreshBtn");
    var elChargeMapBtn = document.getElementById("evfdChargeMapBtn");
    var elPeriodSelect = document.getElementById("evfdPeriodSelect");
    var elCustomRange = document.getElementById("evfdCustomRange");
    var elCustomFrom = document.getElementById("evfdCustomFrom");
    var elCustomTo = document.getElementById("evfdCustomTo");
    var elThemeToggle = document.getElementById("evfdThemeToggle");
    var elLangToggle = document.getElementById("evfdLangToggle");
    var elRoot = document.getElementById("evFleetDashboard");
    var elSessionsOverlay = document.getElementById("evfdSessionsOverlay");
    var elSessionsTitle = document.getElementById("evfdSessionsTitle");
    var elSessionsSub = document.getElementById("evfdSessionsSub");
    var elSessionsClose = document.getElementById("evfdSessionsClose");
    var elSessionsPeriod = document.getElementById("evfdSessionsPeriod");
    var elSessionsCustomRange = document.getElementById("evfdSessionsCustomRange");
    var elSessionsCustomFrom = document.getElementById("evfdSessionsCustomFrom");
    var elSessionsCustomTo = document.getElementById("evfdSessionsCustomTo");
    var elSessionsList = document.getElementById("evfdSessionsList");

    // Cached so a language/theme change can re-render dynamic content
    // (KPIs, tables, alerts...) without a fresh API round-trip.
    var lastModel = null;
    var lastSyncState = null; // { kind: "synced"|"error", time: Date|null }
    var ruleAlertsCache = []; // last-fetched Rule/ExceptionEvent-based alerts, merged in by renderAlerts
    var currentApi = null; // captured in initialize() so the sessions modal can query on demand
    // { deviceId, deviceName } of the vehicle the sessions modal is currently showing.
    var sessionsVehicle = null;

    function applyStaticI18n() {
      document.querySelectorAll("[data-i18n]").forEach(function (el) {
        el.textContent = t(el.getAttribute("data-i18n"));
      });
      document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
        el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
      });
      document.documentElement.lang = currentLang;
      document.title = t("title");
      updateSyncText();
    }

    function updateSyncText() {
      if (!lastSyncState) { elSyncText.textContent = t("loading"); return; }
      if (lastSyncState.kind === "synced") {
        elSyncText.textContent = t("syncedAt", { time: lastSyncState.time.toLocaleTimeString() });
      } else if (lastSyncState.kind === "error") {
        elSyncText.textContent = t("errorLoadingData");
      }
    }

    function applyTheme(theme) {
      elRoot.setAttribute("data-theme", theme);
      elThemeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
      setStoredTheme(theme);
      // Re-render dynamic content so it re-reads the (CSS-variable-backed)
      // colors under the new theme - most of it already just references
      // var(--evfd-...) directly and repaints for free, but this also
      // covers anything computed at render time.
      if (lastModel) render(lastModel);
    }

    function changeLanguage(lang) {
      if (!I18N[lang]) return;
      currentLang = lang;
      setStoredLang(lang);
      elLangToggle.setAttribute("data-active", lang);
      applyStaticI18n();
      if (lastModel) render(lastModel);
    }

    function loadAndRender(api) {
      var liveFromDate = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
      var period = getPeriodRange(elPeriodSelect.value, elCustomFrom.value, elCustomTo.value);

      api.multiCall([
        ["Get", { typeName: "Device", search: { fromDate: liveFromDate } }],
        ["Get", { typeName: "StatusData", search: { diagnosticSearch: { id: SOC_DIAGNOSTIC_ID }, fromDate: liveFromDate } }],
        ["Get", { typeName: "StatusData", search: { diagnosticSearch: { id: CHARGE_STATE_DIAGNOSTIC_ID }, fromDate: liveFromDate } }],
        ["Get", { typeName: "BatteryStateOfHealth", search: {} }],
        ["Get", { typeName: "ChargeEvent", search: { fromDate: liveFromDate } }],
        ["Get", { typeName: "ChargeEvent", search: { fromDate: period.from.toISOString(), toDate: period.to.toISOString() } }],
        ["Get", { typeName: "StatusData", search: { diagnosticSearch: { id: FUEL_LEVEL_DIAGNOSTIC_ID }, fromDate: liveFromDate } }],
        ["Get", { typeName: "StatusData", search: { diagnosticSearch: { id: ODOMETER_DIAGNOSTIC_ID }, fromDate: liveFromDate } }],
        ["Get", { typeName: "StatusData", search: { diagnosticSearch: { id: ENGINE_HOURS_DIAGNOSTIC_ID }, fromDate: liveFromDate } }],
        ["Get", { typeName: "Trip", search: { fromDate: liveFromDate } }],
        ["Get", { typeName: "FuelUsed", search: { fromDate: liveFromDate } }],
        ["Get", { typeName: "Rule", search: { name: "%" + EV_ALERT_RULE_NAMES.lowSoc + "%" } }],
        ["Get", { typeName: "Rule", search: { name: "%" + EV_ALERT_RULE_NAMES.chargeComplete + "%" } }]
      ], function (results) {
        try {
          var model = buildModel(results[0], results[1], results[2], results[3], results[4], results[6], results[7], results[8], results[9], results[10]);
          model.totalDeviceCount = (results[0] || []).length;
          model.totalChargedKwh = sumEnergyKwh(results[5]);
          model.acChargedKwh = sumEnergyKwh(results[5], "AC");
          model.dcChargedKwh = sumEnergyKwh(results[5], "DC");
          model.periodChargeEventCount = (results[5] || []).length;
          model.periodLabelKey = period.labelKey;
          model.isLivePeriod = elPeriodSelect.value === "current_week";
          console.log("EV Fleet Dashboard: period", period.labelKey, "(" + period.from.toISOString() + " to " + period.to.toISOString() + ") -",
            model.periodChargeEventCount, "ChargeEvent record(s),", model.totalChargedKwh, "kWh");
          render(model);
          lastSyncState = { kind: "synced", time: new Date() };
          updateSyncText();
          loadRuleAlerts(api, results[0], results[11], results[12]);
        } catch (e) {
          console.error("EV Fleet Dashboard: failed to process API results", e);
        }
      }, function (err) {
        console.error("EV Fleet Dashboard: MyGeotab API call failed", err);
        lastSyncState = { kind: "error", time: null };
        updateSyncText();
      });
    }

    // Rule/ExceptionEvent lookup runs as a second, separate step after the
    // main multiCall - ExceptionEvent can only be searched by rule ID, not
    // by name, so the Rule Get calls above have to resolve first. Renders
    // nothing (and leaves the built-in alerts working normally) until the
    // customer has actually created these two Rules in MyGeotab - a Rule
    // Get with no match just returns an empty array, not an error.
    function loadRuleAlerts(api, devices, lowSocRules, chargeCompleteRules) {
      var deviceNameById = {};
      (devices || []).forEach(function (d) { deviceNameById[d.id] = d.name || d.id; });
      var rules = [];
      if (lowSocRules && lowSocRules[0]) rules.push({ id: lowSocRules[0].id, name: lowSocRules[0].name, sev: "critical" });
      if (chargeCompleteRules && chargeCompleteRules[0]) rules.push({ id: chargeCompleteRules[0].id, name: chargeCompleteRules[0].name, sev: "info" });
      if (!rules.length) { ruleAlertsCache = []; return; }
      var fromDate = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
      api.multiCall(rules.map(function (r) {
        return ["Get", { typeName: "ExceptionEvent", search: { ruleSearch: { id: r.id }, fromDate: fromDate } }];
      }), function (results) {
        var alerts = [];
        rules.forEach(function (r, idx) {
          (results[idx] || []).forEach(function (ex) {
            var devId = ex.device && ex.device.id;
            var vehName = devId ? (deviceNameById[devId] || devId) : t("unknownVehicle");
            alerts.push({ sev: r.sev, title: r.name + " - " + vehName, detail: ex.activeFrom ? new Date(ex.activeFrom).toLocaleString() : "" });
          });
        });
        ruleAlertsCache = alerts;
        if (lastModel) renderAlerts(lastModel.vehicles);
      }, function (err) {
        console.error("EV Fleet Dashboard: rule-based alert lookup failed", err);
      });
    }

    // ChargeEvent's real schema, confirmed against developers.geotab.com/
    // myGeotab/apiReference/objects/ChargeEvent: energyConsumedKwh (Number,
    // kWh) and chargeType (String: "AC" / "DC" / "Unknown", from the
    // charger signal - no heuristic needed). Pass a chargeTypeFilter to sum
    // only that type; omit it for the fleet-wide total across both.
    function sumEnergyKwh(chargeEvents, chargeTypeFilter) {
      return (chargeEvents || []).reduce(function (sum, ce) {
        if (chargeTypeFilter && ce.chargeType !== chargeTypeFilter) return sum;
        return sum + (typeof ce.energyConsumedKwh === "number" ? ce.energyConsumedKwh : 0);
      }, 0);
    }

    // Make/Model isn't a field on Device itself - MyGeotab only exposes it
    // pre-decoded via the Data Connector's LatestVehicleMetadata feed, which
    // isn't reachable from Add-Ins (session-token auth only, no OData Basic
    // Auth). Decode client-side from the VIN via NHTSA's free, CORS-enabled
    // vPIC API instead (US-titled vehicles only - non-US VINs may not match).
    var vinCache = {};
    function decodeVin(vin, cb) {
      if (!vin) { cb(null); return; }
      if (Object.prototype.hasOwnProperty.call(vinCache, vin)) { cb(vinCache[vin]); return; }
      fetch("https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/" + encodeURIComponent(vin) + "?format=json")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var row = data.Results && data.Results[0];
          var result = (row && row.Make) ? (row.Make + (row.Model ? " " + row.Model : "")) : null;
          vinCache[vin] = result;
          cb(result);
        })
        .catch(function () { vinCache[vin] = null; cb(null); });
    }

    // Reduce a StatusData array to the single latest record per device.
    function latestByDevice(statusRows) {
      var map = {};
      (statusRows || []).forEach(function (row) {
        var id = row.device && row.device.id;
        if (!id) return;
        if (!map[id] || new Date(row.dateTime) > new Date(map[id].dateTime)) map[id] = row;
      });
      return map;
    }

    function buildModel(devices, socRows, chargeRows, sohRows, chargeEvents, fuelRows, odoRows, engineHourRows, tripRows, fuelUsedRows) {
      var socByDevice = latestByDevice(socRows);
      var chargeStateByDevice = latestByDevice(chargeRows);

      var sohByDevice = {};
      (sohRows || []).forEach(function (r) {
        var id = r.device && r.device.id;
        if (id) sohByDevice[id] = r;
      });

      var lastChargeEventByDevice = {};
      (chargeEvents || []).forEach(function (ce) {
        var id = ce.device && ce.device.id;
        if (!id) return;
        if (!lastChargeEventByDevice[id] || new Date(ce.startTime) > new Date(lastChargeEventByDevice[id].startTime)) {
          lastChargeEventByDevice[id] = ce;
        }
      });

      // A device only counts as "EV" here if it has reported a state-of-charge
      // reading in the lookback window.
      var vehicles = (devices || [])
        .filter(function (d) { return !!socByDevice[d.id]; })
        .map(function (d) {
          var soc = Math.round(socByDevice[d.id].data);
          var chargeStateVal = chargeStateByDevice[d.id] ? Math.round(chargeStateByDevice[d.id].data) : 0;
          var soh = sohByDevice[d.id];
          var sohPct = soh ? Math.round(soh.stateOfHealthMean * 100) : null;
          var capacityKwh = soh ? soh.currentBatteryCapacityMeanKwh : null;
          var lastEvent = lastChargeEventByDevice[d.id] || null;

          var estRangeKm = capacityKwh != null
            ? Math.round(capacityKwh * (soc / 100) * 5.5) // ~5.5 km/kWh, adjust per fleet's real consumption
            : null;

          return {
            id: d.id,
            name: d.name || d.id,
            licensePlate: d.licensePlate || null,
            vin: d.vehicleIdentificationNumber || null,
            soc: soc,
            sohPct: sohPct,
            estRangeKm: estRangeKm,
            chargeState: chargeStateVal,
            lastReport: socByDevice[d.id].dateTime,
            lastChargeEvent: lastEvent,
            capacityKwh: capacityKwh
          };
        });

      var fuelByDevice = latestByDevice(fuelRows);
      var odoByDevice = latestByDevice(odoRows);
      var engineHoursByDevice = latestByDevice(engineHourRows);

      // Sum Trip distance (km, per developers.geotab.com) and FuelUsed
      // volume per device over the lookback window, for the fuel economy /
      // emissions intensity estimate below.
      var distanceKmByDevice = {};
      (tripRows || []).forEach(function (t) {
        var id = t.device && t.device.id;
        if (!id || typeof t.distance !== "number") return;
        distanceKmByDevice[id] = (distanceKmByDevice[id] || 0) + t.distance;
      });
      var fuelLitresByDevice = {};
      (fuelUsedRows || []).forEach(function (f) {
        var id = f.device && f.device.id;
        if (!id || typeof f.litres !== "number") return;
        fuelLitresByDevice[id] = (fuelLitresByDevice[id] || 0) + f.litres;
      });

      // Everything that isn't an EV (per the same-window SoC test above) is
      // treated as a fossil-fuel vehicle for the "Other Vehicles" panel.
      var otherVehicles = (devices || [])
        .filter(function (d) { return !socByDevice[d.id]; })
        .map(function (d) {
          var fuel = fuelByDevice[d.id];
          var odo = odoByDevice[d.id];
          var engineHours = engineHoursByDevice[d.id];
          var lastReport = [fuel, odo, engineHours]
            .filter(Boolean)
            .map(function (r) { return r.dateTime; })
            .sort(function (a, b) { return new Date(b) - new Date(a); })[0] || null;

          var distanceKm = distanceKmByDevice[d.id] || null;
          var fuelLitres = fuelLitresByDevice[d.id] || null;
          var fuelEconomyKmPerL = (distanceKm && fuelLitres) ? distanceKm / fuelLitres : null;
          var emissionsIntensityGPerKm = (distanceKm && fuelLitres)
            ? (fuelLitres * DIESEL_CO2_G_PER_LITRE) / distanceKm
            : null;

          return {
            id: d.id,
            name: d.name || d.id,
            licensePlate: d.licensePlate || null,
            fuelPct: fuel ? Math.round(fuel.data) : null,
            odometerKm: odo ? Math.round(odo.data / 1000) : null,
            engineHours: engineHours ? (engineHours.data / 3600) : null,
            fuelEconomyKmPerL: fuelEconomyKmPerL,
            emissionsIntensityGPerKm: emissionsIntensityGPerKm,
            lastReport: lastReport
          };
        });

      return { vehicles: vehicles, otherVehicles: otherVehicles };
    }

    function statusFor(v) {
      if (v.soc <= 15) return "critical";
      if (v.sohPct != null && v.sohPct < 80) return "fair";
      if (v.soc <= 35) return "poor";
      if (v.sohPct != null && v.sohPct < 90) return "good";
      return "excellent";
    }

    function timeAgo(iso) {
      var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
      if (mins < 1) return t("minAgo");
      if (mins < 60) return t("minsAgo", { n: mins });
      return t("hrsAgo", { n: Math.round(mins / 60) });
    }

    function chargeStateLabel(state) {
      if (state === 1) return t("acCharging");
      if (state === 2) return t("dcFastCharging");
      return t("chipNotCharging");
    }

    // ---- Charging Sessions modal ---------------------------------------
    // "Today"/"This Week"/"Last Week"/"Custom" filter for the per-vehicle
    // session history popup - deliberately a separate, shorter set of
    // options from the main toolbar's period filter above.
    function getSessionsPeriodRange(period, customFrom, customTo) {
      var now = new Date();
      if (period === "today") {
        var startToday = new Date(now);
        startToday.setHours(0, 0, 0, 0);
        return { from: startToday, to: now };
      }
      if (period === "last_week") {
        var thisWeekStart = startOfWeek(now);
        var from = new Date(thisWeekStart);
        from.setDate(from.getDate() - 7);
        var to = new Date(thisWeekStart);
        to.setMilliseconds(-1);
        return { from: from, to: to };
      }
      if (period === "custom") {
        var cFrom = customFrom ? new Date(customFrom + "T00:00:00") : startOfWeek(now);
        var cTo = customTo ? new Date(customTo + "T23:59:59") : now;
        return { from: cFrom, to: cTo };
      }
      // default: this_week
      return { from: startOfWeek(now), to: now };
    }

    function openSessionsModal(deviceId, deviceName) {
      sessionsVehicle = { deviceId: deviceId, deviceName: deviceName };
      elSessionsSub.textContent = deviceName;
      elSessionsOverlay.hidden = false;
      loadSessions();
    }

    function closeSessionsModal() {
      elSessionsOverlay.hidden = true;
    }

    function loadSessions() {
      if (!sessionsVehicle) return;
      var period = getSessionsPeriodRange(elSessionsPeriod.value, elSessionsCustomFrom.value, elSessionsCustomTo.value);
      elSessionsList.innerHTML = '<p class="evfd-muted" style="padding:14px 4px;">' + t("loading") + '</p>';
      if (!currentApi) return;
      currentApi.call("Get", {
        typeName: "ChargeEvent",
        search: { deviceSearch: { id: sessionsVehicle.deviceId }, fromDate: period.from.toISOString(), toDate: period.to.toISOString() }
      }, function (rows) {
        renderSessions(rows || []);
      }, function (err) {
        console.error("EV Fleet Dashboard: failed to load charge sessions", err);
        elSessionsList.innerHTML = '<p class="evfd-muted" style="padding:14px 4px;">' + t("errorLoadingData") + '</p>';
      });
    }

    // AC vs. DC per session comes straight from ChargeEvent.chargeType
    // ("AC" / "DC" / "Unknown" - developers.geotab.com/myGeotab/apiReference/
    // objects/ChargeEvent), the charger's own reported signal - no heuristic.
    // Degrades gracefully (no badge) if chargeType is absent/"Unknown".
    function renderSessions(events) {
      if (!events.length) {
        elSessionsList.innerHTML = '<p class="evfd-muted" style="padding:14px 4px;">' + t("noSessionsFound") + '</p>';
        return;
      }
      var sorted = events.slice().sort(function (a, b) { return new Date(b.startTime) - new Date(a.startTime); });
      elSessionsList.innerHTML = sorted.map(function (ce) {
        var kwh = typeof ce.energyConsumedKwh === "number" ? ce.energyConsumedKwh.toFixed(1) + " kWh" : "-";
        var typeBadge = "";
        if (ce.chargeType === "AC" || ce.chargeType === "DC") {
          var isDc = ce.chargeType === "DC";
          typeBadge = ' &middot; <span style="color:var(--evfd-chg-' + (isDc ? "dc" : "ac") + ');font-weight:600;">' + (isDc ? t("dcFastCharging") : t("acCharging")) + '</span>';
        }
        return '<div class="evfd-session-row">' +
          '<div class="evfd-session-main">' +
            '<span class="evfd-session-time">' + escapeHtml(new Date(ce.startTime).toLocaleString()) + '</span>' +
            '<span class="evfd-session-meta">' + kwh + typeBadge + '</span>' +
          '</div>' +
          '<button class="evfd-session-localize-btn" data-session-localize data-start="' + escapeHtml(ce.startTime) + '">' + t("localize") + '</button>' +
        '</div>';
      }).join("");
    }

    // ChargeEvent has no GPS of its own (same gap as ExceptionEvent per
    // developers.geotab.com) - the documented fix is to look up LogRecord
    // for the device around the event's time instead. A vehicle doesn't
    // move while charging, so any fix in a short window after the start
    // time is representative; a real `duration`/end-time field on
    // ChargeEvent isn't confirmed, so this uses a fixed window rather than
    // trying to parse one.
    function localizeSession(btn, startIso) {
      var original = btn.textContent;
      if (!currentApi || !sessionsVehicle) {
        window.open("https://www.google.com/maps", "_blank", "noopener");
        return;
      }
      btn.textContent = t("locating");
      btn.disabled = true;
      var from = new Date(new Date(startIso).getTime() - 2 * 60000);
      var to = new Date(new Date(startIso).getTime() + 15 * 60000);
      currentApi.call("Get", {
        typeName: "LogRecord",
        search: { deviceSearch: { id: sessionsVehicle.deviceId }, fromDate: from.toISOString(), toDate: to.toISOString() }
      }, function (logs) {
        var rec = logs && logs[0];
        if (rec && rec.latitude != null && rec.longitude != null) {
          btn.textContent = original;
          btn.disabled = false;
          window.open("https://www.google.com/maps?q=" + rec.latitude + "," + rec.longitude, "_blank", "noopener");
        } else {
          btn.textContent = t("locationUnavailable");
        }
      }, function (err) {
        console.error("EV Fleet Dashboard: LogRecord lookup failed", err);
        btn.textContent = t("locationUnavailable");
      });
    }

    function render(model) {
      lastModel = model;
      renderKpis(model.vehicles, model.totalDeviceCount, model.totalChargedKwh, model.periodLabelKey, model.periodChargeEventCount, model.isLivePeriod, model.acChargedKwh, model.dcChargedKwh);
      renderComposition(model.vehicles, model.totalDeviceCount, model.totalChargedKwh, model.periodLabelKey);
      renderChargingStatus(model.vehicles);
      renderTable(model.vehicles);
      renderChargeCards(model.vehicles);
      renderAlerts(model.vehicles);
      renderOtherVehicles(model.otherVehicles);
    }

    function renderKpis(vehicles, totalDeviceCount, totalChargedKwh, periodLabelKey, periodChargeEventCount, isLivePeriod, acChargedKwh, dcChargedKwh) {
      var charging = vehicles.filter(function (v) { return v.chargeState !== 0; });
      var ac = charging.filter(function (v) { return v.chargeState === 1; }).length;
      var dc = charging.filter(function (v) { return v.chargeState === 2; }).length;
      var fleetTotal = totalDeviceCount || vehicles.length;
      var evPct = fleetTotal ? Math.round((vehicles.length / fleetTotal) * 100) : 0;

      var withCapacity = vehicles.filter(function (v) { return v.capacityKwh != null; });
      var currentKwhTotal = withCapacity.reduce(function (s, v) { return s + v.capacityKwh * (v.soc / 100); }, 0);
      var avgKwh = withCapacity.length ? currentKwhTotal / withCapacity.length : 0;

      var periodLabel = t(periodLabelKey);
      var chargedSub = periodLabel;
      if (periodChargeEventCount === 0) chargedSub += t("zeroChargeEventsFound");
      var chargedBreakdown = periodChargeEventCount
        ? '<div class="evfd-kpi-sub2">' + t("acDcKwhBreakdown", { ac: Math.round(acChargedKwh || 0), dc: Math.round(dcChargedKwh || 0) }) + '</div>'
        : "";
      var acDcSpec = '<div class="evfd-kpi-sub2">' + t("acDcSpec") + '</div>';
      var currentChargeValue = isLivePeriod ? (Math.round(currentKwhTotal) + " kWh") : "—";
      var currentChargeSub = isLivePeriod
        ? (withCapacity.length ? t("avgKwhEv", { avg: avgKwh.toFixed(1) }) : "")
        : t("currentChargeLiveOnly", { period: periodLabel });

      elKpis.innerHTML = [
        kpiCard(t("kpiTotalVehicles"), fleetTotal, "", "blue"),
        kpiCard(LEAF_ICON_SVG + t("kpiEvVehicles"), vehicles.length, evPct + t("ofFleet"), "green"),
        kpiCard(t("kpiChargingNow"), charging.length, t("acDcFast", { ac: ac, dc: dc }) + acDcSpec, charging.length ? "charge-active" : ""),
        kpiCard(t("kpiCurrentCharge"), currentChargeValue, currentChargeSub, "green"),
        kpiCard(t("kpiTotalCharged"), Math.round(totalChargedKwh || 0) + " kWh", chargedSub + chargedBreakdown)
      ].join("");
    }

    function renderComposition(vehicles, totalDeviceCount, totalChargedKwh, periodLabelKey) {
      var fleetTotal = totalDeviceCount || vehicles.length;
      var evCount = vehicles.length;
      var fossilCount = Math.max(fleetTotal - evCount, 0);
      var evPct = fleetTotal ? Math.round((evCount / fleetTotal) * 100) : 0;
      var fossilPct = fleetTotal ? 100 - evPct : 0;

      var kmAvoided = (totalChargedKwh || 0) * EV_KM_PER_KWH;
      var co2AvoidedKg = kmAvoided * ICE_CO2_G_PER_KM / 1000;

      elComposition.innerHTML =
        '<div class="evfd-comp-bar">' +
          '<span class="ev-seg" style="width:' + evPct + '%;"></span>' +
          '<span class="fossil-seg" style="width:' + fossilPct + '%;"></span>' +
        '</div>' +
        '<div class="evfd-comp-legend">' +
          '<div class="evfd-comp-legend-item"><span class="evfd-comp-swatch ev-seg"></span><span class="evfd-comp-legend-label">' + t("electric") + '</span><span class="evfd-comp-legend-value evfd-num">' + evCount + ' (' + evPct + '%)</span></div>' +
          '<div class="evfd-comp-legend-item"><span class="evfd-comp-swatch fossil-seg"></span><span class="evfd-comp-legend-label">' + t("fossilFuel") + '</span><span class="evfd-comp-legend-value evfd-num">' + fossilCount + ' (' + fossilPct + '%)</span></div>' +
        '</div>' +
        '<div class="evfd-emissions-row">' +
          '<span class="evfd-emissions-label">' + t("emissionsLabel", { period: t(periodLabelKey) }) + '</span>' +
          '<span class="evfd-emissions-value evfd-num">' + co2AvoidedKg.toFixed(0) + ' kg CO2</span>' +
        '</div>' +
        '<div class="evfd-emissions-note">' + t("emissionsNote", { km: Math.round(kmAvoided), gpkm: ICE_CO2_G_PER_KM }) + '</div>';
    }

    function statusCard(tone, icon, label, tooltip, count) {
      return '<div class="evfd-status-card ' + tone + '">' +
        '<div class="evfd-status-head">' +
          '<span class="evfd-status-icon">' + icon + '</span>' +
          '<span class="evfd-status-label">' + label + '</span>' +
          '<span class="evfd-status-info" title="' + escapeHtml(tooltip) + '">i</span>' +
        '</div>' +
        '<div class="evfd-status-body">' +
          '<span class="evfd-status-body-icon">' + icon + '</span>' +
          '<span class="evfd-status-stat"><span class="evfd-status-count evfd-num">' + count + '</span><span class="evfd-status-assets">' + t("assets") + '</span></span>' +
        '</div>' +
      '</div>';
    }

    // "Full"/"Low" are simple SoC thresholds, not a MyGeotab rule/compliance
    // object - see FULL_CHARGE_SOC_THRESHOLD / LOW_CHARGE_SOC_THRESHOLD above.
    function renderChargingStatus(vehicles) {
      var full = vehicles.filter(function (v) { return v.soc >= FULL_CHARGE_SOC_THRESHOLD; }).length;
      var low = vehicles.filter(function (v) { return v.soc <= LOW_CHARGE_SOC_THRESHOLD; }).length;
      var charging = vehicles.filter(function (v) { return v.chargeState !== 0; }).length;
      var notCharging = vehicles.length - charging;

      elChargingStatus.innerHTML =
        statusCard("full", STATUS_ICONS.full, t("fullCharge"), t("fullChargeTooltip", { pct: FULL_CHARGE_SOC_THRESHOLD }), full) +
        statusCard("low", STATUS_ICONS.low, t("lowCharge"), t("lowChargeTooltip", { pct: LOW_CHARGE_SOC_THRESHOLD }), low) +
        statusCard("charging", STATUS_ICONS.charging, t("charging"), t("chargingTooltip"), charging) +
        statusCard("idle", STATUS_ICONS.idle, t("notCharging"), t("notChargingTooltip"), notCharging);
    }

    function kpiCard(label, value, sub, tone) {
      return '<div class="evfd-kpi-card">' +
        '<div class="evfd-kpi-label">' + label + '</div>' +
        '<div class="evfd-kpi-value evfd-num' + (tone ? " " + tone : "") + '">' + value + '</div>' +
        (sub ? '<div class="evfd-kpi-sub">' + sub + '</div>' : '') +
        '</div>';
    }

    function renderTable(vehicles) {
      if (!vehicles.length) {
        elTableBody.innerHTML = '<tr><td colspan="11" class="evfd-loading-row">' + t("noEvsReporting", { h: LOOKBACK_HOURS }) + '</td></tr>';
        return;
      }
      elTableBody.innerHTML = vehicles
        .sort(function (a, b) { return a.soc - b.soc; })
        .map(function (v) {
          var status = statusFor(v);
          var meterColor = "var(--evfd-status-" + status + ")";
          var currentKwh = v.capacityKwh != null ? (v.capacityKwh * (v.soc / 100)).toFixed(1) : null;
          var chargeChip = v.chargeState === 0
            ? '<span class="evfd-chip evfd-chip-idle">' + t("chipNotCharging") + '</span>'
            : '<span class="evfd-chip" style="background:rgba(47,125,209,.15);color:var(--evfd-chg-' + (v.chargeState === 2 ? 'dc' : 'ac') + ');"><span class="evfd-cdot" style="background:var(--evfd-chg-' + (v.chargeState === 2 ? 'dc' : 'ac') + ');"></span>' + chargeStateLabel(v.chargeState) + '</span>';
          var vinCellId = "evfd-vin-" + v.id;

          return '<tr>' +
            '<td><span class="evfd-veh-id evfd-veh-link" data-open-device data-device-id="' + escapeHtml(v.id) + '" title="' + t("openVehicleAssetPage") + '">' + escapeHtml(v.name) + '</span></td>' +
            '<td>' + (v.licensePlate ? escapeHtml(v.licensePlate) : "-") + '</td>' +
            '<td id="' + vinCellId + '" class="evfd-vin-pending">' + (v.vin ? t("lookingUp") : "-") + '</td>' +
            '<td><div class="evfd-meter-cell"><div class="evfd-meter"><span style="width:' + v.soc + '%;background:' + meterColor + ';"></span></div><span class="evfd-meter-val evfd-num">' + v.soc + '%</span></div></td>' +
            '<td class="evfd-num">' + (currentKwh != null ? currentKwh + " kWh" : "-") + '</td>' +
            '<td class="evfd-num">' + (v.capacityKwh != null ? v.capacityKwh.toFixed(1) + " kWh" : "-") + '</td>' +
            '<td class="evfd-num">' + (v.sohPct != null ? v.sohPct + "%" : "-") + '</td>' +
            '<td class="evfd-num">' + (v.estRangeKm != null ? v.estRangeKm + " km" : "-") + '</td>' +
            '<td>' + chargeChip + '</td>' +
            '<td>' + timeAgo(v.lastReport) + '</td>' +
            '<td><div class="evfd-action-cell">' +
              '<button class="evfd-sessions-btn" data-sessions data-device-id="' + escapeHtml(v.id) + '" data-device-name="' + escapeHtml(v.name) + '">' + SESSIONS_ICON_SVG + t("chargingSessions") + '</button>' +
              '<button class="evfd-trips-btn" data-trips data-device-id="' + escapeHtml(v.id) + '">' + t("trips") + '</button>' +
              '<button class="evfd-localize-btn" data-localize data-device-id="' + escapeHtml(v.id) + '">' + t("localizeVehicle") + '</button>' +
              '</div></td>' +
            '</tr>';
        }).join("");

      vehicles.forEach(function (v) {
        if (!v.vin) return;
        decodeVin(v.vin, function (label) {
          var cell = document.getElementById("evfd-vin-" + v.id);
          if (!cell) return;
          cell.textContent = label || v.vin;
          cell.className = label ? "" : "evfd-vin-pending";
        });
      });
    }

    function renderOtherVehicles(otherVehicles) {
      if (!otherVehicles || !otherVehicles.length) {
        elOtherTableBody.innerHTML = '<tr><td colspan="9" class="evfd-loading-row">' + t("noFossilFound") + '</td></tr>';
        return;
      }
      elOtherTableBody.innerHTML = otherVehicles
        .sort(function (a, b) { return (a.fuelPct == null ? 101 : a.fuelPct) - (b.fuelPct == null ? 101 : b.fuelPct); })
        .map(function (v) {
          var fuelColor = v.fuelPct == null ? "var(--evfd-ink-400)"
            : v.fuelPct <= 15 ? "var(--evfd-status-critical)"
            : v.fuelPct <= 35 ? "var(--evfd-status-poor)"
            : "var(--evfd-status-good)";

          return '<tr>' +
            '<td><span class="evfd-veh-id evfd-veh-link" data-open-device data-device-id="' + escapeHtml(v.id) + '" title="' + t("openVehicleAssetPage") + '">' + escapeHtml(v.name) + '</span></td>' +
            '<td>' + (v.licensePlate ? escapeHtml(v.licensePlate) : "-") + '</td>' +
            '<td>' + (v.fuelPct != null
              ? '<div class="evfd-meter-cell"><div class="evfd-meter"><span style="width:' + v.fuelPct + '%;background:' + fuelColor + ';"></span></div><span class="evfd-meter-val evfd-num">' + v.fuelPct + '%</span></div>'
              : "-") + '</td>' +
            '<td class="evfd-num">' + (v.fuelEconomyKmPerL != null ? v.fuelEconomyKmPerL.toFixed(1) + " km/L" : "-") + '</td>' +
            '<td class="evfd-num">' + (v.odometerKm != null ? v.odometerKm.toLocaleString() + " km" : "-") + '</td>' +
            '<td class="evfd-num">' + (v.engineHours != null ? v.engineHours.toFixed(1) + " h" : "-") + '</td>' +
            '<td class="evfd-num">' + (v.emissionsIntensityGPerKm != null ? Math.round(v.emissionsIntensityGPerKm) + " g CO2/km" : "-") + '</td>' +
            '<td>' + (v.lastReport ? timeAgo(v.lastReport) : "-") + '</td>' +
            '<td><div class="evfd-action-cell">' +
              '<button class="evfd-trips-btn" data-trips data-device-id="' + escapeHtml(v.id) + '">' + t("trips") + '</button>' +
              '<button class="evfd-localize-btn" data-localize data-device-id="' + escapeHtml(v.id) + '">' + t("localizeVehicle") + '</button>' +
              '</div></td>' +
            '</tr>';
        }).join("");
    }

    function renderChargeCards(vehicles) {
      var charging = vehicles.filter(function (v) { return v.chargeState !== 0; });
      if (!charging.length) {
        elChargeCards.innerHTML = '<p class="evfd-muted" style="padding:0 2px;">' + t("noVehiclesCharging") + '</p>';
        return;
      }
      elChargeCards.innerHTML = charging.slice(0, 6).map(function (v) {
        var badge = v.chargeState === 2 ? '<span class="evfd-badge dc">' + t("dcFastBadge") + '</span>' : '<span class="evfd-badge ac">' + t("acLevel2Badge") + '</span>';
        // Time-to-full is a rough estimate: (remaining kWh) / (last observed
        // charge power). Real charge curves taper near 100% - treat as
        // indicative only, not a guarantee.
        var eta = "-";
        var ev = v.lastChargeEvent;
        if (v.capacityKwh && ev && ev.peakPowerKw) {
          var remainingKwh = v.capacityKwh * (1 - v.soc / 100);
          var hours = remainingKwh / ev.peakPowerKw;
          eta = hours < 1 ? Math.round(hours * 60) + "m" : hours.toFixed(1) + "h";
        }
        return '<div class="evfd-charge-card">' +
          '<div class="evfd-charge-top"><span class="evfd-veh-id">' + escapeHtml(v.name) + '</span>' + badge + '</div>' +
          '<div class="evfd-cbar"><span style="width:' + v.soc + '%;background:var(--evfd-chg-' + (v.chargeState === 2 ? 'dc' : 'ac') + ');"></span></div>' +
          '<div class="evfd-charge-meta"><span>' + v.soc + t("socLabel") + '</span><span>' + t("estToFull", { eta: eta }) + '</span></div>' +
          '</div>';
      }).join("");
    }

    function renderAlerts(vehicles) {
      var alerts = [];
      vehicles.forEach(function (v) {
        if (v.soc <= 15) alerts.push({ sev: "critical", title: t("lowSocAlertTitle", { name: v.name }), detail: v.estRangeKm != null ? t("lowSocAlertDetailRange", { soc: v.soc, range: v.estRangeKm }) : t("lowSocAlertDetail", { soc: v.soc }) });
        if (v.sohPct != null && v.sohPct < 80) alerts.push({ sev: "warn", title: t("batteryDegradingTitle", { name: v.name }), detail: t("batteryDegradingDetail", { pct: v.sohPct }) });
      });
      alerts = alerts.concat(ruleAlertsCache);

      elAlertCount.textContent = alerts.length;
      elAlertBadge.classList.toggle("is-clear", alerts.length === 0);

      if (!alerts.length) {
        elAlerts.innerHTML = '<p class="evfd-muted" style="padding:14px 18px;">' + t("noActiveAlerts") + '</p>';
        return;
      }
      elAlerts.innerHTML = alerts.map(function (a) {
        return '<div class="evfd-alert-item"><span class="evfd-alert-rail ' + a.sev + '"></span>' +
          '<div><div class="evfd-alert-title">' + escapeHtml(a.title) + '</div>' +
          '<div class="evfd-alert-detail">' + escapeHtml(a.detail) + '</div></div></div>';
      }).join("");
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function refresh(api) {
      if (!api) return;
      loadAndRender(api);
    }

    // Delegated on the (never-replaced) table body, not the rows themselves,
    // since renderTable()/renderOtherVehicles() rebuild row markup on every
    // refresh. Shared by both the EV and Other Vehicles tables.
    function bindRowActions(tbody) {
      tbody.addEventListener("click", function (e) {
        var sessionsBtn = e.target.closest("[data-sessions]");
        if (sessionsBtn) {
          openSessionsModal(sessionsBtn.getAttribute("data-device-id"), sessionsBtn.getAttribute("data-device-name"));
          return;
        }
        var localizeBtn = e.target.closest("[data-localize]");
        var tripsBtn = !localizeBtn && e.target.closest("[data-trips]");
        var vehLink = !localizeBtn && !tripsBtn && e.target.closest("[data-open-device]");
        if (!localizeBtn && !tripsBtn && !vehLink) return;
        var hash = localizeBtn
          ? "map,liveVehicleIds:!(" + localizeBtn.getAttribute("data-device-id") + ")"
          : tripsBtn
          ? "tripsHistory,devices:!(" + tripsBtn.getAttribute("data-device-id") + ")"
          : "device,id:" + vehLink.getAttribute("data-device-id");
        console.log("EV Fleet Dashboard: navigating to #" + hash);
        try {
          window.parent.location.hash = hash;
        } catch (err) {
          // Same-origin access to window.parent can throw if MyGeotab ever
          // sandboxes the Add-In iframe without allow-same-origin - surface
          // it loudly instead of a silent no-op click.
          console.error("EV Fleet Dashboard: couldn't set window.parent.location.hash", err);
        }
      });
    }

    return {
      initialize: function (api, state, callback) {
        currentApi = api;
        // Apply persisted language/theme before anything else renders, so
        // the static shell (labels, table headers, toolbar) is correct from
        // the very first paint.
        elLangToggle.setAttribute("data-active", currentLang);
        applyStaticI18n();
        elRoot.setAttribute("data-theme", getStoredTheme());
        elThemeToggle.setAttribute("aria-pressed", getStoredTheme() === "dark" ? "true" : "false");

        elRefreshBtn.addEventListener("click", function () { refresh(api); });
        if (elChargeMapBtn) elChargeMapBtn.addEventListener("click", function () {
          try {
            window.parent.location.hash = CHARGE_MAP_HASH;
          } catch (err) {
            if (CHARGE_MAP_URL) window.open(CHARGE_MAP_URL, "_blank", "noopener");
          }
        });
        bindRowActions(elTableBody);
        bindRowActions(elOtherTableBody);
        elAlertBadge.addEventListener("click", function (e) {
          e.stopPropagation();
          elAlertDropdown.hidden = !elAlertDropdown.hidden;
        });
        elManageRulesBtn.addEventListener("click", function () {
          console.log("EV Fleet Dashboard: navigating to #" + RULES_PAGE_HASH);
          try {
            window.parent.location.hash = RULES_PAGE_HASH;
          } catch (err) {
            console.error("EV Fleet Dashboard: couldn't set window.parent.location.hash", err);
          }
        });
        document.addEventListener("click", function (e) {
          if (!elAlertDropdown.hidden && !elAlertDropdown.contains(e.target) && e.target !== elAlertBadge) {
            elAlertDropdown.hidden = true;
          }
        });
        elPeriodSelect.addEventListener("change", function () {
          elCustomRange.hidden = elPeriodSelect.value !== "custom";
          if (elPeriodSelect.value !== "custom") refresh(api);
        });
        elCustomFrom.addEventListener("change", function () { if (elCustomFrom.value && elCustomTo.value) refresh(api); });
        elCustomTo.addEventListener("change", function () { if (elCustomFrom.value && elCustomTo.value) refresh(api); });

        elThemeToggle.addEventListener("click", function () {
          var next = elRoot.getAttribute("data-theme") === "dark" ? "light" : "dark";
          applyTheme(next);
        });
        elLangToggle.querySelectorAll(".evfd-lang-opt").forEach(function (btn) {
          btn.addEventListener("click", function () { changeLanguage(btn.getAttribute("data-lang")); });
        });

        elSessionsClose.addEventListener("click", closeSessionsModal);
        elSessionsOverlay.addEventListener("click", function (e) {
          if (e.target === elSessionsOverlay) closeSessionsModal();
        });
        elSessionsPeriod.addEventListener("change", function () {
          elSessionsCustomRange.hidden = elSessionsPeriod.value !== "custom";
          if (elSessionsPeriod.value !== "custom") loadSessions();
        });
        elSessionsCustomFrom.addEventListener("change", function () { if (elSessionsCustomFrom.value && elSessionsCustomTo.value) loadSessions(); });
        elSessionsCustomTo.addEventListener("change", function () { if (elSessionsCustomFrom.value && elSessionsCustomTo.value) loadSessions(); });
        elSessionsList.addEventListener("click", function (e) {
          var btn = e.target.closest("[data-session-localize]");
          if (!btn || btn.disabled) return;
          localizeSession(btn, btn.getAttribute("data-start"));
        });

        callback();
      },
      focus: function (api) {
        refresh(api);
      },
      blur: function () { /* no teardown needed */ }
    };
  };
})();
