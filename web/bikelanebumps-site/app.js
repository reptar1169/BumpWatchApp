// bikelanebumps.org — homepage
// Loads live ride/bump data from Firestore, renders it as a heatmap, and
// fills in the three headline stat tiles. Uses the Firebase modular (v9+)
// SDK straight from the CDN, no build step required.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collectionGroup,
  collection,
  getDocs,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAGAT9b57URau1ClR1P2a1AN7xoSpbQAgA",
  authDomain: "bikelanebumps.firebaseapp.com",
  projectId: "bikelanebumps",
  storageBucket: "bikelanebumps.appspot.com",
  messagingSenderId: "328681137448",
  appId: "1:328681137448:web:8cf5bf9cbc2c5986a85c1d",
  measurementId: "G-EPMBH9F426",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------------------------------------------------------------------------
// Chrome: footer year + mobile nav toggle
// ---------------------------------------------------------------------------

document.getElementById("year").textContent = new Date().getFullYear();

const navToggle = document.getElementById("navToggle");
const siteNav = document.getElementById("siteNav");
navToggle?.addEventListener("click", () => {
  const isOpen = siteNav.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(isOpen));
});

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const DEFAULT_CENTER = [39.5, -98.35]; // continental US; re-centers to your data below
const DEFAULT_ZOOM = 4;

const map = L.map("map", {
  scrollWheelZoom: false,
  preferCanvas: true, // faster rendering for the circle-marker layer as ride data grows
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

// scrollWheelZoom stays off until the map is clicked/focused -- otherwise a
// plain two-finger scroll while scrolling down the page would get captured
// by the map instead of scrolling past it.
map.on("focus", () => map.scrollWheelZoom.enable());
map.on("blur", () => map.scrollWheelZoom.disable());

// But a pinch gesture (trackpad) or ctrl/cmd+wheel is unambiguously a "zoom
// this" gesture, never a "scroll the page" one, so it shouldn't need a
// click first -- and critically, browsers report pinch as a wheel event
// with ctrlKey set, so leaving it unhandled while scrollWheelZoom is off
// doesn't just do nothing, it falls through to the browser's own page-zoom.
// Once the map is focused, Leaflet's own scrollWheelZoom handler already
// deals with this, so only step in while it's still off.
map.getContainer().addEventListener(
  "wheel",
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (map.scrollWheelZoom.enabled()) return;
    event.preventDefault();
    const zoomDelta = -event.deltaY * 0.01;
    map.setZoom(map.getZoom() + zoomDelta, { animate: false });
  },
  { passive: false }
);

// ---------------------------------------------------------------------------
// Full-screen toggle
// ---------------------------------------------------------------------------
// iPhone Safari doesn't support the Fullscreen API on arbitrary elements
// (only <video>), so feature-detect and just leave the button hidden there
// rather than showing something that silently does nothing.

const mapFrame = document.querySelector(".map-frame");
const fullscreenBtn = document.getElementById("mapFullscreenBtn");

if (fullscreenBtn && mapFrame?.requestFullscreen && document.exitFullscreen) {
  fullscreenBtn.hidden = false;

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement === mapFrame) {
      document.exitFullscreen();
    } else {
      mapFrame.requestFullscreen().catch((error) => {
        console.error("Couldn't enter full screen:", error);
      });
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const active = document.fullscreenElement === mapFrame;
    fullscreenBtn.classList.toggle("is-fullscreen", active);
    fullscreenBtn.setAttribute("aria-label", active ? "Exit full screen" : "View full screen");
    // Leaflet caches its container size; nudge it once the browser has
    // actually finished resizing the element to fill/leave the screen.
    setTimeout(() => map.invalidateSize(), 60);
  });
}

// If the visitor's browser will share a location, open the map centered on
// them instead of the zoomed-out US default -- most people care most about
// the bumps near them. This is opt-in via the browser's own permission
// prompt; if it's denied, times out, or isn't available (no HTTPS, no
// support, etc.), we just silently keep whatever view the data below ends
// up settling on. Runs independently of the Firestore load below and wins
// whenever it resolves, even if that's after the data-driven view below
// has already been set -- being on your own street beats seeing every bump
// ever recorded.

// A share link (see shareStretch/applyHighlightFromUrl further down) means
// the visitor followed a link to see one SPECIFIC stretch -- letting
// either this file's "center on my current location" or its "fit to
// every bump on record" initial view fight that would defeat the entire
// point of the link arriving already framed on it. Checked in both
// places that would otherwise override the highlight's own view.
function hasShareHighlight() {
  return new URLSearchParams(window.location.search).has("highlight");
}

let userLocated = false;

function centerOnVisitor() {
  if (!("geolocation" in navigator)) return;
  if (hasShareHighlight()) return; // let applyHighlightFromUrl's flyToStretch own the view instead

  navigator.geolocation.getCurrentPosition(
    (position) => {
      userLocated = true;
      map.flyTo([position.coords.latitude, position.coords.longitude], 13, {
        duration: 1.2,
      });
    },
    (error) => {
      console.info("Not centering on visitor location:", error.message);
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 }
  );
}

centerOnVisitor();

// Dark basemap (CARTO's "Dark Matter" tiles) to match the page. CARTO
// retired free anonymous basemap access in 2026 -- this now requires a free
// API key (see https://carto.com/basemaps/apikey/), passed as the `key`
// query param via Leaflet's {key} template substitution. The new tile
// service also dropped the old {s}.basemaps.cartocdn.com subdomain
// round-robin and {r} retina placeholder in favor of a single
// basemaps.cartocdn.com host under /rastertiles/<style>/.
L.tileLayer("https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key={key}", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  key: "cb1_2h86_1_255da47eac864d8940b5667c",
  maxZoom: 20,
}).addTo(map);

// Heat gradient — same warm ramp used for the legend bar and brand accent.
const HEAT_GRADIENT = {
  0.0: "#fff3c4",
  0.25: "#ffd873",
  0.5: "#ffab3d",
  0.75: "#ff6f3c",
  1.0: "#b0141c",
};

let heatLayer = null;
let markersLayer = null;
let cityDotsLayer = null;
let bikeLanesLayer = null;
let coverageLayer = null;

// The color ceiling used to be a hand-picked constant, which meant
// re-guessing it by hand every time BumpDetector.thresholdG changed on the
// Watch app -- and a single unusually hard hit (a unlucky curb, a real
// pothole) could still blow past a fixed number and wash every other bump
// out to the same uniform red. Deriving it from the data instead: the 95th
// percentile of whatever's actually on the map right now. That adapts
// automatically as real ride data comes in, and one-off extreme outliers
// just clip to full intensity instead of compressing everything else
// toward the low end of the gradient.
function intensityCeiling(magnitudes) {
  if (magnitudes.length === 0) return 3.0; // arbitrary fallback; map is empty anyway
  const sorted = [...magnitudes].sort((a, b) => a - b);
  const index = Math.floor(0.95 * (sorted.length - 1));
  return Math.max(sorted[index], 0.1); // guard against an all-zero/degenerate set
}

