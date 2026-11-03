# ISBOGI pilot

A working pilot of ISBOGI: a mobile web app that shows DONSAL van arrivals, seats and service alerts. It has four routes: **955 (CDO–Claveria, from the thesis)** and three invented test routes **956 (Manolo Fortich), 957 (Balingasag) and 958 (Laguindingan)** on real roads, added so the app can be tested with several routes. It also has a facilitator panel for running the evaluation scenarios.

**All vehicle data is simulated, and routes 956–958 are invented test routes, not confirmed with DONSAL.** Their numbers are not LTFRB route numbers. The app shows no "sample" labels on them; the permanent "Pilot · simulated data" bar and the About screen say it is a pilot, so **tell respondents in the consent briefing that the data and the extra routes are simulated.** Nothing reads real GPS. The stops, distances, fleet size, seat capacity, service hours and fares in `data/config.json` are placeholders until DONSAL and LTFRB confirm them.

## Run it

You need Node.js 18 or newer (`node -v` to check). There are no packages to install.

```bash
cd isbogi
npm start            # or: node server.js
```

The terminal prints:

- **Commuter app:** http://localhost:3000
- **Facilitator panel:** http://localhost:3000/admin.html
- **Phone link:** `http://<your-laptop-ip>:3000`. The phone must be on the same Wi-Fi.
- **Facilitator PIN:** a new random PIN each time. To fix it, run `ADMIN_PIN=246810 npm start`.

To change the port, run `PORT=8080 npm start`. Press Ctrl+C to stop the server.

> macOS may ask whether to allow incoming connections for `node`. Click Allow so phones on the Wi-Fi can connect.

## Running a test session

1. Start the server and open the facilitator panel on the laptop.
2. Open the commuter app on the respondent's phone using the Wi-Fi link.
3. In the panel, load a scenario (T1–T6) and give the task to the respondent. The scenarios run on route 955.
4. Use the fleet table to trigger events live (delay, breakdown, full van, signal loss).
5. Feedback sent from the app goes to `data/feedback.jsonl`. It also appears at the bottom of the panel, tagged with the scenario that was running.

| Scenario | Setup | Plan items |
| --- | --- | --- |
| T1 Next van | Agora at 7:07 AM; the boarding van leaves in 8 min with 4 seats left | PU1, PEOU2, PEOU3 |
| T2 Roadside wait | Next van is about 12 min from Villanueva (set the stop on the phone) | PU2, PU4, PEOU4 |
| T3 Breakdown | The van approaching Villanueva stops with engine trouble | PU3, ST1, ST3, NB3 |
| T4 Full van | Agora at 7:26 AM; the boarding van is full | PU5, ST2 |
| T5 Signal loss | The app gets no data for 90 s and shows the last update | PEOU1, PEOU8 |
| T6 Last trip | 6:40 PM; last departures of the day | Baseline worry about the last trip |

Every reset uses the same random seed, so a scenario starts the same way for each respondent. Clock speed (1×–30×) can be raised to fast-forward.

## What's in the app

| Screen | Where |
| --- | --- |
| Welcome and language choice | First visit |
| Departures board, stop-centred: where I wait (or locate me), routes at this stop with a route filter, next vans from every route and direction ("S2 · To Balingasag") with countdown, status and seats | Board tab |
| Trip detail: big countdown, seat map (green vacant / red taken), stop-by-stop timeline, next-van advice when delayed | Tap a van |
| Live map of all routes with a route filter: OpenStreetMap with the road route, stops and van pins (low-data mode or no tiles falls back to a list or the schematic map) | Map tab |
| Service status as a social-style feed: a stories row of routes (ring lights up when a route has unread posts; tap to filter), then posts newest first with important ones pinned. Each post has an author (ISBOGI Live for automatic van updates, DONSAL Operations for facilitator notices), a status label, a link preview of the van, and Read and Share actions. Filters All / Unread / My routes, Mark all as read, earlier posts (hide or clear), service hours per route. The nav badge counts unread posts. Read state is kept on the phone only | Alerts tab |
| Fare checker (sample rates), terminals with waiting-line level, luggage rules, feedback and lost items, settings, about | More tab |
| Transit Trivia | "Play while you wait" button |

These features follow the default choices in the plan doc. Each one can be swapped once the Part III survey results are in.

