/**
 * Example: fetch bumps from Firestore and render them as a heatmap layer.
 *
 * This assumes you already have a Leaflet map on the page (adjust the
 * map-library-specific bits at the bottom if you're using Google Maps or
 * Mapbox GL instead -- the Firestore query part stays the same).
 *
 * npm install firebase leaflet leaflet.heat
 * (or load them from a CDN script tag if your existing page isn't bundled)
 */

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collectionGroup,
  query,
  where,
  getDocs,
} from "firebase/firestore";

const firebaseConfig = {
  // same config object you already use elsewhere in the project
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/**
 * Loads bumps across all rides within an optional date range and returns
 * them as [lat, lng, intensity] tuples, which is the format leaflet.heat
 * expects.
 *
 * Uses a collection group query across every `bumps` subcollection, so you
 * don't need to know ride IDs up front. For very large datasets, add a
 * bounding-box filter (e.g. with geohashing via the `geofire-common`
 * package) so you're not pulling every bump ever recorded on every page
 * load -- fine to skip that until the dataset actually gets big.
 */
async function loadBumpHeatPoints({ since = null } = {}) {
  const bumpsQuery = since
    ? query(collectionGroup(db, "bumps"), where("timestamp", ">=", since))
    : query(collectionGroup(db, "bumps"));

  const snapshot = await getDocs(bumpsQuery);

  return snapshot.docs.map((doc) => {
    const bump = doc.data();
    // Normalize magnitude (g) to a 0-1ish intensity; tune the divisor once
    // you see your real magnitude distribution. leaflet.heat clamps
    // intensity internally, so an occasional value over 1 is fine.
    const intensity = Math.min(bump.magnitudeG / 1.5, 1);
    return [bump.latitude, bump.longitude, intensity];
  });
}

/**
 * Wire it into an existing Leaflet `map` instance.
 */
async function addBumpHeatLayer(map) {
  const points = await loadBumpHeatPoints();
  return L.heatLayer(points, {
    radius: 18,
    blur: 22,
    maxZoom: 17,
    gradient: {
      0.2: "#2b6cb0", // minor bumps: blue
      0.5: "#d69e2e", // moderate: amber
      0.8: "#c53030", // severe: red -- these are the segments worth prioritizing
    },
  }).addTo(map);
}

export { loadBumpHeatPoints, addBumpHeatLayer };