function magnitudeToIntensity(magnitudeG, ceiling) {
  return Math.max(0, Math.min(1, magnitudeG / ceiling));
}

// Same 5-stop gradient as the heat layer, reused as real RGB colors for
// marker fills so both rendering modes read as one consistent color
// language. Parsed from HEAT_GRADIENT rather than duplicated by hand, so
// there's one place to touch if the palette ever changes.
const HEAT_STOPS = Object.entries(HEAT_GRADIENT)
  .map(([stop, hex]) => ({ stop: parseFloat(stop), rgb: hexToRgb(hex) }))
  .sort((a, b) => a.stop - b.stop);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Generic stop-list interpolator -- pulled out of what used to be
// intensityToColor's own body so the ride-coverage layer's recency
// gradient below can reuse the exact same interpolation instead of a
// second hand-rolled copy.
function interpolateStops(stops, t) {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (clamped >= a.stop && clamped <= b.stop) {
      const localT = (clamped - a.stop) / (b.stop - a.stop);
      const [r1, g1, b1] = a.rgb;
      const [r2, g2, b2] = b.rgb;
      return `rgb(${Math.round(r1 + (r2 - r1) * localT)}, ${Math.round(
        g1 + (g2 - g1) * localT
      )}, ${Math.round(b1 + (b2 - b1) * localT)})`;
    }
  }
  const [r, g, b] = stops[stops.length - 1].rgb;
  return `rgb(${r}, ${g}, ${b})`;
}

function intensityToColor(intensity) {
  return interpolateStops(HEAT_STOPS, intensity);
}

// ---------------------------------------------------------------------------
// City dots <-> heatmap <-> markers switch
// ---------------------------------------------------------------------------
// Three ways of showing the same data, depending on how zoomed in you are:
//  - Zoomed out to roughly the whole country: leaflet.heat's blur/radius are
//    in screen pixels, so at this scale every city's whole cluster of bumps
//    collapses into just a couple of pixels -- the heat essentially
//    disappears. City-level dots (one per rough metro area) stay visible
//    no matter how far out you zoom.
//  - Zoomed to a city/region: the heat layer is the good overview.
//  - Zoomed in far enough to tell streets apart: clickable, magnitude-scaled
//    markers are more useful than either.
// All three layers are built once when the data loads; this just toggles
// which one is attached to the map based on current zoom.

const SWITCH_TO_CITY_DOTS_ZOOM = 7;
// Matches SHOW_BIKE_LANES_ZOOM/SHOW_COVERAGE_ZOOM below on purpose --
// lowered from 15 so individual markers show up at the same "neighborhood
// scale" zoom where street context (bike lanes, ride coverage) already
// does, instead of making a visitor zoom in past that just to get past
// the blurrier heat layer.
const SWITCH_TO_MARKERS_ZOOM = 13;
// Bike lanes are context, not one of the three interchangeable ways of
// showing bump data above -- it's shown *alongside* whichever of those is
// active, not swapped in exclusively. Zoomed out past city-dot level the
// lines would just be illegible clutter across the whole map, so it only
// comes in once you're roughly at neighborhood scale or closer.
const SHOW_BIKE_LANES_ZOOM = 13;
// Coverage cells are ~40m -- fine enough to trace a street, way too dense
// to show zoomed out past neighborhood scale. Same threshold as bike
// lanes on purpose: both are "which streets" context, meant to read
// together.
const SHOW_COVERAGE_ZOOM = 13;

function updateLayerForZoom() {
  const zoom = map.getZoom();

  if (heatLayer || markersLayer || cityDotsLayer) {
    const wantedLayer =
      zoom >= SWITCH_TO_MARKERS_ZOOM
        ? markersLayer
        : zoom < SWITCH_TO_CITY_DOTS_ZOOM
        ? cityDotsLayer
        : heatLayer;

    for (const layer of [heatLayer, markersLayer, cityDotsLayer]) {
      if (!layer) continue;
      const shouldShow = layer === wantedLayer;
      const isShown = map.hasLayer(layer);
      if (shouldShow && !isShown) layer.addTo(map);
      if (!shouldShow && isShown) map.removeLayer(layer);
    }
  }

  if (bikeLanesLayer) {
    const shouldShow = zoom >= SHOW_BIKE_LANES_ZOOM;
    const isShown = map.hasLayer(bikeLanesLayer);
    if (shouldShow && !isShown) bikeLanesLayer.addTo(map);
    if (!shouldShow && isShown) map.removeLayer(bikeLanesLayer);
  }

  if (coverageLayer) {
    const shouldShow = coverageEnabled && zoom >= SHOW_COVERAGE_ZOOM;
    const isShown = map.hasLayer(coverageLayer);
    if (shouldShow && !isShown) coverageLayer.addTo(map);
    if (!shouldShow && isShown) map.removeLayer(coverageLayer);
  }
}

map.on("zoomend", updateLayerForZoom);

function buildBumpMarker(bump, ceiling) {
  const intensity = magnitudeToIntensity(bump.magnitude, ceiling);
  const color = intensityToColor(intensity);
  const marker = L.circleMarker([bump.lat, bump.lng], {
    radius: 5 + intensity * 11, // 5px for the mildest bumps, 16px for the worst
    weight: 1.5,
    color: "rgba(20, 19, 17, 0.55)",
    fillColor: color,
    // Lowered from 0.85 -- at zoom >= SWITCH_TO_MARKERS_ZOOM these sit on
    // top of the ridden-path coverage layer (buildCoverageLine), and at
    // 0.85 a bump circle fully hid whatever coverage line ran underneath it.
    fillOpacity: 0.4,
  });
  marker.bindPopup(buildBumpPopupHtml(bump, color));
  return marker;
}

// 16-point compass, rounded to the nearest 22.5 degrees -- just enough
// precision to eyeball which way a rider was facing against the map
// underneath the marker (e.g. for judging which side of the street/which
// direction lane a bump belongs to), without cluttering the popup with a
// raw bearing that's harder to read at a glance.
const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

function compassLabel(headingDegrees) {
  const index = Math.round(headingDegrees / 22.5) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index];
}