- **One colour legend everywhere:** green means many seats or on time, amber means few seats or delayed, and red means full or stopped. Colour always comes with an icon and a word.
- **English / Bisaya:** switch with the header toggle. Strings are in `public/js/i18n.js`. The Bisaya is a first draft, so have a native speaker review it.
- **Weak signal:** the app polls every 5 s (every 20 s in low-data mode) and keeps the last update on the phone. It counts down locally between polls, and after 30 s it warns that the data may be out of date.
- **Data freshness:** the "Updated … ago" indicator sits in the header strip on every screen and turns amber after 30 s without data.
- **Offline shell:** the service worker caches the app shell, but only on `localhost` or HTTPS. Phones on a Wi-Fi IP still get the last-update fallback.

## Files

```
server.js                 simulation engine + API + static server (no dependencies)
data/config.json          routes (stops, road path, fleet, hours), terminals, fares  ← edit placeholders here
data/feedback.jsonl       feedback received (created on first submission)
public/index.html         commuter app
public/js/app.js          commuter app logic
public/js/i18n.js         English and Bisaya text
public/vendor/leaflet/    Leaflet 1.9.4 (BSD-2), served locally; map pictures come from OpenStreetMap
public/css/app.css        design tokens and styles
public/css/admin.css      facilitator panel styles
public/js/theme.js        colour tokens, contrast maths and theme application (app and panel)
public/vendor/inter/      Inter font (OFL), served locally
public/admin.html         facilitator panel
public/js/admin.js        facilitator panel logic
public/sw.js              offline cache for the app shell
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/route` | Road path of every route for the map: `{ paths: { code: [[lat,lng],…] } }` (fetched once, cached on the phone) |
| GET | `/api/state` | Fleet, ETAs per stop, notices, service info. Returns 503 during simulated signal loss |
| POST | `/api/feedback` | `{ kind: trip\|lost\|idea, rating?, unit?, text, lang }` |
| GET / POST | `/api/admin/config` | Header `x-admin-pin`. Read or save the config (validated, backed up, simulation restarts only if the fleet changed) |
| POST | `/api/admin/reroute` | Header `x-admin-pin`. `{ code, recomputeKm }`: rebuild a route's road path via OSRM |
| GET | `/api/admin/geocode?q=` | Header `x-admin-pin`. Place search via Nominatim |
| POST | `/api/admin` | Header `x-admin-pin`. Actions: `delay`, `breakdown`, `resolve`, `setSeats`, `departNow`, `notice`, `clearNotice`, `clock`, `speed`, `blackout`, `scenario`, `reset` |
| GET | `/api/admin/feedback` | Header `x-admin-pin` |

## Location and other routes

- The locate button (Board card, stop picker, Map) finds the nearest stop in the chosen direction and shows a blue dot on the map. The location stays in memory on the phone; it is not saved or sent to the server. Browsers only share location on `https` pages or `localhost`, so a phone opening `http://<laptop-ip>:3000` will see a "pick your stop manually" message. Serve the pilot over https (for example through a tunnel) to enable it on phones.
- "Other routes at this stop" reads `connections` in `data/config.json`, keyed by stop id. The only entries are other operators' routes mapped in OpenStreetMap near Agora (not DONSAL, not live, unverified). DONSAL's own other routes are not in any source yet; add them there once DONSAL confirms them.

## Facilitator panel

Open `/admin.html` and enter the PIN. It has five sections:

| Section | What it does |
| --- | --- |
| Session | A live view of the whole fleet: KPI strip (vans on the road, on time, delayed, stopped, boarding, seats taken, notices), red/amber alerts for problem vans with a Locate button, a live map of every van, a filterable fleet list (route, status, find a van) and a live feed. The map, fleet list and a selected-van card are linked: pick a van in any of them and the others follow. The card shows where the van is, next stop, seats and lets you delay it, break it down, resolve it, set its seats, follow it on the map or open its trip in the app. Also posts notices (to all routes or one) |
| Map & routes | Live map of every route. Select a route to edit its name, colour, schedule and fleet. Drag the numbered stops, add stops by searching a place or clicking the map, add an existing place as a shared stop (that is how routes cross), reorder or remove stops, create or delete routes |
| Design | Edit the colour roles (primary, accent, ink, muted, good, caution, stop, neutral). Each shows its contrast ratio (4.5:1 or more passes). A phone beside it shows the real app and updates live |
| Content & data | Feature switches (fare checker, trivia), seats per van, sample fares, terminals (hours, contact number, which adds a Call button), other operators' routes, unverified places |
| Feedback | Read, refresh and export (CSV or JSON) feedback |

