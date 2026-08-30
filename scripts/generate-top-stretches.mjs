#!/usr/bin/env node
// Generates web/bikelanebumps-site/top-stretches.json: the 5 highest-priority
// bike lane stretches, ranked and named, for pitching a city government on
// where to fix things first.
//
// Run manually after adding a meaningful batch of new rides:
//   node scripts/generate-top-stretches.mjs
//
// Deliberately NOT a Cloud Function / scheduled job. At this stage rides
// arrive in occasional batches (a handful of rides at a time), not a
// continuous crowdsourced stream, so a script you rerun by hand is simpler
// than standing up a recompute pipeline for data that barely changes day to
// day. If/when the crowdsourced-stations idea takes off and bumps start
// arriving continuously from many riders, this logic is the right shape to
// lift into a scheduled Cloud Function that writes the same JSON shape into
// Firestore instead of a static file.
//
// ---- Why "stretch" isn't just "read the bumps collection" ----
// Bumps are stored as individual GPS points (rides/{rideId}/bumps/{bumpId}),
// not named road segments -- there's no "stretch" in the data model. This
// script constructs one:
//   1. Bin every bump into a small grid cell (~120m, latitude-corrected so
//      cells are roughly square instead of longitude-squished).
//   2. Merge 8-connected non-empty cells into clusters, so a real stretch
//      that happens to straddle a grid boundary doesn't get arbitrarily
//      split into two undersized, under-ranked pieces -- but CAP how far a
//      merge is allowed to grow a cluster (see MAX_STRETCH_METERS). A bike
//      ride is continuous by nature, so an uncapped flood-fill merge glues
//      every bumpy cell along an entire multi-kilometer ride into one
//      "stretch" -- technically one connected component, but useless as a
//      repair-priority target and prone to landing its centroid somewhere
//      that isn't even on the road being ridden. Capping the merge keeps
//      each stretch block-sized and actionable.
//   3. Score each cluster by *total* severity (sum of magnitudeG across its
//      bumps), not raw count -- a cluster with fewer but nastier bumps can
//      out-rank a cluster with lots of barely-there ones, which is the more
//      persuasive number for a repair-priority pitch than "most potholes."
//      Each bump's magnitudeG is also weighted by riding speed before it's
//      summed in (see REFERENCE_SPEED_MPS/speedWeightFor below): the same
//      jolt at a lower speed implies a nastier surface defect, so it should
//      outrank an equal jolt taken at a higher speed.
//   4. Reverse-geocode only the winning 5 centroids (via OpenStreetMap's
//      free Nominatim API) into a human-readable name/street, since that's
//      the only place raw lat/lng needs to become something a city planner
//      can read. Doing this for every cluster (there could be hundreds)
//      instead of just the top 5 would be slow and needlessly hammer a free
//      public service.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ID = "bikelanebumps"; // matches .firebaserc
const FIRESTORE_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;

// Firestore's `bumps` collection group is public-read (see
// firestore/firestore.rules), so this needs no credentials -- same access
// level as the web page's own heatmap query.
const BUMP_FETCH_LIMIT = 20000; // generous headroom above the current ~1100

const CELL_METERS = 120; // roughly a block -- fine enough to separate
                          // distinct stretches, coarse enough that GPS noise
                          // (typically 5-20m) doesn't fracture one real
                          // stretch into several cells.
const MAX_STRETCH_METERS = 300; // cap on a merged cluster's bounding-box
                                 // diagonal -- about the length of a bad
                                 // block. Without this, a continuous ride
                                 // flood-fills into one multi-kilometer
                                 // "stretch" (see comment above).
const MIN_BUMPS_PER_STRETCH = 3; // guards against one severe-but-isolated
                                  // bump (a single deep pothole hit once)
                                  // dominating the list over stretches with
                                  // real, repeated evidence of a problem.
const MAX_ACCURACY_METERS = 30; // drop bumps whose GPS fix was too loose to
                                 // trust for street-level clustering.