function buildBumpPopupHtml(bump, magnitudeColor) {
  const dateLabel =
    bump.timestamp instanceof Date && !isNaN(bump.timestamp)
      ? bump.timestamp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : null;
  const speedLabel =
    typeof bump.speedMetersPerSecond === "number" && bump.speedMetersPerSecond >= 0
      ? `${(bump.speedMetersPerSecond * 2.23694).toFixed(1)} mph`
      : null;
  // -1 is CoreLocation's (and BumpEvent's) sentinel for "no confident
  // heading yet" -- NOT a real bearing -- so this must exclude it the same
  // way speedLabel excludes a negative speed above. Showing "heading: N
  // (0°)" for an unknown heading would be actively misleading, worse than
  // just omitting the row.
  const headingLabel =
    typeof bump.headingDegrees === "number" && bump.headingDegrees >= 0
      ? `${compassLabel(bump.headingDegrees)} (${Math.round(bump.headingDegrees)}\u00b0)`
      : null;

  const rows = [
    dateLabel,
    speedLabel ? `Speed: ${speedLabel}` : null,
    headingLabel ? `Heading: ${headingLabel}` : null,
    `${bump.lat.toFixed(5)}, ${bump.lng.toFixed(5)}`,
  ].filter(Boolean);

  return `
    <div class="bump-popup">
      <p class="bump-popup-mag" style="color: ${magnitudeColor}">${bump.magnitude.toFixed(2)}g</p>
      ${rows.map((row) => `<p class="bump-popup-row">${row}</p>`).join("")}
    </div>
  `;
}

// Rough metro-area grouping for the zoomed-out "city dots" view -- this
// isn't real geocoding, just a coordinate grid coarse enough (~0.2 degrees,
// on the order of a metro area) to merge one city's worth of rides into a
// single dot without merging two separate nearby cities together.
const CITY_CLUSTER_GRID_DEGREES = 0.2;

function buildCityClusters(bumps) {
  const clusters = new Map();

  for (const bump of bumps) {
    const key =
      Math.round(bump.lat / CITY_CLUSTER_GRID_DEGREES) +
      ":" +
      Math.round(bump.lng / CITY_CLUSTER_GRID_DEGREES);

    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { latSum: 0, lngSum: 0, magnitudeSum: 0, count: 0 };
      clusters.set(key, cluster);
    }
    cluster.latSum += bump.lat;
    cluster.lngSum += bump.lng;
    cluster.magnitudeSum += bump.magnitude;
    cluster.count += 1;
  }

  return [...clusters.values()].map((cluster) => ({
    lat: cluster.latSum / cluster.count,
    lng: cluster.lngSum / cluster.count,
    avgMagnitude: cluster.magnitudeSum / cluster.count,
    count: cluster.count,
  }));
}

