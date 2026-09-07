# EV Fleet Dashboard — MyGeotab Add-In

A custom MyGeotab Add-In page that surfaces EV-specific fleet data: fleet
composition (EV vs. fossil fuel), estimated tailpipe emissions avoided,
state of charge, current/total charged kWh, battery health (state of
health), estimated range, live charging status, a fossil-fuel "Other
Vehicles" panel (fuel level, fuel economy, odometer, engine hours,
emissions intensity), and low-battery / degradation alerts. A toolbar
filter (Current Week / Last Week / Last Month / Custom Range) scopes the
"Total Charged" KPI (and the emissions estimate, which is derived from it)
to a chosen period. Vehicle names are clickable, linking to that vehicle's
MyGeotab asset page, and both vehicle tables have a bold "Trips" button
linking to that vehicle's trip history.

Alerts & Notifications is a red "Alerts" badge in the top-right corner of
the toolbar (exclamation mark, label, and live count), not a full panel —
clicking it opens a dropdown with the same detail as before. Moving it out
of a side column let the "EV Fleet Monitoring" (formerly "Battery Health
Monitoring") and "Other Vehicles" tables go full-width, so all their
columns are visible without side-scrolling on typical desktop widths
(tested scroll-free at 1200px+; narrower windows still get a horizontal
scrollbar as a fallback, which is expected for such wide tables).

Below Fleet Composition and above EV Fleet Monitoring, a "Charging Status"
row shows four cards - Full Charge, Low Charge, Charging, Not Charging -
each with an icon, an info tooltip explaining its threshold, and an asset
count. "Full"/"Low" are simple state-of-charge thresholds on the EV fleet
(`FULL_CHARGE_SOC_THRESHOLD` / `LOW_CHARGE_SOC_THRESHOLD` in `main.js`,
95%/20% by default) - not a MyGeotab "rule" or compliance object, since no
such entity is reachable from Add-Ins; adjust the thresholds to match your
fleet's own definitions if needed.

Color coding: Total Vehicles is blue; EV Vehicles, Current Charge, and the
Fleet Composition electric bar all share the same green; Charging Now
turns dark green only while at least one vehicle is actively charging,
otherwise it's the default ink color. The EV Fleet Monitoring panel itself
has a light green tint and the Other Vehicles panel a light grey tint, so
the two vehicle tables are visually distinct at a glance.

No external CDN script/stylesheet dependency (no Leaflet/map) — the only
remaining outbound network call from this Add-In is the VIN-decode `fetch`
to NHTSA's API (see Make/Model below). A map of currently-charging vehicles
(via `DeviceStatusInfo` + Leaflet, loaded from the unpkg CDN) was prototyped
and worked in isolated testing, but was pulled back out after intermittent
Add-In load failures on a live MyGeotab account, to reduce the number of
external dependencies while that's investigated.

## What's in this package

| File | Purpose |
|---|---|
| `config.json` | Add-In manifest — registers the page in MyGeotab's menu |
| `index.html` | Page markup |
| `style.css` | Styling (system fonts only, no external CDN) |
| `main.js` | Data loading (MyGeotab API) + rendering |
| `icon.svg` | Menu icon |

## Installing in a MyGeotab database

1. Sign in to MyGeotab as an Administrator.
2. Go to **Administration → System → System Settings → Add-Ins**.
3. Click **New Add-In**, choose **Existing configuration** (or **Custom**),
   and either:
   - paste the contents of `config.json` and point `url` at where you're
     hosting `index.html` (any HTTPS static host you control), **or**
   - zip this folder and use the **Upload Zip File** option, which embeds
     the files directly in `config.json`'s `files` map instead of hosting
     them externally. See Geotab's guide for the exact zip-upload workflow:
     https://developers.geotab.com/myGeotab/addIns/developingAddIns/
4. Save. The Add-In appears as **EV Fleet Dashboard** in the left-hand menu
   for users with access to the relevant security clearance.

## What's real vs. sample here

`main.js` calls the actual MyGeotab API objects and diagnostic IDs
documented at developers.geotab.com and support.geotab.com:

- `Device` — full vehicle roster (drives the "Total Vehicles" KPI, the
  fossil-fuel count: total minus reporting EVs, plus `licensePlate` and
  `vehicleIdentificationNumber` for the table's License Plate / Make-Model
  columns)
- **Make/Model** — not a `Device` field; MyGeotab only exposes it pre-decoded
  via the Data Connector's `LatestVehicleMetadata` feed, which isn't reachable
  from Add-Ins. Decoded client-side instead from the VIN via NHTSA's free,
  CORS-enabled vPIC API (`vpic.nhtsa.dot.gov`) — works for US-titled vehicles;
  non-US VINs may not resolve and just show the raw VIN.
- **Localize Vehicle** button — navigates to `#map,liveVehicleIds:!(id)`,
  MyGeotab's documented in-app map deep link.
- **Vehicle name** (first table column) — navigates to `#device,id:(id)`,
  MyGeotab's vehicle/asset detail page.
- **Est. tailpipe emissions avoided** (Fleet Composition panel) — a rough
  estimate: period kWh charged → equivalent EV km (via the same 5.5 km/kWh
  assumption as `estRangeKm`) → avoided CO₂ vs. an average ICE vehicle at
  ~192 g CO₂/km. Both factors are approximations (same as Geotab's own Green
  Fleet metrics use per-vehicle-class figures) — replace with real numbers
  for production use.
- `StatusData` with `DiagnosticStateOfChargeId` — current % state of charge
- `StatusData` with `DiagnosticElectricVehicleChargingStateId` — 0 = not
  charging, 1 = AC, 2 = DC fast charging
- `BatteryStateOfHealth` — `stateOfHealthMean`, `currentBatteryCapacityMeanKwh`
  (also used to derive each EV's current kWh: `capacityKwh × soc%`)
- `ChargeEvent` — historical charging sessions (`peakPowerKw` for charge-card
  ETA; `measuredEnergyConsumption` summed over the selected filter period for
  the "Total Charged" KPI)
- **Other Vehicles panel** — every device that ISN'T identified as an EV
  (no fresh state-of-charge reading), showing `StatusData` with
  `DiagnosticFuelLevelId` (%), `DiagnosticOdometerId` (meters ÷ 1000 for km),
  and `DiagnosticEngineHoursId` (seconds ÷ 3600 for hours) — all documented
  MyGeotab diagnostics, same Localize/asset-page/Trips links as the EV table.
- **Fuel Economy / Emissions Intensity** (Other Vehicles panel) — a
  BEST-EFFORT ESTIMATE, unlike the diagnostics above. Real fuel economy is
  normally only available pre-computed via the Data Connector
  (`VehicleKpi_Daily`'s `Distance_Km` / `TotalFuel_Litres`), which — like
  Make/Model — isn't reachable from Add-Ins. This approximates it instead
  from `Trip.distance` (km, documented) and the `FuelUsed` entity, summed
  over the last `LOOKBACK_HOURS`. **`FuelUsed`'s exact volume field name
  isn't documented anywhere consulted for this build** — `.litres` is an
  educated guess; confirm with `api.call("Get", { typeName: "FuelUsed", ... })`
  against your live database. Degrades gracefully to "-" if the guess is
  wrong, rather than breaking. The g CO₂/L conversion (`DIESEL_CO2_G_PER_LITRE`
  in `main.js`) assumes diesel — adjust for your fleet's actual fuel mix.
- **Trips button** (both tables) — navigates to
  `#tripsHistory,devices:!(id)`, MyGeotab's documented trip-history deep
  link. Styled as a solid/filled button so it's visually distinct from the
  outlined "Localize Vehicle" button next to it.

A vehicle is treated as an EV if it has reported a state-of-charge value in
the lookback window (`LOOKBACK_HOURS`, default 24h) — there's no universal
"is this an EV" flag on `Device` itself. The Current Week/Last Week/Last
Month/Custom Range filter only scopes the `ChargeEvent` query behind "Total
Charged" — live status (state of charge, charging now, current kWh) always
reflects the last `LOOKBACK_HOURS`.

**Before going live, verify against your own database:**

- Not every OEM/telematics device reports every diagnostic. Confirm which
  diagnostics your fleet actually supports with:
  `api.call("Get", { typeName: "Diagnostic", search: { searchText: "state of charge" } })`
- The estimated range (`estRangeKm`) uses a placeholder 5.5 km/kWh
  consumption figure — replace with your fleet's real efficiency, or with
  Geotab's `RangeEstimate` object if enabled on your database.
- "Est. time to full" on the charging cards is derived from
  `BatteryStateOfHealth.currentBatteryCapacityMeanKwh` and the last
  `ChargeEvent.peakPowerKw`, which is a rough approximation — real charge
  curves taper as they approach 100%.
- `BatteryStateOfHealth` and `ChargeEvent` are part of Geotab's EV reporting
  feature set and may need to be enabled for your database.
- `ChargeEvent.measuredEnergyConsumption` (used for the "Total Charged" KPI)
  is unverified against a live database in this codebase — confirm the field
  name with `api.call("GetEntity", { typeName: "ChargeEvent", id: "..." })`
  once you have real charge events to inspect.

## Logo

The Transscope Insight logo sits to the left of the title, drawn as plain
inline SVG (paths/shapes for the satellite mark, `<text>` for the
"TRANSSCOPE INSIGHT" wordmark) - the same technique already used for the
leaf icons elsewhere on the page. It is a stylized recreation of the
original artwork, not a traced/pixel-identical copy, since the original was
only ever supplied as a raster image.

**This replaced an earlier base64-PNG data-URI version** (`<img
src="data:image/png;base64,...">`) that rendered fine everywhere it was
tested locally but came through as a broken image once actually loaded
inside MyGeotab - while every other inline-styled element on the same page
rendered correctly. The working theory is that MyGeotab's config
save/serve pipeline doesn't reliably preserve one very long, unbroken
base64 attribute value, even though the JSON itself remains valid (no
save-time error). Inline SVG has no such attribute-length dependency, so it
sidesteps the problem entirely rather than working around it. If a raster
logo is ever wanted again, keep it in the **zip build only** (a normal
referenced file has no analogous risk there) rather than re-embedding it as
a data URI.

## Embedded JSON size

The embedded (`embedded-config.json`) build packs the entire page inline as
one string inside the config, unlike the zip build's separate files.
MyGeotab appears to reject an embedded config above a certain size with
"Het configuratieobject is niet geldig" / "The configuration object is not
valid" (this limit isn't documented anywhere consulted for this build).
Known data points from real testing against this account (total
`embedded-config.json` size):

| Version | Size | Result |
|---|---|---|
| v1.8.0 | 57,968 bytes | **Failed** |
| v1.9.0 | 45,931 bytes | **Worked** |
| v1.11.0 (added Charging Status + logo) | 53,771 bytes | **Failed** |
| v1.12.0 (deduplicated markup/JS, smaller logo) | 47,238 bytes | **Worked** |
| v1.13.0/v1.14.0 (SVG logo, bigger, left leaf removed) | 45,565–46,101 bytes | **Worked** |
| v2.0.0 (added dark mode + EN/NL translation) | 64,250 bytes | **Failed** |
| v2.1.0 (dark mode removed, translation kept) | 57,808 bytes | Not tried - predicted to fail (same range as other failures) |
| v2.2.0 (both dark mode and translation removed) | 46,774 bytes | **Worked** |
| v3.0.0 (added per-vehicle Charging Sessions modal) | 56,028 bytes | Not tried - predicted to fail (same range as other failures) |
| v3.1.0 (same feature, minified hard - see below) | 53,429 bytes | **Failed** |
| v2.3.0 (reverted to pre-sessions feature set + demo/mock content removed) | 43,523 bytes | Delivered - below every prior success, strong expectation it works |
| v3.2.0 (full Charging Sessions modal rebuilt on the demo-free v2.3.0 base) | 52,529 bytes | Delivered as a parallel experiment - untested at time of writing |
| v2.4.0 (Charging Sessions as a plain hyperlink button, no modal - see below) | 44,504 bytes | **Confirmed working** |
| v2.5.0 (period-filter refresh bug fix + Current Charge blanking + AC/DC spec captions - see below) | 44,996 bytes | Delivered |
| v2.6.0 (fixed "Total Charged" always 0 kWh + fleet-wide AC/DC kWh split - see below) | 45,502 bytes | Delivered |
| v2.7.0 (Rule-driven EV alerts + "Manage EV Alert Rules" link - see below) | 49,131 bytes | Delivered |
| v2.8.0 (confirmed Rules page hash: #rules - see below) | 48,880 bytes | Delivered |
| v2.8.1 (real supportEmail set: servicedesk@transscope.nl) | 48,874 bytes | Delivered |

**Conclusion from this round:** a full bilingual (EN/NL) translation layer
plus a working dark theme together add roughly 18-20KB - the translation
dictionary alone (every string duplicated for two languages) is the bigger
of the two costs. That's too much for the embedded build's size ceiling in
this account; only the **zip build** can carry both features at once
without risk, since it has no such limit. The embedded build can carry
*one* of the two (language OR dark mode, not both) if there's appetite to
rebuild a middle version later, but that's untested - go in expecting it
might still fail, given v2.1.0's language-only size sits in the same range
as configs that have already failed.

## v2.4.0: Charging Sessions as a hyperlink, not a modal

Requested directly, to shrink the embedded build's cost of this feature
close to zero: instead of a popup that calls the API for `ChargeEvent`
history, the embedded build's "Charging Sessions" button (EV table only,
before Trips - same as before) now just navigates straight to MyGeotab's
own **EV Charging** page, filtered to that one vehicle:

```
#evCharging,devices:!(<deviceId>)
```

Confirmed directly from the address bar while filtering that page to one
vehicle in a live MyGeotab session - same `devices:!(id)` list-wrapping
pattern already used by `#tripsHistory`. Date range is left for the user to
pick inside that MyGeotab page rather than pinned via the hash. "Localize
Vehicle" already hyperlinked straight to `#map,liveVehicleIds:!(id)` with no
popup, so point 3 of the request needed no change.

This reuses the exact same `bindRowActions` click-and-navigate plumbing
already wired up for Trips/Localize - no new API calls, no new modal
markup/CSS/JS. Cost: `page.html` grew from 41,427 to only 42,379 bytes
(+952 bytes) over the demo-free v2.3.0 base; total `embedded-config.json`
is 44,504 bytes - below every previously-confirmed-working size, with real
margin under the ~53.4KB failure line. Re-verified end-to-end in the
browser pane with a stand-in API object: the button renders only on EV
rows, clicking it sets `location.hash` to `evCharging,devices:!(<id>)` with
the correct device id, and Trips/Localize/vehicle-link navigation are all
unaffected - zero console errors.

The full API-driven modal (session-by-session kWh, AC/DC badge, per-session
Localize via `LogRecord`) remains in the **zip build only** (`main.js`), and
also still exists as the separate v3.2.0 experiment above for the embedded
build, in case the richer version is ever confirmed to fit.

**v2.4.0 confirmed working** (2026-09-03) at 44,504 bytes total config. One
false alarm along the way, worth recording: an initial "config object not
valid" report on this exact file turned out to be unrelated to its content
- macOS's Gatekeeper had quarantine-flagged the downloaded copy as
possible malware (a known false-positive pattern for text files carrying a
lot of inline-JS-looking content) and blocked/interfered with opening it
right as it was being copied, producing an incomplete paste into MyGeotab.
Clearing the quarantine attribute (`xattr -d com.apple.quarantine <file>`)
and re-copying the file fixed it with zero code changes. If "config not
valid" recurs on a file that was just downloaded/delivered, check for this
before assuming a size or content bug.

## v2.5.0: period-filter refresh bug + Current Charge clarity + AC/DC spec

Three issues reported together, all in the top toolbar's charging-period
filter (Current Week / Last Week / Last Month / Custom Range):

1. **Real bug, embedded build only**: `#evfdCustomRange` (the Custom Range
   date-picker pair) had `hidden` set alongside a static inline
   `style="display:flex;..."` - the same bug class caught earlier in the
   Charging Sessions modal (an inline `display` always overrides the
   `[hidden] { display:none }` UA default, since there's no `<style>` tag
   available in the embedded build to use an attribute selector like the
   zip build's `.evfd-custom-range[hidden]` rule does). Net effect: the
   date pickers were **always visible** regardless of which period was
   selected, so typing dates into them silently did nothing unless "Custom
   Range" also happened to be selected in the dropdown - exactly the
   "doesn't refresh" symptom reported. Fixed the same way as before:
   default the inline style to `display:none`, toggle
   `el.style.display` explicitly alongside `.hidden` in the period-select
   change handler.
2. **UX fix, both builds**: "Current Charge" is a live snapshot (state of
   charge right now) and was never actually tied to the period filter - so
   picking "Last Week" left it showing an unchanged live number next to a
   historical period, which read as the whole filter being broken even
   though "Total Charged" (the KPI that *is* period-scoped) was updating
   correctly underneath. "Current Charge" now shows "&mdash;" with a
   "live value - n/a for {period}" caption whenever the filter isn't
   "Current Week", instead of a misleading live number.
3. **Requested addition, both builds**: a small caption under "Charging
   Now"'s AC/DC split - "AC: up to 11 kW &middot; DC: over 11 kW" - so the
   AC/DC distinction shown there has a stated spec attached. Note this
   labels the *live* AC/DC counts (from the vehicle's own reported charge
   state, `DiagnosticElectricVehicleChargingStateId`), not the separate
   `peakPowerKw`-based best-effort heuristic used elsewhere (e.g. the zip
   build's per-vehicle AC/DC badge and est.-time-to-full calculation) -
   those two AC/DC signals are independent and can occasionally disagree
   for a given vehicle.

Re-verified end-to-end in the browser pane on both builds with a stand-in
API object returning distinguishable data per call: switching Current Week
-> Last Week -> Custom Range (with dates typed in) -> back to Current Week
correctly re-fetched and re-rendered every time (sync timestamp advancing,
"Total Charged" changing, "Current Charge" blanking/unblanking), zero
console errors, both languages checked in the zip build. `embedded/page.html`
grew 42,379 -> 42,849 bytes; total embedded config is now 44,996 bytes -
comfortably under the confirmed-working ceiling.

## v2.6.0: "Total Charged" was always 0 kWh - real root cause found

Reported directly: switching between Current Week/Last Week/Last Month/
Custom Range always showed 0 kWh charged, in both builds. The v2.5.0 fixes
above were real and necessary but didn't touch this - the actual cause was
a wrong field name, present since this KPI was first built:
`sumEnergyKwh()` read `ce.measuredEnergyConsumption`, a field that doesn't
exist on `ChargeEvent`. Every real event has it as `undefined`, so the sum
was always 0 regardless of period, hidden until now behind hand-built test
data that happened to use the same made-up field name.

Confirmed the real schema directly from developers.geotab.com/myGeotab/
apiReference/objects/ChargeEvent:
- **`energyConsumedKwh`** (Number, kWh) - the actual energy field. Fixed in
  both builds' `sumEnergyKwh()`.
- **`chargeType`** (String: `"AC"` / `"DC"` / `"Unknown"`) - the charger's
  own reported signal. This **replaces** the old `peakPowerKw > 22kW`
  best-effort guess used in the zip build's per-session modal badge -
  that heuristic is gone now that there's a real, documented field.
- `ChargeEvent` also has its own `location` (Coordinate: `x`=longitude,
  `y`=latitude) - contradicts the earlier assumption that it needed a
  `LogRecord` lookup for GPS (same doc gap incorrectly assumed as
  `ExceptionEvent`'s). The zip build's per-session Localize button still
  uses the `LogRecord` workaround for now; switching it to `ce.location`
  directly would be simpler and more accurate but hasn't been done yet.

Per the request that came with this bug report, "Total Charged" is now
also split by charge type: a caption under the total reads "{ac} kWh AC /
{dc} kWh DC" (an event with `chargeType: "Unknown"` counts toward the
total but not toward either half, so the two won't always add up to the
grand total - that's correct, not a bug). Demo mode's mock data was
updated to match the real field names/values so it stays consistent with
production behaviour.

Re-verified in the browser pane with hand-built ChargeEvent test data using
the *real* field names (previously the test data itself repeated the same
wrong field name as the bug, which is exactly why this went undetected
through every earlier round of testing) - confirmed AC/DC subtotals compute
and display correctly, zero console errors. `embedded/page.html` grew
42,849 -> 43,345 bytes; total embedded config is now 45,502 bytes.

## v2.7.0: Rule-driven EV alerts + "Manage EV Alert Rules" link

Requested directly: a button in the Alerts dropdown linking to MyGeotab's
Rules page, plus wiring so alerts from two specific customer-configured
Rules - "EV lage acculading" (low battery) and "EV klaar met laden"
(finished charging) - get "pushed" into the Alerts badge once the customer
creates them.

**Design decision made without asking** (flagging it here in case it's not
what's wanted): the built-in "Low state of charge <=15%"/"Battery health
<80%" alerts **stay** - the two new Rule-driven alerts are **added
alongside** them, not a replacement. Reasoning: if the customer hasn't
created the Rule yet, or ever renames/deletes it, replacing the built-in
check would silently go alert-blind on low SoC. Non-destructive felt safer
than assuming the two concepts are identical. Say the word if you'd rather
the Rule-based one replace the hardcoded 15% threshold once it's confirmed
working.

**How it works**: `Rule` is searched by name (`RuleSearch.name` with
`%wildcard%` matching, so "EV lage acculading (fleet)" still matches) to
resolve each rule's ID, then `ExceptionEvent` is queried by that rule ID
(`ruleSearch: { id }`) over the same `LOOKBACK_HOURS` window used for live
status. This is a **second, separate API round-trip** after the main
render - `ExceptionEvent` can only be searched by rule ID, not by name, so
the Rule lookup has to resolve first; the rest of the dashboard renders
immediately without waiting on it. If a Rule doesn't exist yet, its Get
call just returns an empty array (not an error) - the dashboard degrades
gracefully to "No active alerts" / built-in alerts only, with the "Manage
EV Alert Rules" link still available so the customer can go create it.

The exact two rule name strings are a constant near the top of each file
(`EV_ALERT_RULE_NAMES`) - edit them if the customer's actual Rule names in
MyGeotab differ from what's shown here.

**Known placeholder, same situation `#evCharging` was in before it got
checked directly**: `RULES_PAGE_HASH` currently points at the vehicle asset
page (`#device`) as a harmless fallback - there's no documented MyGeotab
hash for the Rules configuration page. Swap that one constant once the
real hash is confirmed by checking the browser URL while on Rules & Groups
-> Rules in MyGeotab.

Re-verified in the browser pane on both builds with hand-built `Rule` +
`ExceptionEvent` test data: alerts render with the correct rule name +
vehicle name + timestamp, the button correctly falls back to "no active
Rules yet" behaviour with zero errors when the Rule Get calls return empty,
and the link button navigates via the placeholder hash. `embedded/page.html`
grew 43,345 -> 46,859 bytes; total embedded config is now **49,131 bytes** -
still under the ~53.4KB confirmed-failure mark, but the safety margin is
down to about 4.3KB. Worth watching before adding much more to the embedded
build without re-measuring.

## v2.8.0: confirmed Rules page hash, deployment-readiness pass

The user checked their own address bar (`my.geotab.com/<database>/#rules`)
and confirmed the Rules configuration page is simply **`#rules`** - no
device/rule filter parameters, unlike the other hashes gathered so far.
`RULES_PAGE_HASH` in both builds is updated from the `#device` placeholder
to `"rules"` and re-verified in the browser pane (button click ->
`location.hash === "#rules"`, zero console errors).

Also did a deployment-readiness sweep of the embedded build per the user's
request to "make the JSON ready for deployment, removing old demo content,
stuff like that":
- **Demo/mock content**: already fully removed as of the v2.3.0 revert -
  re-confirmed with a fresh grep across `embedded/page.html` for
  `mock`/`demo`/`standalone`/`fictional`/`sample`/old fake vehicle names
  ("EV-0XX", "TRK-", "VAN-") - zero matches.
- **Leftover TODO/FIXME/PLACEHOLDER markers**: zero remaining after this
  fix - the `RULES_PAGE_HASH` placeholder above was the last one.
- **`supportEmail` in `embedded-config.json` (and the zip build's
  `config.json`) is still the generic placeholder
  `fleet-admin@yourcompany.example`** - flagged to the user rather than
  guessed at, since it's their call what real address should show as the
  Add-In's support contact in MyGeotab's admin listing. Not yet changed.
- The zip build's `config.json` `version` is also still `1.0.0` (never
  bumped, unlike the embedded config's version history above) - noted, not
  changed without being asked.

**v2.8.1**: `supportEmail` set to the user's real address,
`servicedesk@transscope.nl`, in both `embedded-config.json` and the zip
build's `config.json`. This was the only outstanding item from the
deployment-readiness pass above - the embedded build is now clean of
placeholders and demo content.

## Charging Sessions modal

A per-vehicle "Charging Sessions" button (EV table only, before Trips)
opens a popup listing that vehicle's `ChargeEvent` history with a
Today/This Week/Last Week/Custom filter, and a "Localize" button per
session. `ChargeEvent` has no GPS of its own - same documented gap as
`ExceptionEvent` - so Localize queries `LogRecord` for the device in a
window just after the session's `startTime` (the vehicle isn't moving
while charging, so any fix in that window is representative) and opens
`https://www.google.com/maps?q={lat},{lng}` in a new tab. AC vs. DC per
session is a best-effort estimate from `peakPowerKw` (>22kW = DC fast) -
`ChargeEvent`'s schema isn't documented anywhere consulted for this build,
so there's no confirmed field that flags charge type directly; confirm
against a live `GetEntity` call if precision matters.

This pushed the embedded build to 56,028 bytes - back in the range that's
already failed twice (53,771 and 57,968 bytes). It's shipped in the zip
build (no size limit, fully tested) - for the embedded build, it was cut
back down hard afterward (v3.1.0, see below) to give it a real shot.

**v3.1.0 hard-minification pass**, applied only to `embedded/page.html`
(the zip build keeps the full version - icon, AC/DC badge, custom date
range, error logging - since it has no size constraint):
- Removed the AC/DC type badge from each session row (best-effort-estimate
  value-add, not explicitly requested - cut first since it wasn't core).
- Dropped "Custom Range" from the sessions filter, keeping Today/This
  Week/Last Week - removes the date-input pair and its wiring entirely.
- Dropped the small icon on the "Charging Sessions" button and shortened
  its label to "Sessions".
- Removed `console.error(...)` debug logging from the two new API error
  handlers (functionally inert - the user-visible fallback text still
  shows either way).
- Stripped a leftover explanatory comment and two now-safe
  `box-sizing: border-box` declarations on wrapper elements that have no
  padding of their own (kept it everywhere it's structurally needed - flex
  children with both padding and a stretched width still have it).

Result: 50,952 bytes for `page.html`, 53,429 bytes total config - a real
~2.6KB cut, and for the first time below *both* prior failures (53,771 and
57,968), though still above the largest confirmed success (47,238). This
is **the most aggressively minified version that still keeps the feature
functional** - re-verified after every round of cuts (console-error-free
loads, correct button set per table, filter switching, close behavior,
Trips/Localize navigation all still work). There isn't a safe path to cut
much further without removing the feature outright.

**v3.1.0 was tried and failed.** Per the instruction above ("drop the
sessions modal from embedded entirely and keep it zip-only"), that's
exactly what happened next.

## v2.3.0: reverted to last-known-good + demo content removed

Two changes at once, both requested directly:

1. **Reverted `embedded/page.html`** to its pre-Charging-Sessions feature
   set (logo, Charging Status, wide tables, bigger Alerts badge - no dark
   mode/language toggle, no sessions modal). The Charging Sessions feature
   stays in the **zip build only**, where it has no size risk.
2. **Removed all demo/mock content** from the embedded build: the entire
   `mockModel()` fake fleet (the "EV-032"/"TRK-101"-style sample vehicles),
   the `DEMO_MODE_FALLBACK` flag and every branch that rendered fake data
   on an API error, and the `STANDALONE_PREVIEW` self-bootstrap block that
   used to auto-render sample data when opened outside MyGeotab. A tiny
   defensive stub (`if (typeof window.geotab === "undefined") { window.geotab
   = { addin: {} }; }`) stays so the script never throws if it's ever opened
   outside MyGeotab by accident, but nothing renders without a real host
   calling `initialize()` - no fictional vehicles anywhere, by design. (The
   zip build's `main.js` still has its own demo-mode fallback for local
   design review - harmless in production since it only ever fires when
   `api` is null, which never happens inside real MyGeotab - let me know if
   you'd like that stripped too for full consistency.)

Result: 41,427 bytes for `page.html`, 43,523 bytes total config - the
smallest this build has been since very early on, comfortably below every
previously-confirmed-working size. Re-verified end-to-end by manually
invoking `initialize()` with a stand-in API object (since there's no more
self-bootstrap to trigger a render automatically) - KPIs, both tables,
Charging Status, alerts, Trips/Localize navigation, and the alert dropdown
all confirmed working with zero console errors.

So the real ceiling sits somewhere between ~46KB and ~54KB — tighter than
first assumed. `embedded/page.html` is kept whitespace- and comment-stripped
(HTML comments, the JS header comment block, full-line `//` comments, all
lines dedented) AND deduplicated (the two table `<thead>`s are now
JS-rendered from a column-name array instead of ~20 repeated inline-styled
`<th>` tags; the Trips/Localize button cell and the vehicle-name-link cell
are each a single shared function called from both tables instead of two
copies; repeated `font-family`+`tabular-nums` style fragments share one
`NUM_STYLE` constant) — this cut v1.11.0's 53.8KB to v1.12.0's 47.2KB with
zero visual/behavioral change (re-verified via computed styles, click
navigation, and console-error-free loads for both tables). If you edit
`embedded/page.html` by hand and the Add-In starts failing to save again,
check its size first, and consider applying the same dedup pattern to any
new repeated markup before assuming a code bug. If v1.12.0 is confirmed
working, that narrows the ceiling to somewhere between 47.2KB and 53.8KB.

## v3.0.0: TCO-theme restyle + GitHub Pages hosting + demo mode removed

Three changes landed together to turn this zip build into the actual
production Add-In, hosted on GitHub Pages instead of zip-uploaded:

1. **Restyled to match the TCO / Cost Dashboard Add-In's "Atelier" theme** -
   same moss/brass color tokens (light + dark), same Hanken Grotesk + IBM
   Plex Mono + Inter font pairing (linked via Google Fonts in `index.html`),
   same button/card/table shapes and shadows. The KPI row now sits in TCO's
   signature dark "hero" band (stays dark in both themes, by design - see
   the comment above `--evfd-hero` in `style.css`). The language toggle
   changed from a flag-icon slider to TCO's plain "EN / NL" segmented
   buttons, and the dark-mode toggle changed from an iOS-style switch with a
   lightbulb glyph to a sun/moon icon swap - both purely CSS/markup changes;
   `main.js`'s `data-theme`/`data-lang` logic and every `getElementById`/
   `data-*` selector it relies on are untouched, so no functional risk.
   AC/DC colors now reuse TCO's own `--tco-ac`/`--tco-dc` equivalents
   directly. Verified in the browser pane: light/dark, EN/NL, all buttons
   and tables, zero console errors.
2. **Demo mode removed** (`DEMO_MODE_FALLBACK`, `STANDALONE_PREVIEW`
   self-bootstrap, `mockModel()`, `mockChargeEventsFor()`, the `"sample"`
   sync-state branch, and the now-dead `sampleDataApiUnavailable` i18n key
   all deleted) - now that this build is the real, publicly hosted
   Add-In rather than a local design-review copy, it should only ever
   render real MyGeotab data, same reasoning as the embedded build's
   v2.3.0 demo-removal above. Opening `index.html` directly now shows only
   the static "Connecting to MyGeotab…" shell and nothing renders until a
   real host calls `initialize()`/`focus()` - re-verified with a stand-in
   API object that it still renders correctly end-to-end.
3. **Hosted on GitHub Pages** at `EV-addin-2026` (same proven CORS-safe
   path already used for the TCO dashboard - see
   [[reference_geotab_addin_hosting]]) instead of MyGeotab's local zip
   upload, so the Add-In can be installed from a public HTTPS URL.

To preview locally: `python3 -m http.server 8000` from this folder, then
open `http://localhost:8000/index.html` - it will show the static shell
only, since demo mode is gone; use the browser console to inject a
stand-in `api` object and call `initialize`/`focus` to see it render (see
this file's git history / session notes for the exact snippet used to
verify each release).

## Sources

- Developing Add-Ins: https://developers.geotab.com/myGeotab/addIns/developingAddIns/
- Electric Vehicle Data Diagnostics and API User Guide: https://support.geotab.com/mygeotab/sdks/doc/ev-api-diagnostics
- Electric Vehicle Reporting and Monitoring User Guide: https://support.geotab.com/mygeotab/doc/ev-reporting