// A given surface defect produces a harder jolt the faster you're going
// over it, so two bumps of equal magnitudeG are NOT equally bad: the one
// hit at a lower speed implies a nastier defect (a sharper edge, a deeper
// pothole) that would have scored even higher at normal speed. This scales
// each bump's severity relative to REFERENCE_SPEED_MPS -- slower than
// reference boosts it, faster than reference discounts it -- before
// summing into a cluster's score, so ranking reflects that.
const REFERENCE_SPEED_MPS = 4.5; // ~10 mph, a typical bike-lane cruising
                                  // speed; the neutral point where the
                                  // weight is exactly 1.
const MIN_SPEED_FOR_WEIGHTING_MPS = 1; // below this (or if speed is
                                        // missing/unknown, the -1 sentinel
                                        // in BumpEvent.swift), skip the
                                        // adjustment entirely -- a bump
                                        // logged near a stop sign or with no
                                        // GPS-derived speed yet shouldn't
                                        // get an arbitrarily huge boost from
                                        // dividing by a near-zero speed.
const MAX_SPEED_WEIGHT = 2.5; // cap how much a very slow bump can be
                               // boosted, so one crawl-speed reading can't
                               // single-handedly dominate a cluster's score.
const MIN_SPEED_WEIGHT = 0.6; // floor how much a very fast bump gets
                               // discounted, for the same reason in reverse.
const TOP_N = 5;

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
// Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
// requires a real identifying User-Agent and caps free usage at 1 request/sec.
const NOMINATIM_USER_AGENT = "bikelanebumps.org top-stretches script (schoellojeff@gmail.com)";

// Nominatim tells us *the nearest road* to a point, but not what crosses it
// -- there's no "intersection" concept in a reverse-geocode response. To
// label a stretch as "Balboa Ave between X and Y" instead of just "Balboa
// Ave, Clairemont", we separately ask OpenStreetMap's Overpass API for the
// nearest *differently-named* road at each end of the stretch.
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// Overpass's own usage guidance (https://wiki.openstreetmap.org/wiki/Overpass_API)
// says under 10,000 queries/day is "fine for a one-off use" and asks for an
// identifying User-Agent -- no hard per-second cap like Nominatim, but no
// reason to hammer it either.
const OVERPASS_USER_AGENT = NOMINATIM_USER_AGENT;
const CROSS_STREET_SEARCH_RADIUS_METERS = 60;

// One shared pace for every external call this script makes, Nominatim and
// Overpass alike -- simplest way to stay correct as the number of calls per
// stretch has grown (1 geocode + 2 cross-street lookups now, was just 1),
// and 1100ms comfortably satisfies Nominatim's stricter 1/sec requirement.
const EXTERNAL_API_DELAY_MS = 1100;
let lastExternalCallAt = 0;