function buildCityDotMarker(cluster, ceiling) {
  const intensity = magnitudeToIntensity(cluster.avgMagnitude, ceiling);
  const color = intensityToColor(intensity);
  // Radius scales with how many bumps this city has, log-scaled so one
  // heavily-ridden city doesn't dwarf every other dot on the country view.
  const radius = 6 + Math.min(14, Math.log2(cluster.count + 1) * 3);

  const marker = L.circleMarker([cluster.lat, cluster.lng], {
    radius,
    weight: 1.5,
    color: "rgba(20, 19, 17, 0.55)",
    fillColor: color,
    fillOpacity: 0.85,
  });

  marker.bindPopup(`
    <div class="bump-popup">
      <p class="bump-popup-mag" style="color: ${color}">${formatCount(cluster.count)} bumps</p>
      <p class="bump-popup-row">Avg severity: ${cluster.avgMagnitude.toFixed(2)}g</p>
    </div>
  `);

  return marker;
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

async function loadData() {
  const [bumpsSnap, ridesSnap] = await Promise.all([
    getDocs(collectionGroup(db, "bumps")),
    getDocs(collection(db, "rides")),
  ]);

  renderStats(bumpsSnap, ridesSnap);

  allBumps = parseAllBumps(bumpsSnap, ridesSnap);
  allRides = parseAllRides(ridesSnap);
  initMapFilters();
  // Respect a successful geolocation fix on this first load only -- every
  // later call goes through the filter handlers above, which always
  // pass fitView: true (see renderBumpLayers's comment on why). Also skip
  // it for a share-highlight visit, same reasoning as centerOnVisitor's
  // own guard above -- this fires from whichever of loadData/
  // loadTopStretches's independent Firestore reads happens to resolve
  // later, so without this it can just as easily be the one that steals
  // the view back from the highlighted stretch.
  applyMapFilters({ fitView: !userLocated && !hasShareHighlight() });
}

function renderStats(bumpsSnap, ridesSnap) {
  const bumpCountEl = document.getElementById("statBumps");
  const rideCountEl = document.getElementById("statRides");
  const worstEl = document.getElementById("statWorst");

  bumpCountEl.textContent = formatCount(bumpsSnap.size);
  rideCountEl.textContent = formatCount(ridesSnap.size);

  let worst = 0;
  bumpsSnap.forEach((doc) => {
    const magnitude = doc.data().magnitudeG;
    if (typeof magnitude === "number" && magnitude > worst) worst = magnitude;
  });
  worstEl.textContent = worst > 0 ? `${worst.toFixed(2)}g` : "—";
}

function formatCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// Keep in sync with functions/topStretchesCore.js's RECENCY_WINDOW_DAYS --
// that constant decides what counts as "current" for the priority
// stretches ranking, this one decides the same thing for the live map, and
// the two should always agree. 365 days spans a full riding season so a
// quiet off-season doesn't wrongly hide a still-bad stretch; see that
// file's comment for the full reasoning.
const DEFAULT_RANGE_PRESET = "12m"; // matches the old always-on recency
                                     // window this replaces -- see
                                     // functions/topStretchesCore.js's
                                     // RECENCY_WINDOW_DAYS comment for why
                                     // 12 months is the sensible default
                                     // (a full riding season, so a quiet
                                     // off-season doesn't make a still-bad
                                     // stretch look fixed). The server-side
                                     // ranking still always uses that fixed
                                     // window regardless of what a visitor
                                     // picks here -- this filter only
                                     // changes what the MAP shows.

// One-time parse of the raw Firestore snapshots into the flat shape the
// rest of this file works with. Runs once per page load (loadData calls
// this, then caches the result in allBumps below) -- everything the date
// filter does afterward re-filters this in-memory array, no refetching.
//
// A ride flagged excludedFromScoring (see functions/index.js's
// fetchAllBumpsForRecompute) is left out here, permanently, independent of
// whatever date range gets picked -- that flag means "this ride's data is
// known-stale, don't show it at all," which a date filter shouldn't be
// able to override by picking a range that happens to include it.
function parseAllBumps(bumpsSnap, ridesSnap) {
  const excludedRideIds = new Set(
    ridesSnap.docs
      .filter((doc) => doc.data().excludedFromScoring === true)
      .map((doc) => doc.id)
  );

  const bumps = [];
  bumpsSnap.forEach((doc) => {
    if (excludedRideIds.has(doc.ref.parent.parent.id)) return;
    const bump = doc.data();
    if (typeof bump.latitude !== "number" || typeof bump.longitude !== "number") return;
    bumps.push({
      lat: bump.latitude,
      lng: bump.longitude,
      magnitude: typeof bump.magnitudeG === "number" ? bump.magnitudeG : 0,
      timestamp: typeof bump.timestamp?.toDate === "function" ? bump.timestamp.toDate() : null,
      speedMetersPerSecond:
        typeof bump.speedMetersPerSecond === "number" ? bump.speedMetersPerSecond : null,
      headingDegrees:
        typeof bump.headingDegrees === "number" ? bump.headingDegrees : null,
    });
  });
  return bumps;
}

let allBumps = []; // full parsed set (post-exclusion, pre-filter) --
                    // populated once by loadData(), re-filtered by
                    // applyMapFilters() below on every filter change.

// The bump map only ever shows where a BUMP happened -- it has no idea
// where a ride happened with zero bumps, because BumpWatch only ever
// records a lat/lng at the moment of a bump, never a continuous track of
// the ride itself (see RideManager.recordBump on both watch apps). That
// means an empty patch of map is genuinely ambiguous: it could be a
// smooth, well-ridden street, or it could be a street nobody has ridden
// in the selected window at all -- the data looks identical either way.
//
// This doesn't fix that ambiguity (fixing it for real needs the watch
// apps to log a periodic route track, not just bump events -- a real
// project, not a map tweak). What it DOES do is give a citywide signal a
// viewer can sanity-check against: how many rides were even recorded in
// the selected window. Zero rides recorded anywhere in range is a strong
// hint that "no bumps shown" means "no data," not "no bumps." It can't
// tell you that for one specific quiet street with rides elsewhere in the
// same window, though -- see the caveat text in index.html next to the
// filter controls.
function parseAllRides(ridesSnap) {
  const rides = [];
  ridesSnap.forEach((doc) => {
    const data = doc.data();
    if (data.excludedFromScoring === true) return; // same override as bumps
    const startMs = typeof data.startTime?.toDate === "function" ? data.startTime.toDate().getTime() : null;
    if (startMs === null) return;
    // routePoints (see functions/index.js's submitRide) already had its
    // privacy trim applied server-side before this ever reached Firestore
    // -- nothing further to do with it here except read it.
    const routePoints = Array.isArray(data.routePoints)
      ? data.routePoints.filter(
          (p) => p && typeof p.latitude === "number" && typeof p.longitude === "number"
        )
      : [];
    rides.push({ id: doc.id, startMs, routePoints });
  });
  return rides;
}

let allRides = []; // populated once by loadData(), alongside allBumps.

function ridesWithinRange(fromMs, toMs) {
  if (fromMs === null && toMs === null) return allRides;
  return allRides.filter((ride) => {
    if (fromMs !== null && ride.startMs < fromMs) return false;
    if (toMs !== null && ride.startMs > toMs) return false;
    return true;
  });
}

function countRidesInRange(fromMs, toMs) {
  return ridesWithinRange(fromMs, toMs).length;
}

// ---------------------------------------------------------------------------
// Map filters -- date range and severity
// ---------------------------------------------------------------------------
// Date range lets a visitor (e.g. a city official wanting to show
// before/after repave progress) narrow the map to a specific window
// instead of the default "last 12 months." Presets cover the common
// cases; "Custom range" reveals two plain date inputs for anything else,
// including picking an OLDER window to see what a street used to look
// like.
//
// Severity is deliberately NOT fixed g-value buckets ("0.5g+", "1.0g+")
// -- same reasoning as intensityCeiling() above: BumpDetector.thresholdG
// on the Watch app is still being tuned, so a hardcoded number here would
// either filter out nothing (sits below the detection floor) or go stale
// the next time that threshold changes. Percentile-relative options
// ("worst 10%") stay meaningful no matter where the floor sits, and are
// computed fresh from whatever's actually in the selected date range --
// see resolveSeverityThreshold() below.

const rangePresetEl = document.getElementById("mapRangePreset");
const customRangeEl = document.getElementById("mapCustomRange");
const dateFromEl = document.getElementById("mapDateFrom");
const dateToEl = document.getElementById("mapDateTo");
const rangeApplyBtn = document.getElementById("mapRangeApply");
const rangeSummaryEl = document.getElementById("mapFilterSummary");
const coverageToggleEl = document.getElementById("mapCoverageToggle");
const severityFilterEl = document.getElementById("mapSeverityFilter");

// On by default (see the ride-coverage scoping doc) -- this is the fix for
// the exact ambiguity a quiet, unridden street shares with a quiet, smooth
// one, so it stays visible unless someone deliberately turns it off.
let coverageEnabled = true;

function isoDate(date) {
  return date.toISOString().slice(0, 10); // yyyy-mm-dd, what <input type=date> wants
}

// Resolves the active preset (or the custom inputs) to a concrete
// [fromMs, toMs] window. "all" and an empty custom side are unbounded
// (null), so a bump with no usable timestamp -- old data predating the
// field, see the isWithinRecencyWindow comment in topStretchesCore.js --
// is only ever shown under "All time," never inside a specific window we
// can't actually confirm it falls in.
function resolveRange() {
  const preset = rangePresetEl.value;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  if (preset === "custom") {
    const fromMs = dateFromEl.value ? new Date(`${dateFromEl.value}T00:00:00`).getTime() : null;
    const toMs = dateToEl.value ? new Date(`${dateToEl.value}T23:59:59.999`).getTime() : null;
    return { fromMs, toMs };
  }
  if (preset === "all") return { fromMs: null, toMs: null };

  const days = { "90d": 90, "6m": 182, "12m": 365 }[preset] ?? 365;
  return { fromMs: now - days * DAY_MS, toMs: null };
}

function initMapFilters() {
  const today = new Date();
  const twelveMonthsAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
  dateFromEl.value = isoDate(twelveMonthsAgo);
  dateToEl.value = isoDate(today);

  rangePresetEl.value = DEFAULT_RANGE_PRESET;
  rangePresetEl.addEventListener("change", () => {
    customRangeEl.hidden = rangePresetEl.value !== "custom";
    if (rangePresetEl.value !== "custom") applyMapFilters({ fitView: true });
  });
  rangeApplyBtn.addEventListener("click", () => applyMapFilters({ fitView: true }));

  severityFilterEl.value = "all";
  // fitView: false, unlike the date-range handlers above -- re-narrowing
  // to a severity tier shouldn't yank the view to wherever those bumps
  // happen to be. A visitor picking "Worst 5%" is filtering what's
  // already on screen, not asking to be flown somewhere else.
  severityFilterEl.addEventListener("change", () => applyMapFilters({ fitView: false }));

  coverageToggleEl.checked = coverageEnabled;
  coverageToggleEl.addEventListener("change", () => {
    coverageEnabled = coverageToggleEl.checked;
    updateLayerForZoom(); // just a visibility flip -- the layer itself doesn't need rebuilding
  });
}

// "Above average" -> the mean magnitude of whatever's in the date-filtered
// set; "worst 10%/5%" -> that set's own 90th/95th percentile, same
// percentile-of-what's-currently-shown approach as intensityCeiling()
// above. Scoped to dateFiltered (not the full allBumps) so picking "worst
// 10%" means worst 10% of what the date range actually shows, not skewed
// by bumps outside it.
function resolveSeverityThreshold(dateFiltered) {
  const mode = severityFilterEl.value;
  if (mode === "all" || dateFiltered.length === 0) return 0;

  const magnitudes = dateFiltered.map((b) => b.magnitude).sort((a, b) => a - b);
  if (mode === "above-avg") {
    return magnitudes.reduce((sum, m) => sum + m, 0) / magnitudes.length;
  }
  const percentile = mode === "worst5" ? 0.95 : 0.9; // "worst10" is the fallback
  const index = Math.floor(percentile * (magnitudes.length - 1));
  return magnitudes[index];
}

const SEVERITY_SUMMARY_LABELS = {
  all: "",
  "above-avg": " above average severity",
  worst10: " in the worst 10% by severity",
  worst5: " in the worst 5% by severity",
};

function applyMapFilters({ fitView }) {
  const { fromMs, toMs } = resolveRange();

  const dateFiltered = allBumps.filter((bump) => {
    if (fromMs === null && toMs === null) return true; // "All time"
    const ts = bump.timestamp instanceof Date && !isNaN(bump.timestamp) ? bump.timestamp.getTime() : null;
    if (ts === null) return false; // can't confirm it falls in a bounded window
    if (fromMs !== null && ts < fromMs) return false;
    if (toMs !== null && ts > toMs) return false;
    return true;
  });

  const severityThreshold = resolveSeverityThreshold(dateFiltered);
  const filtered = dateFiltered.filter((bump) => bump.magnitude >= severityThreshold);

  const ridesInRange = ridesWithinRange(fromMs, toMs);

  renderFilterSummary(filtered, ridesInRange.length);
  renderBumpLayers(filtered, { fitView, rideCount: ridesInRange.length });
  renderCoverageLayer(ridesInRange);
}

function renderFilterSummary(filtered, rideCount) {
  const rideWord = rideCount === 1 ? "ride" : "rides";
  if (rideCount === 0) {
    rangeSummaryEl.textContent = "No rides recorded in this range at all — an empty map means no data, not smooth roads.";
    return;
  }
  const severityLabel = SEVERITY_SUMMARY_LABELS[severityFilterEl.value] ?? "";
  if (filtered.length === 0) {
    rangeSummaryEl.textContent = `${formatCount(rideCount)} ${rideWord} recorded, 0 bumps${severityLabel} in this range.`;
    return;
  }
  const worst = Math.max(...filtered.map((b) => b.magnitude));
  rangeSummaryEl.textContent =
    `${formatCount(filtered.length)} bumps${severityLabel} across ${formatCount(rideCount)} ${rideWord} in this range · worst ${worst.toFixed(2)}g`;
}

// Builds (or rebuilds) the heat/markers/city-dot layers from a bump list --
// called both on initial load and every time a map filter changes, so
// any previously-attached layers are torn down first rather than piling up.
function renderBumpLayers(bumps, { fitView, rideCount }) {
  for (const layer of [heatLayer, markersLayer, cityDotsLayer]) {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  }
  heatLayer = null;
  markersLayer = null;
  cityDotsLayer = null;

  const emptyState = document.getElementById("mapEmpty");

  if (bumps.length === 0) {
    // Same "no data" vs "no bumps" distinction as renderFilterSummary above
    // -- but here it's the message sitting directly on the empty map, so a
    // viewer who skipped the smaller filter-summary text still sees it.
    if (allRides.length === 0) {
      // Nothing has ever been recorded, in any range -- the site's
      // original bootstrap message, not the date-filter-specific one.
      emptyState.textContent =
        "No bumps recorded yet — be the first to ride and put your street on the map.";
    } else if (rideCount === 0) {
      emptyState.textContent =
        "No rides recorded in this date range — this means no data, not necessarily smooth roads. Try a wider range.";
    } else {
      emptyState.textContent =
        `${formatCount(rideCount)} ride${rideCount === 1 ? "" : "s"} recorded in this range with zero bumps logged — nice and smooth.`;
    }
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;

  const ceiling = intensityCeiling(bumps.map((b) => b.magnitude));
  const points = bumps.map((b) => [b.lat, b.lng, magnitudeToIntensity(b.magnitude, ceiling)]);
  const bounds = bumps.map((b) => [b.lat, b.lng]);

  heatLayer = L.heatLayer(points, {
    radius: 18,
    blur: 20,
    maxZoom: 17,
    gradient: HEAT_GRADIENT,
  });

  markersLayer = L.layerGroup(bumps.map((b) => buildBumpMarker(b, ceiling)));

  const cityClusters = buildCityClusters(bumps);
  cityDotsLayer = L.layerGroup(cityClusters.map((cluster) => buildCityDotMarker(cluster, ceiling)));

  // Attach whichever layer matches the current zoom -- most likely the
  // heat layer at this point, but respect wherever the map actually is
  // (e.g. a geolocation fix that already zoomed in past the switch point).
  updateLayerForZoom();

  // Don't fight a successful geolocation fix on the very first load --
  // fitView is false there when it succeeded. The date-range handlers pass
  // fitView: true on every later call, since re-framing around whatever
  // window was just picked is the whole point of changing it. The
  // severity handler passes false instead -- narrowing to a severity tier
  // filters what's already in view rather than asking to go look
  // somewhere else, so the map should hold its position.
  if (fitView) {
    if (bounds.length === 1) {
      map.setView(bounds[0], 14);
    } else {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
  }

  // setView/fitBounds above may or may not actually change the zoom level
  // (and therefore may or may not fire "zoomend"), so double check once
  // more after the view settles.
  updateLayerForZoom();
}

// ---------------------------------------------------------------------------
// Ride coverage layer
// ---------------------------------------------------------------------------
// Shows which streets have actually been RIDDEN, not just where a bump
// happened -- see functions/index.js's routePoints and the ride-coverage
// scoping doc this implements.
//
// Draws each ride's own (already-trimmed) route as its own polyline,
// rather than aggregating into a grid first. An earlier version connected
// adjacent cells of a 40m grid instead, specifically so the layer read as
// "this street has coverage" rather than "this is rider X's GPS trace" --
// but in practice, any street with GPS wobble or more than one ride
// touching it produced a criss-crossing web of diagonals between cells
// instead of a clean line (the grid has no notion of which neighbor
// continues the route vs. which is just an adjacent, unrelated pass), so
// it read as noisier and less accurate than the real thing. Privacy here
// was never actually resting on the grid aggregation anyway -- it rests
// entirely on the 150m endpoint trim already applied server-side (see
// ROUTE_ENDPOINT_TRIM_METERS in functions/index.js), which applies just
// the same to a raw per-ride line as it did to the grid built from those
// same trimmed points. So: real route shape, same underlying privacy
// guarantee.

// Fresh (ridden very recently) toward faded (ridden toward the edge of a
// year ago or beyond). Purple on purpose -- it used to reuse the site's
// "protected path" teal (--lane-track), but that read as too close to the
// teal/cyan bike-lane infrastructure lines and painted-lane color, making
// it hard to tell "ridden" apart from "lane type" at a glance. Purple isn't
// used anywhere else on the map (bump severity is the yellow/orange/red
// heat scale, lanes are teal/cyan), so it reads as its own distinct layer.
// Keep this in sync with --coverage-ridden in styles.css, used for the
// matching legend swatch.
const COVERAGE_GRADIENT = { 0.0: "#2a1f47", 1.0: "#b18cff" };
const COVERAGE_STOPS = Object.entries(COVERAGE_GRADIENT)
  .map(([stop, hex]) => ({ stop: parseFloat(stop), rgb: hexToRgb(hex) }))
  .sort((a, b) => a.stop - b.stop);

function coverageFreshnessToColor(freshness) {
  return interpolateStops(COVERAGE_STOPS, freshness);
}

function msFreshness(ms) {
  const ageDays = (Date.now() - ms) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.min(1, 1 - ageDays / 365));
}

// A ride with 0 or 1 points (everything trimmed away, or a GPS dropout)
// can't form a line -- skip it rather than let Leaflet choke on it.
function buildCoverageLine(ride) {
  if (ride.routePoints.length < 2) return null;

  const color = coverageFreshnessToColor(msFreshness(ride.startMs));
  const latlngs = ride.routePoints.map((p) => [p.latitude, p.longitude]);
  const line = L.polyline(latlngs, { color, weight: 3, opacity: 0.75, lineCap: "round", lineJoin: "round" });

  const dateLabel = new Date(ride.startMs).toLocaleDateString(undefined, { dateStyle: "medium" });
  line.bindPopup(`
    <div class="bump-popup">
      <p class="bump-popup-mag" style="color: ${color}">Ridden</p>
      <p class="bump-popup-row">${dateLabel}</p>
    </div>
  `);
  return line;
}

// Rebuilds the coverage layer for a given (already date-filtered) ride
// list -- called from applyMapFilters alongside the bump layers, so both
// always describe the same window.
function renderCoverageLayer(rides) {
  if (coverageLayer && map.hasLayer(coverageLayer)) map.removeLayer(coverageLayer);

  coverageLayer = L.layerGroup(rides.map(buildCoverageLine).filter(Boolean));
  updateLayerForZoom();
}

loadData().catch((error) => {
  console.error("Failed to load ride data:", error);
  document.getElementById("mapEmpty").hidden = false;
  document.getElementById("mapEmpty").textContent =
    "Couldn't load ride data right now — try refreshing in a bit.";
});

// ---------------------------------------------------------------------------
// Priority stretches
// ---------------------------------------------------------------------------
// Reads the static top-stretches.json (see scripts/generate-top-stretches.mjs)
// rather than querying Firestore directly -- "stretch" isn't a concept that
// exists in the bump data itself, it's a clustering/scoring/geocoding result
// computed offline and periodically refreshed by rerunning that script, not
// something worth recomputing client-side on every page load.

let highlightLayer = null;

function flyToStretch(stretch, itemEl) {
  const bounds = [
    [stretch.bounds.south, stretch.bounds.west],
    [stretch.bounds.north, stretch.bounds.east],
  ];

  if (highlightLayer) map.removeLayer(highlightLayer);
  highlightLayer = L.rectangle(bounds, {
    color: "#ffc23d",
    weight: 2,
    fillOpacity: 0.08,
    // Without this, the rectangle -- being a filled shape drawn on top of
    // whatever bump markers happen to fall inside it -- swallows clicks
    // meant for those markers, even at fillOpacity 0.08. It's purely a
    // visual highlight, so it shouldn't be clickable/hoverable at all.
    interactive: false,
  }).addTo(map);

  map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 17, duration: 0.75 });

  // The list can be scrolled well below the map (especially on mobile) --
  // without this, clicking a stretch would move the map with no visual
  // feedback still on screen to show it happened.
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });

  for (const el of document.querySelectorAll(".stretch-item.is-active")) {
    el.classList.remove("is-active");
  }
  itemEl.classList.add("is-active");
}