**Test controls (gear button, bottom right of every section).** Everything that sets up a test run is behind the gear so it is not on show while a respondent is looking: the simulated clock (shown and settable), speed (1×–30×), signal loss and restore, scenarios T1–T6 (they run on route 955) and Reset to live. A yellow dot on the gear means a scenario, speed or signal change is active. A red "Signal loss active" warning also stays in the top bar.

How saving works:

- Edits sit in a working copy. Respondents see nothing until you press **Save**. **Discard** drops the edits.
- Saving route, stop, schedule, fleet or seat changes **restarts the simulation** (vans return to their start positions). The panel asks first. Renaming, colours, content and theme changes do not restart it.
- Every save first copies the old `data/config.json` into `data/backups/` (the newest 10 are kept) and then writes the file, so a bad edit can be undone by copying a backup back.
- **Save & rebuild road** asks OpenStreetMap's OSRM service for the road through the stops (the server needs internet) and can recompute stop distances from it. After you drag or add stops the road line is shown dashed and flagged "out of date" until you rebuild it. New routes get their road built on save.
- Place search uses OpenStreetMap's Nominatim service, limited to one request a second.
- The panel does not edit the translated text in `public/js/i18n.js` or the luggage rules; change those in the file.

## Routes

- `data/config.json` holds a `routes` list. Each route has `code`, `name`, `sample`, `color`, `fleet.unitsPerDirection`, `fleet.platePrefix`, `service` (first and last departure, headway, speed), `stops` and a road `path`.
- A stop that appears in several routes uses the **same `id`** in each (for example `agora`, `bugo`). That is how the board knows which routes cross at a stop. `km` is the distance along that route; `pathIdx` points at the stop's nearest point on that route's `path`.
- Route 955 comes from the thesis. Routes 956–958 are built from real OpenStreetMap places and OSRM road geometry; their route numbers are made up. The `sample` flag on a route is an internal note for the team (the panel shows it as "Not confirmed with DONSAL"); respondents never see it. The vans of all routes share one DONSAL fleet numbering (DS-01 onward).
- Stop distances (`km`) for 955 are the original placeholders. Routes 956–958 use OSRM road distances (37.5, 48.8 and 30.9 km), which are estimates, not DONSAL figures.
- The fare checker still covers route 955 only.

## Map notes

- Map pictures are OpenStreetMap tiles, so the phone needs internet for the base map. Van pins and the route line are drawn locally; if tiles fail, a notice says so.
- Stop `lat`/`lng` and the road `path` in `data/config.json` came from OpenStreetMap place names and OSRM routing (about 42.5 km by road). They are **not** surveyed DONSAL stops or terminals. Replace with confirmed coordinates, then keep `pathIdx` pointing at each stop's nearest point on `path`.
- Stop `km` values still drive the simulation, and vans are placed on the road by their share of the way between stops.
- `unverifiedPlaces` in `data/config.json` lists three terminals found in OpenStreetMap (CDO Eastbound Bus Terminal, Balingoan Van Terminal, a UV Express terminal near Bugo). They show as dashed grey markers and under Terminals, labelled unverified. Nothing links them to DONSAL; confirm or remove them.
- OpenStreetMap's public tile server is meant for light use. For a public launch, use a tile provider or self-host tiles.

## Before testing with respondents

- [ ] Replace the placeholder stops, map coordinates, distances, seat count and hours in `data/config.json` with figures confirmed by DONSAL
- [ ] Replace sample fares or set `"fares": false` under `features` (see issue 4 in the plan)
- [ ] Have a native speaker review the Bisaya text
- [ ] Tell respondents in the consent briefing that the data is simulated
- [ ] Pilot with a few non-participant commuters first

## Privacy

The app has no accounts and stores no names. Feedback is saved with a timestamp, the language and the running scenario only. Do not commit `data/feedback.jsonl` to a public repository.