async function politeFetch(url, options) {
  const elapsed = Date.now() - lastExternalCallAt;
  if (elapsed < EXTERNAL_API_DELAY_MS) await sleep(EXTERNAL_API_DELAY_MS - elapsed);
  lastExternalCallAt = Date.now();
  return fetch(url, options);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_PATH = path.join(__dirname, "..", "web", "bikelanebumps-site", "top-stretches.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Firestore REST helpers ----
// The REST API wraps every field in a `{ <type>Value: ... }` envelope
// (e.g. { doubleValue: 3.2 } or { integerValue: "3" } -- integers come back
// as strings). This unwraps the handful of field types BumpEvent actually
// uses.
function unwrapValue(value) {
  if (value == null) return null;
  if ("doubleValue" in value) return value.doubleValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  return null;
}

function parseBumpDocument(doc) {
  const fields = doc.fields ?? {};
  const get = (name) => unwrapValue(fields[name]);
  return {
    latitude: get("latitude"),
    longitude: get("longitude"),
    magnitudeG: get("magnitudeG"),
    horizontalAccuracyMeters: get("horizontalAccuracyMeters"),
    speedMetersPerSecond: get("speedMetersPerSecond"),
  };
}

async function fetchAllBumps() {
  const body = {
    structuredQuery: {
      from: [{ collectionId: "bumps", allDescendants: true }],
      limit: BUMP_FETCH_LIMIT,
    },
  };

  const response = await fetch(FIRESTORE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Firestore runQuery failed: HTTP ${response.status} ${await response.text()}`);
  }

  // runQuery's response body is a JSON array; entries without a `document`
  // key are just progress/readTime markers and are skipped.
  const results = await response.json();
  return results
    .filter((entry) => entry.document)
    .map((entry) => parseBumpDocument(entry.document));
}

// ---- Cleaning ----
// A bump recorded before the Watch's first GPS fix lands falls back to
// (0, 0) -- see BumpEvent.swift / RideManager.recordBump's `?? 0` -- which
// is the Gulf of Guinea, nowhere near San Diego. A real GPS fix landing on
// that exact point is practically impossible, so treat it as "no location"
// and drop it, along with anything whose accuracy was too poor to trust.
function isUsableBump(bump) {
  if (typeof bump.latitude !== "number" || typeof bump.longitude !== "number") return false;
  if (typeof bump.magnitudeG !== "number") return false;
  if (bump.latitude === 0 && bump.longitude === 0) return false;
  if (
    typeof bump.horizontalAccuracyMeters === "number" &&
    bump.horizontalAccuracyMeters >= 0 &&
    bump.horizontalAccuracyMeters > MAX_ACCURACY_METERS
  ) {
    return false;
  }
  return true;
}

// ---- Grid clustering ----
const METERS_PER_DEGREE_LAT = 111_320;

function cellKeyFor(lat, lng) {
  const latStep = CELL_METERS / METERS_PER_DEGREE_LAT;
  const lonStep = CELL_METERS / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  const row = Math.floor(lat / latStep);
  const col = Math.floor(lng / lonStep);
  return { row, col, key: `${row},${col}` };
}

// Great-circle-ish distance between two points, in meters -- an
// equirectangular approximation, which is plenty accurate at the
// block-to-neighborhood scale this script works at.
function metersBetween(lat1, lng1, lat2, lng2) {
  const latMidRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dLat = (lat2 - lat1) * METERS_PER_DEGREE_LAT;
  const dLng = (lng2 - lng1) * METERS_PER_DEGREE_LAT * Math.cos(latMidRad);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function boundsOfBumps(bumps) {
  const lats = bumps.map((b) => b.latitude);
  const lngs = bumps.map((b) => b.longitude);
  return {
    south: Math.min(...lats),
    north: Math.max(...lats),
    west: Math.min(...lngs),
    east: Math.max(...lngs),
  };
}

function mergeBounds(a, b) {
  return {
    south: Math.min(a.south, b.south),
    north: Math.max(a.north, b.north),
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
  };
}

// Diagonal of a bounding box, in meters -- used as the "how big has this
// cluster gotten" check against MAX_STRETCH_METERS.
function boundsDiagonalMeters(bounds) {
  return metersBetween(bounds.south, bounds.west, bounds.north, bounds.east);
}

// Union-find where each component also carries a running bounding box, and
// a union is only allowed to go through if the *combined* box would still
// fit under MAX_STRETCH_METERS. This is what keeps a long, mostly-continuous
// ride from flood-filling into one giant "stretch" -- see the comment on
// MAX_STRETCH_METERS above.
class BoundedUnionFind {
  constructor() {
    this.parent = new Map();
    this.bounds = new Map(); // root key -> bounding box
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  // Attempts to union the components containing a and b. Returns true if
  // the merge happened, false if it was rejected for exceeding the cap.
  tryUnion(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return true; // already merged, nothing to do

    const boundsA = this.bounds.get(rootA);
    const boundsB = this.bounds.get(rootB);
    const combined = mergeBounds(boundsA, boundsB);
    if (boundsDiagonalMeters(combined) > MAX_STRETCH_METERS) return false;

    this.parent.set(rootA, rootB);
    this.bounds.set(rootB, combined);
    return true;
  }
}

function clusterBumps(bumps) {
  const cellsByKey = new Map(); // key -> { row, col, bumps: [] }

  for (const bump of bumps) {
    const { row, col, key } = cellKeyFor(bump.latitude, bump.longitude);
    if (!cellsByKey.has(key)) cellsByKey.set(key, { row, col, bumps: [] });
    cellsByKey.get(key).bumps.push(bump);
  }

  const uf = new BoundedUnionFind();
  for (const [key, cell] of cellsByKey) {
    uf.find(key); // register the cell as its own component
    uf.bounds.set(key, boundsOfBumps(cell.bumps));
  }

  const neighborOffsets = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];
  // Candidate merges, deduped so each adjacent pair is only attempted once
  // regardless of which side we visit it from.
  const candidatePairs = [];
  for (const cell of cellsByKey.values()) {
    for (const [dr, dc] of neighborOffsets) {
      const neighborKey = `${cell.row + dr},${cell.col + dc}`;
      if (cellsByKey.has(neighborKey)) {
        const a = `${cell.row},${cell.col}`;
        const b = neighborKey;
        candidatePairs.push(a < b ? [a, b] : [b, a]);
      }
    }
  }

  // Repeat until a full pass makes no further merges. Needed because
  // merging is order-sensitive near the cap: two components that don't fit
  // together yet might both still have room to absorb a smaller neighbor
  // first, changing what fits on a later pass. Merges only ever reduce the
  // number of components, so this always terminates.
  let mergedSomething = true;
  while (mergedSomething) {
    mergedSomething = false;
    for (const [a, b] of candidatePairs) {
      if (uf.find(a) === uf.find(b)) continue;
      if (uf.tryUnion(a, b)) mergedSomething = true;
    }
  }

  const clustersByRoot = new Map(); // root -> bump[]
  for (const [key, cell] of cellsByKey) {
    const root = uf.find(key);
    if (!clustersByRoot.has(root)) clustersByRoot.set(root, []);
    clustersByRoot.get(root).push(...cell.bumps);
  }

  return [...clustersByRoot.values()];
}

// ---- Scoring & summarizing ----
// Returns a multiplier to apply to a bump's magnitudeG before summing it
// into a cluster's score -- see REFERENCE_SPEED_MPS above for the reasoning.
// Unknown speed (missing, or the -1 "no fix yet" sentinel) or anything at
// or below walking-adjacent speed gets a neutral weight of 1 rather than an
// adjustment, since a low/unreliable speed reading there isn't trustworthy
// evidence about the road surface.
function speedWeightFor(speedMetersPerSecond) {
  if (typeof speedMetersPerSecond !== "number") return 1;
  if (speedMetersPerSecond < MIN_SPEED_FOR_WEIGHTING_MPS) return 1;
  const raw = REFERENCE_SPEED_MPS / speedMetersPerSecond;
  return Math.min(MAX_SPEED_WEIGHT, Math.max(MIN_SPEED_WEIGHT, raw));
}

function summarizeCluster(bumps) {
  const count = bumps.length;
  const totalSeverityG = bumps.reduce((sum, b) => sum + b.magnitudeG, 0);
  const avgSeverityG = totalSeverityG / count;

  // Speed-weighted score -- see speedWeightFor(). This drives ranking; the
  // plain totalSeverityG/avgSeverityG above stay unweighted since those are
  // the simple, literal g-force numbers shown to a reader.
  const weightedSeverityG = bumps.reduce(
    (sum, b) => sum + b.magnitudeG * speedWeightFor(b.speedMetersPerSecond),
    0
  );
  const speeds = bumps
    .map((b) => b.speedMetersPerSecond)
    .filter((s) => typeof s === "number" && s >= MIN_SPEED_FOR_WEIGHTING_MPS);
  const avgSpeedMph =
    speeds.length > 0
      ? (speeds.reduce((a, b) => a + b, 0) / speeds.length) * 2.23694
      : null;

  const lats = bumps.map((b) => b.latitude);
  const lngs = bumps.map((b) => b.longitude);
  const centroid = {
    lat: lats.reduce((a, b) => a + b, 0) / count,
    lng: lngs.reduce((a, b) => a + b, 0) / count,
  };

  // Bounding box with a little padding so flyToBounds() doesn't zoom in so
  // tight the stretch's own map markers sit flush against the screen edge.
  const rawBounds = {
    south: Math.min(...lats),
    north: Math.max(...lats),
    west: Math.min(...lngs),
    east: Math.max(...lngs),
  };
  const latPad = Math.max((rawBounds.north - rawBounds.south) * 0.25, 0.0015);
  const lngPad = Math.max((rawBounds.east - rawBounds.west) * 0.25, 0.0015);
  const bounds = {
    south: rawBounds.south - latPad,
    north: rawBounds.north + latPad,
    west: rawBounds.west - lngPad,
    east: rawBounds.east + lngPad,
  };

  return {
    count,
    totalSeverityG: Math.round(totalSeverityG * 100) / 100,
    avgSeverityG: Math.round(avgSeverityG * 100) / 100,
    avgSpeedMph: avgSpeedMph == null ? null : Math.round(avgSpeedMph * 10) / 10,
    centroid,
    bounds,
    score: weightedSeverityG,
  };
}

// ---- Reverse geocoding (top N only) ----
async function reverseGeocode(lat, lng) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "17"); // road-level detail, not building-level
  url.searchParams.set("addressdetails", "1");

  const response = await politeFetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Nominatim reverse geocode failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  const address = data.address ?? {};
  return {
    road: address.road || address.pedestrian || address.cycleway || null,
    locality: address.suburb || address.neighbourhood || address.city || address.town || null,
    displayName: data.display_name ?? null,
  };
}

// The two member bumps that are farthest apart -- an approximation of
// "where this stretch starts and ends," used as the two points to look up
// a cross street at. O(n^2) pairwise comparison, which is fine at the
// cluster sizes MAX_STRETCH_METERS produces (tens of bumps, not thousands).
function findClusterEndpoints(bumps) {
  let best = null;
  let bestDistance = -1;
  for (let i = 0; i < bumps.length; i++) {
    for (let j = i + 1; j < bumps.length; j++) {
      const d = metersBetween(
        bumps[i].latitude, bumps[i].longitude,
        bumps[j].latitude, bumps[j].longitude
      );
      if (d > bestDistance) {
        bestDistance = d;
        best = [bumps[i], bumps[j]];
      }
    }
  }
  return best ?? [bumps[0], bumps[0]];
}

function normalizeRoadName(name) {
  return (name ?? "").trim().toLowerCase();
}

// Nearest OSM way with a *different* name than the stretch's own road,
// within CROSS_STREET_SEARCH_RADIUS_METERS of the given point -- i.e. "what
// street is this end of the stretch closest to." Returns null if nothing
// distinct enough turns up (sparse OSM data nearby, or the search radius
// just didn't reach another named road).
// Real, publicly-recognizable street classes only -- excludes highway=service
// (which covers driveways, parking-lot aisles, and alleys; OSM often names
// these, e.g. "Something Driveway", which reads as a real cross street but
// isn't one a city planner would recognize) as well as track/path/footway/
// cycleway/steps, which aren't roads a "between X and Y" reference should
// resolve to.
const CROSS_STREET_HIGHWAY_TYPES =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street";

async function findNearbyCrossStreet(lat, lng, ownRoadName) {
  const query =
    `[out:json][timeout:25];` +
    `way(around:${CROSS_STREET_SEARCH_RADIUS_METERS},${lat},${lng})` +
    `[highway~"^(${CROSS_STREET_HIGHWAY_TYPES})$"][name];` +
    `out center tags;`;

  const response = await politeFetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": OVERPASS_USER_AGENT,
    },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`Overpass query failed: HTTP ${response.status}`);
  }
  const data = await response.json();

  const candidates = (data.elements ?? [])
    .filter((el) => el.tags?.name && el.center)
    .filter((el) => normalizeRoadName(el.tags.name) !== normalizeRoadName(ownRoadName))
    .map((el) => ({
      name: el.tags.name,
      distanceMeters: metersBetween(lat, lng, el.center.lat, el.center.lon),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return candidates[0]?.name ?? null;
}

// Builds the final display name: "{road} between {A} and {B}, {locality}"
// when both ends turned up a distinct cross street, gracefully degrading
// down to just "{road}, {locality}" (the original format) when the
// cross-street lookups come up empty or find the same street at both ends.
function buildStretchName(geocode, crossStreetA, crossStreetB) {
  if (!geocode.road) return geocode.displayName;

  const distinctCrossStreets = [...new Set([crossStreetA, crossStreetB].filter(Boolean))];
  let label = geocode.road;
  if (distinctCrossStreets.length >= 2) {
    label = `${geocode.road} between ${distinctCrossStreets[0]} and ${distinctCrossStreets[1]}`;
  } else if (distinctCrossStreets.length === 1) {
    label = `${geocode.road} near ${distinctCrossStreets[0]}`;
  }

  return geocode.locality ? `${label}, ${geocode.locality}` : label;
}

function fallbackName(lat, lng) {
  return `Unnamed stretch near ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

// ---- Main ----
async function main() {
  console.log(`Fetching bumps from Firestore project "${PROJECT_ID}"...`);
  const rawBumps = await fetchAllBumps();
  console.log(`Fetched ${rawBumps.length} bump documents.`);

  const usableBumps = rawBumps.filter(isUsableBump);
  console.log(`${usableBumps.length} usable after dropping (0,0)/low-accuracy fixes.`);

  // Keep each cluster's raw bumps paired with its summary -- summarizeCluster
  // only returns aggregates, but findClusterEndpoints (for cross-street
  // lookups, below) needs the actual member bumps.
  const clusters = clusterBumps(usableBumps)
    .map((bumps) => ({ bumps, summary: summarizeCluster(bumps) }))
    .filter((cluster) => cluster.summary.count >= MIN_BUMPS_PER_STRETCH)
    .sort((a, b) => b.summary.score - a.summary.score);

  console.log(`${clusters.length} clusters with >= ${MIN_BUMPS_PER_STRETCH} bumps.`);

  const topClusters = clusters.slice(0, TOP_N);
  const stretches = [];

  for (const [index, cluster] of topClusters.entries()) {
    const { summary, bumps } = cluster;
    const speedNote = summary.avgSpeedMph == null ? "unknown avg speed" : `avg ${summary.avgSpeedMph}mph`;
    console.log(
      `Geocoding #${index + 1}: ${summary.count} bumps, total ${summary.totalSeverityG}g (${speedNote}), ` +
      `speed-weighted score ${Math.round(summary.score * 100) / 100} ` +
      `at (${summary.centroid.lat.toFixed(5)}, ${summary.centroid.lng.toFixed(5)})...`
    );

    let geocode = { road: null, locality: null, displayName: null };
    try {
      geocode = await reverseGeocode(summary.centroid.lat, summary.centroid.lng);
    } catch (error) {
      console.warn(`  centroid geocode failed: ${error.message}`);
    }

    // Only bother looking up cross streets if we actually got a road name
    // to pair them with -- "between X and Y" means nothing without knowing
    // which road it's a stretch of.
    let crossStreetA = null;
    let crossStreetB = null;
    if (geocode.road) {
      const [endpointA, endpointB] = findClusterEndpoints(bumps);
      try {
        crossStreetA = await findNearbyCrossStreet(endpointA.latitude, endpointA.longitude, geocode.road);
      } catch (error) {
        console.warn(`  cross-street lookup (end A) failed: ${error.message}`);
      }
      try {
        crossStreetB = await findNearbyCrossStreet(endpointB.latitude, endpointB.longitude, geocode.road);
      } catch (error) {
        console.warn(`  cross-street lookup (end B) failed: ${error.message}`);
      }
    }

    const name =
      buildStretchName(geocode, crossStreetA, crossStreetB) ??
      fallbackName(summary.centroid.lat, summary.centroid.lng);

    console.log(`  -> ${name}`);

    stretches.push({
      name,
      lat: summary.centroid.lat,
      lng: summary.centroid.lng,
      bounds: summary.bounds,
      bumpCount: summary.count,
      totalSeverityG: summary.totalSeverityG,
      avgSeverityG: summary.avgSeverityG,
      avgSpeedMph: summary.avgSpeedMph,
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    stretches,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${stretches.length} stretches to ${OUTPUT_PATH}`);
  for (const s of stretches) {
    console.log(`  - ${s.name} (${s.bumpCount} bumps, ${s.totalSeverityG}g total)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