function buildStretchItemHtml(stretch, rank) {
  return `
    <button type="button" class="stretch-main">
      <span class="stretch-rank">${rank}</span>
      <span class="stretch-info">
        <span class="stretch-name">${stretch.name}</span>
        <span class="stretch-meta">${formatCount(stretch.bumpCount)} bumps recorded &middot; avg severity ${stretch.avgSeverityG.toFixed(2)}g</span>
      </span>
    </button>
    <button type="button" class="stretch-share" aria-label="Share this stretch" title="Share">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12" />
        <path d="M7 8l5-5 5 5" />
        <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
      </svg>
    </button>
  `;
}

// ---------------------------------------------------------------------------
// Sharing a single stretch (Facebook/X card + deep link back to it)
// ---------------------------------------------------------------------------
// The actual per-stretch preview card (custom image, "#3 Worst Bike Lane in
// <city>" title) is generated server-side -- see functions/shareCard.js's
// header comment for why that has to be a real server response rather than
// something this client-rendered page can produce on its own. Everything
// here just builds the URL to that endpoint and hands it to the share UI.

// Must match functions/shareCard.js's metroSlug EXACTLY -- this is how a
// share link built here gets resolved back to the right metro server-side,
// and how a `?highlight=` link (see applyHighlightFromUrl below) gets
// resolved back to the right metro here. No shared module between this
// bundle and the Functions runtime, so it's duplicated by hand -- change
// one, change both.
function metroSlug(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildShareUrl(metro, mode, rank) {
  return `${window.location.origin}/share/${metroSlug(metro.name)}/${mode}/${rank}`;
}

let activeSharePopover = null;

function closeSharePopover() {
  if (!activeSharePopover) return;
  activeSharePopover.remove();
  activeSharePopover = null;
  document.removeEventListener("click", handleDocumentClickForSharePopover);
}

function handleDocumentClickForSharePopover(event) {
  if (activeSharePopover && !activeSharePopover.contains(event.target)) {
    closeSharePopover();
  }
}

// Desktop fallback for browsers without the Web Share API (most of them,
// still, outside mobile Safari/Chrome) -- a tiny anchored menu with the
// two platforms actually asked for, each just a plain share-intent link
// FB/X reads the target URL's own <meta> tags to build the FB/X card
// itself, so there's nothing more to pass it than the URL.
function openSharePopover(anchorEl, { url, title, text }) {
  closeSharePopover();

  const popover = document.createElement("div");
  popover.className = "share-popover";

  const tweetText = `${title} \u2014 ${text}`;
  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(url)}`;
  const fbUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;

  popover.innerHTML = `
    <a href="${xUrl}" target="_blank" rel="noopener noreferrer" class="share-popover-link">Share on X</a>
    <a href="${fbUrl}" target="_blank" rel="noopener noreferrer" class="share-popover-link">Share on Facebook</a>
  `;

  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = `${window.scrollY + rect.bottom + 6}px`;
  popover.style.left = `${window.scrollX + rect.left}px`;

  activeSharePopover = popover;
  // Deferred so the same click that opened this popover doesn't
  // immediately close it again via the listener below.
  setTimeout(() => document.addEventListener("click", handleDocumentClickForSharePopover), 0);
}

function shareStretch(metro, mode, rank, stretch, anchorEl) {
  const url = buildShareUrl(metro, mode, rank);
  const title = `#${rank} Worst Bike Lane in ${metro.name}`;
  const text = `${stretch.name} \u2014 ${formatCount(stretch.bumpCount)} bumps recorded on BumpWatch.`;

  // Mobile's native share sheet (Messages, Instagram, FB, X, all of it)
  // when it's available -- the popover below is only a fallback for the
  // desktop browsers that don't implement it.
  if (navigator.share) {
    navigator.share({ title, text, url }).catch(() => {}); // cancelling the share sheet rejects; nothing to handle
    return;
  }

  openSharePopover(anchorEl, { url, title, text });
}

