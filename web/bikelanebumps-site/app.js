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

map.on("focus", () => map.scrollWheelZoom.enable());
map.on("blur", () => map.scrollWheelZoom.disable());

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
let userLocated = false;

function centerOnVisitor() {
  if (!("geolocation" in navigator)) return;

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

// Dark basemap (CARTO's free "Dark Matter" tiles) to match the page.
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
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

function intensityToColor(intensity) {
  const t = Math.max(0, Math.min(1, intensity));
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    const a = HEAT_STOPS[i];
    const b = HEAT_STOPS[i + 1];
    if (t >= a.stop && t <= b.stop) {
      const localT = (t - a.stop) / (b.stop - a.stop);
      const [r1, g1, b1] = a.rgb;
      const [r2, g2, b2] = b.rgb;
      return `rgb(${Math.round(r1 + (r2 - r1) * localT)}, ${Math.round(
        g1 + (g2 - g1) * localT
      )}, ${Math.round(b1 + (b2 - b1) * localT)})`;
    }
  }
  const [r, g, b] = HEAT_STOPS[HEAT_STOPS.length - 1].rgb;
  return `rgb(${r}, ${g}, ${b})`;
}

// ---------------------------------------------------------------------------
// Heatmap <-> markers switch
// ---------------------------------------------------------------------------
// The heat layer is great for a zoomed-out overview but stops being
// legible once you're close enough to tell individual streets apart --
// that's when clickable, magnitude-scaled markers are more useful. Both
// layers are built once when the data loads; this just toggles which one
// is attached to the map based on current zoom.

const SWITCH_TO_MARKERS_ZOOM = 15;

function updateLayerForZoom() {
  if (!heatLayer && !markersLayer) return; // data hasn't loaded yet
  const zoomedIn = map.getZoom() >= SWITCH_TO_MARKERS_ZOOM;

  if (zoomedIn) {
    if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    if (markersLayer && !map.hasLayer(markersLayer)) markersLayer.addTo(map);
  } else {
    if (markersLayer && map.hasLayer(markersLayer)) map.removeLayer(markersLayer);
    if (heatLayer && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
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
    fillOpacity: 0.85,
  });
  marker.bindPopup(buildBumpPopupHtml(bump, color));
  return marker;
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

  const rows = [
    dateLabel,
    speedLabel ? `Speed: ${speedLabel}` : null,
    `${bump.lat.toFixed(5)}, ${bump.lng.toFixed(5)}`,
  ].filter(Boolean);

  return `
    <div class="bump-popup">
      <p class="bump-popup-mag" style="color: ${magnitudeColor}">${bump.magnitude.toFixed(2)}g</p>
      ${rows.map((row) => `<p class="bump-popup-row">${row}</p>`).join("")}
    </div>
  `;
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
  renderHeatmap(bumpsSnap);
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

function renderHeatmap(bumpsSnap) {
  const bumps = [];

  bumpsSnap.forEach((doc) => {
    const bump = doc.data();
    if (typeof bump.latitude !== "number" || typeof bump.longitude !== "number") return;
    bumps.push({
      lat: bump.latitude,
      lng: bump.longitude,
      magnitude: typeof bump.magnitudeG === "number" ? bump.magnitudeG : 0,
      timestamp: typeof bump.timestamp?.toDate === "function" ? bump.timestamp.toDate() : null,
      speedMetersPerSecond:
        typeof bump.speedMetersPerSecond === "number" ? bump.speedMetersPerSecond : null,
    });
  });

  const emptyState = document.getElementById("mapEmpty");

  if (bumps.length === 0) {
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

  // Attach whichever layer matches the current zoom -- most likely the
  // heat layer at this point, but respect wherever the map actually is
  // (e.g. a geolocation fix that already zoomed in past the switch point).
  updateLayerForZoom();

  // Don't fight a successful geolocation fix -- only fall back to fitting
  // the data's bounds if we're not already centered on the visitor.
  if (!userLocated) {
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

loadData().catch((error) => {
  console.error("Failed to load ride data:", error);
  document.getElementById("mapEmpty").hidden = false;
  document.getElementById("mapEmpty").textContent =
    "Couldn't load ride data right now — try refreshing in a bit.";
});