// Two independently-computed top 10s from generate-top-stretches.mjs --
// "weighted" ranks by speed-weighted score (same jolt at a lower speed
// counts more), "unweighted" ranks by plain total severity. These can
// genuinely differ in WHICH stretches show up, not just their order --
// see the script's own comment on why both are worth showing rather than
// just re-sorting one fixed list.
const RANKING_NOTES = {
  weighted:
    "Weighted so a bump hit at a lower speed counts for more -- a hint the surface itself is the problem, not just speed.",
  unweighted: "Ranked by total recorded severity only, with no speed adjustment.",
};

// generate-top-stretches.mjs now groups bumps into rough metro areas
// FIRST and ranks a top 10 independently within each one (see that
// script's header comment for why) -- so top-stretches.json holds a
// `metros` array, each with its own weighted/unweighted top 10, rather
// than one flat list. The ranking-mode toggle still applies globally:
// switching to "raw severity" re-renders every metro's section in that
// mode at once, rather than being a per-metro control.
let metroRankings = []; // [{ name, lat, lng, weighted: [...], unweighted: [...] }, ...]
let activeRankingMode = "weighted";

// Only the first 5 of each metro's (up to 10) stretches show by default --
// that's the punchy, shareable "top 5" list this site is built around.
// "See next 5" reveals the rest for whichever metro was clicked, tracked
// here by metro slug so it survives a renderStretchList() rebuild (the
// weighted/unweighted toggle re-renders everything from scratch) instead
// of silently re-collapsing whatever a visitor had opened.
const DEFAULT_STRETCH_COUNT = 5;
const expandedMetroSlugs = new Set();

function renderStretchList(metros) {
  const container = document.getElementById("stretchesList");
  container.innerHTML = "";

  for (const metro of metros) {
    const stretches = metro[activeRankingMode] ?? [];
    if (stretches.length === 0) continue; // shouldn't happen in practice -- processMetro only emits a metro once it has a nonempty top 5 in both modes -- but skip cleanly rather than rendering an empty section if it ever does

    const slug = metroSlug(metro.name);
    const isExpanded = expandedMetroSlugs.has(slug);
    const visibleStretches = isExpanded ? stretches : stretches.slice(0, DEFAULT_STRETCH_COUNT);

    const heading = document.createElement("h3");
    heading.className = "stretch-metro-heading";
    heading.textContent = metro.name;
    container.appendChild(heading);

    const list = document.createElement("ol");
    list.className = "stretches-list";

    // visibleStretches is either the full array or a slice(0, N) of it, so
    // its index always matches the stretch's real position in `stretches`
    // -- rank stays correct (never resets to 1) whether this is showing 5
    // or all 10.
    visibleStretches.forEach((stretch, index) => {
      const rank = index + 1;
      const li = document.createElement("li");
      const item = document.createElement("div");
      item.className = "stretch-item";
      item.innerHTML = buildStretchItemHtml(stretch, rank);
      // Lets a `?highlight=` deep link (see applyHighlightFromUrl) find
      // this exact item in the DOM after rendering, without needing to
      // re-derive it from stretch content that could theoretically repeat.
      item.dataset.metroSlug = slug;
      item.dataset.rank = String(rank);

      item.querySelector(".stretch-main").addEventListener("click", () => flyToStretch(stretch, item));

      const shareBtn = item.querySelector(".stretch-share");
      shareBtn.addEventListener("click", (event) => {
        // Without this, the click bubbles up into nothing bad right now
        // (the share button isn't nested inside .stretch-main), but it's
        // cheap insurance against the two ever needing to overlap later,
        // and it's the same guard flyToStretch's own layout depends on
        // conceptually staying a separate, non-nested control.
        event.stopPropagation();
        shareStretch(metro, activeRankingMode, rank, stretch, shareBtn);
      });

      li.appendChild(item);
      list.appendChild(li);
    });

    container.appendChild(list);

    if (stretches.length > DEFAULT_STRETCH_COUNT) {
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "stretch-expand-btn";
      expandBtn.textContent = isExpanded
        ? "Show fewer"
        : `See next ${stretches.length - DEFAULT_STRETCH_COUNT} stretches`;
      expandBtn.addEventListener("click", () => {
        if (isExpanded) expandedMetroSlugs.delete(slug);
        else expandedMetroSlugs.add(slug);
        renderStretchList(metroRankings);
      });
      container.appendChild(expandBtn);
    }
  }
}

function setRankingMode(mode) {
  activeRankingMode = mode;
  document.getElementById("rankingNote").textContent = RANKING_NOTES[mode];
  for (const btn of document.querySelectorAll(".ranking-toggle-btn")) {
    btn.classList.toggle("is-active", btn.dataset.mode === mode);
  }
  renderStretchList(metroRankings);
}

document.getElementById("rankingWeightedBtn")?.addEventListener("click", () => setRankingMode("weighted"));
document.getElementById("rankingUnweightedBtn")?.addEventListener("click", () => setRankingMode("unweighted"));

async function loadTopStretches() {
  // Reads the topStretches/current doc directly -- functions/index.js's
  // recomputeTopStretches runs the clustering/scoring/geocoding pipeline
  // (see functions/topStretchesCore.js) on a nightly schedule and writes
  // its result straight into Firestore, so the page always shows whatever
  // that job last produced with no redeploy needed in between.
  // scripts/generate-top-stretches.mjs still exists as a LOCAL PREVIEW
  // tool (see its header comment) but nothing on the live site reads its
  // output file anymore.
  const snapshot = await getDoc(doc(db, "topStretches", "current"));
  if (!snapshot.exists()) return; // section stays hidden -- nightly job hasn't run yet
  const data = snapshot.data();
  const metros = Array.isArray(data.metros) ? data.metros : [];
  const hasAnyStretches = metros.some(
    (metro) => (metro.weighted?.length ?? 0) > 0 || (metro.unweighted?.length ?? 0) > 0
  );
  if (!hasAnyStretches) return; // section stays hidden -- nothing to show yet

  metroRankings = metros;
  setRankingMode(activeRankingMode);

  document.getElementById("priority-stretches").hidden = false;

  applyHighlightFromUrl();
}

// A share link (see shareStretch above) sends a real visitor's browser to
// functions/shareCard.js's redirect target: this same site with
// `?highlight=<metroSlug>:<mode>:<rank>` in the query string. This is what
// turns that back into the actual highlighted-box behavior a click in the
// list already gives you -- same flyToStretch, just triggered by a URL
// instead of a click.
//
// A link can point at a metro/rank that no longer places in the top 5
// after a nightly recompute (see shareCard.js's own comment on this same
// tradeoff server-side) -- there's no error state for that here, the page
// just loads as a completely normal visit with nothing highlighted.
function applyHighlightFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("highlight");
  if (!raw) return;

  const [slug, mode, rankStr] = raw.split(":");
  const rank = Number(rankStr);
  if (!slug || (mode !== "weighted" && mode !== "unweighted") || !Number.isInteger(rank) || rank < 1) {
    return;
  }

  const metro = metroRankings.find((m) => metroSlug(m.name) === slug);
  const stretch = metro?.[mode]?.[rank - 1];
  if (!metro || !stretch) return;

  if (mode !== activeRankingMode) setRankingMode(mode);

  // setRankingMode (if it just ran) rebuilds #stretchesList synchronously,
  // but flyToStretch also scrolls the page -- deferring one frame keeps
  // that scroll from racing the browser's own initial-load scroll
  // restoration on some browsers.
  requestAnimationFrame(() => {
    const item = document.querySelector(
      `.stretch-item[data-metro-slug="${slug}"][data-rank="${rank}"]`
    );
    if (item) flyToStretch(stretch, item);
  });
}

loadTopStretches().catch((error) => {
  // Not a user-facing failure -- the topStretches/current doc is written
  // by a nightly Cloud Function (see comment above) and won't exist until
  // its first run. The section just stays hidden.
  console.warn("Priority stretches unavailable:", error);
});

// ---------------------------------------------------------------------------
// Bike lane overlay
// ---------------------------------------------------------------------------
// Reads the static bike-lanes.geojson (see scripts/generate-bike-lanes.mjs)
// rather than querying Overpass directly -- same reasoning as
// top-stretches.json: lane geometry barely changes day to day, so a script
// rerun by hand beats hitting a shared free API on every page load.

// Cool family, deliberately apart from the warm heat ramp (bumps) and the
// yellow stretch highlight -- reads as "infrastructure" rather than
// "problem" at a glance. track/shared stay teal-ish; lane is a deeper,
// more saturated blue (was a lighter cyan, #35b0c7) so "painted lane" is
// visually distinct from "protected path" instead of just a paler version
// of it. Weight/dash also step down with actual physical protection: a
// solid track is the strongest line, a sharrow the faintest.
const BIKE_LANE_STYLES = {
  track: { color: "#3ddc97", weight: 3, opacity: 0.85 },
  lane: { color: "#2563eb", weight: 2.5, opacity: 0.75 },
  shared: { color: "#6b8f96", weight: 2, opacity: 0.6, dashArray: "2, 6" },
};
const BIKE_LANE_LABELS = {
  track: "protected bike path",
  lane: "painted bike lane",
  shared: "shared lane (sharrow)",
};

function styleBikeLaneFeature(feature) {
  return BIKE_LANE_STYLES[feature.properties.kind] ?? BIKE_LANE_STYLES.lane;
}

function bindBikeLanePopup(feature, layer) {
  const label = BIKE_LANE_LABELS[feature.properties.kind] ?? "bike lane";
  const name = feature.properties.name ?? "Unnamed segment";
  layer.bindPopup(`<strong>${name}</strong><br>${label}`);
}

async function loadBikeLanes() {
  const response = await fetch("bike-lanes.geojson", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.features) || data.features.length === 0) return;

  bikeLanesLayer = L.geoJSON(data, {
    style: styleBikeLaneFeature,
    onEachFeature: bindBikeLanePopup,
  });

  // Data may have already loaded and set the zoom-dependent bump layer
  // before this resolves (it's a separate fetch) -- apply the same
  // zoom-based visibility check immediately rather than waiting for the
  // next zoomend.
  updateLayerForZoom();
}

loadBikeLanes().catch((error) => {
  // Not a user-facing failure -- bike-lanes.geojson is regenerated by hand
  // (see scripts/generate-bike-lanes.mjs) and won't exist until the first
  // run. The map just shows bumps without the lane overlay.
  console.warn("Bike lane overlay unavailable:", error);
});
