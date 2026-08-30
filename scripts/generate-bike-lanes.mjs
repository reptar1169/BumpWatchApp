#!/usr/bin/env node
// Generates web/bikelanebumps-site/bike-lanes.geojson: bike lane / cycleway
// geometry near recorded rides, from OpenStreetMap, so the heatmap can show
// bumps in context -- on a marked lane, or nowhere near one.
//
// Run manually after adding a meaningful batch of new rides (same workflow
// as generate-top-stretches.mjs):
//   node scripts/generate-bike-lanes.mjs
//
// ---- Why a separate static file instead of querying live ----
// Same reasoning as generate-top-stretches.mjs: bike lane geometry barely
// changes day to day, and having every visitor's browser hit Overpass
// directly would be slow and impolite to a shared free service. One script,
// rerun by hand as ridden area grows, is simpler than a live pipeline.
//
// ---- Scope: many small padded boxes, not one box around everything ----
// A single bounding box around every recorded bump covers everything
// geographically *between* them too, including the empty rectangular
// corners of a long diagonal ride -- e.g. a ride connecting Torrey Pines to
// Linda Vista produces one box that also happens to sweep past Mission Bay,
// pulling in bike lane data nobody's ridden anywhere near. Naively grouping
// only *disconnected* areas doesn't fully fix this either: real rides often
// do form one continuous, connected chain (the same corridor, e.g. down
// Genesee Ave, linking neighborhoods that look separate on a "top 5
// stretches" list), so an unbounded flood fill still collapses the whole
// thing into one region with the same oversized rectangle problem.
//
// The actual fix is the same one already applied to
// generate-top-stretches.mjs's clustering for the identical reason: cap how
// far a single region is allowed to grow (see MAX_REGION_METERS). A long
// ridden corridor then splits into a string of many small, tightly-fit
// boxes hugging the actual path instead of one big rectangle with wasted
// corners -- each gets its own Overpass query. Rerunning the script after
// riding new areas naturally adds more regions; riding further along an
// existing corridor just adds more boxes along it.
//
// ---- What counts as a "bike lane" here ----
// OSM tags bike infrastructure at several tiers of actual protection:
//   - highway=cycleway                     a dedicated path/track,
//                                           physically separated from cars
//   - cycleway(:left/:right/:both)=track   same idea, tagged on the road
//   - cycleway(:left/:right/:both)=lane    a painted lane, no physical
//                                           separation
//   - cycleway(:left/:right/:both)=shared_lane   sharrows -- a shared
//                                           travel lane, marked but not
//                                           dedicated
// All three tiers get pulled in (a painted lane is still a "bike lane" for
// this project's purposes) but tagged with a `kind` so the website can
// style real protection differently from paint-only, which matters for a
// repair-priority pitch -- "unprotected painted lane" is itself useful
// context next to where the worst bumps are.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ID = "bikelanebumps"; // matches .firebaserc
const FIRESTORE_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
const BUMP_FETCH_LIMIT = 20000;

const METERS_PER_DEGREE_LAT = 111_320;

const REGION_CELL_METERS = 150; // grid cell size for the initial binning
                                 // pass, before bounded merging -- fine
                                 // enough that a region's bounding box
                                 // tracks the actual ridden path closely
                                 // rather than in coarse 800m jumps.
const MAX_REGION_METERS = 900; // cap on a merged region's bounding-box
                                // diagonal. Without this, a long connected
                                // ride flood-fills into one region whose
                                // *rectangular* box wastes a lot of area in
                                // its corners (see header comment). 900m is
                                // a balance -- still tiny next to an 11km
                                // single box, but keeps the total number of
                                // Overpass calls (and therefore rate-limit
                                // risk on the shared public instance) down;
                                // a tighter cap trades more precision for
                                // more, smaller queries.
const MIN_POINTS_PER_REGION = 3; // drop stray single/double GPS outliers so
                                  // they don't burn an Overpass call each.
const BBOX_PADDING_METERS = 300; // extend each region past its own bumps a
                                  // bit so a lane doesn't cut off exactly
                                  // at the last recorded bump. Smaller than
                                  // before now that regions themselves are
                                  // much smaller and more numerous.

// Several public instances run the same Overpass API software (same
// query language, same JSON response shape), and any one of them can have
// a bad moment -- overpass-api.de (the main instance) can IP-block a
// client outright after a request burst, and even a no-rate-limit mirror
// can throw a transient 5xx. Rather than hardcode one URL and manually
// swap it every time that happens, this tries each mirror in order and
// only moves to the next once the current one has exhausted its own
// retries (see queryOverpassMirror) -- one genuinely bad mirror doesn't
// fail the whole run. Ordered with the no-published-rate-limit mirrors
// first, overpass-api.de last as a final fallback since it's the one most
// likely to still be cooling down from earlier in this debugging session.
// Full list: https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances
const OVERPASS_MIRRORS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
// Same identifying User-Agent convention as generate-top-stretches.mjs.
const OVERPASS_USER_AGENT = "bikelanebumps.org bike-lanes script (schoellojeff@gmail.com)";
const OVERPASS_TIMEOUT_S = 60;
// One query per region now instead of one total -- same politeness
// convention as generate-top-stretches.mjs's shared external-call throttle,
// just longer: Overpass's public instance appears to rate-limit on
// something closer to concurrent "slots" than a flat requests/sec budget,
// so pacing calls further apart reduces (without eliminating) how often a
// run hits HTTP 429 partway through.
const EXTERNAL_API_DELAY_MS = 2000;
let lastExternalCallAt = 0;

// Overpass 429s are common on the shared public instance under any real
// load and are transient -- worth a few retries with backoff before giving
// up on a region entirely.
const OVERPASS_MAX_RETRIES = 4;
const OVERPASS_RETRY_BASE_DELAY_MS = 15000; // 15s/30s/60s/120s -- the field
                                             // run showed 8s wasn't enough
                                             // once the instance started
                                             // refusing connections outright
                                             // rather than just 429ing.

// If several regions in a row fail even after exhausting their own
// retries, that's a stronger signal than any one region's failure -- the
// shared instance is likely throttling this client as a whole, and
// ramming the next region's query in immediately just adds to that. Back
// off harder at the whole-run level too.
const CONSECUTIVE_FAILURE_COOLDOWN_THRESHOLD = 2;
const CONSECUTIVE_FAILURE_COOLDOWN_MS = 90000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeFetch(url, options) {
  const elapsed = Date.now() - lastExternalCallAt;
  if (elapsed < EXTERNAL_API_DELAY_MS) await sleep(EXTERNAL_API_DELAY_MS - elapsed);
  lastExternalCallAt = Date.now();
  return fetch(url, options);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_PATH = path.join(__dirname, "..", "web", "bikelanebumps-site", "bike-lanes.geojson");

// ---- Firestore: just enough to get bump locations ----
// (Deliberately lighter than generate-top-stretches.mjs's fetch -- this
// script only needs where bumps are, not their severity/speed/etc.)
function unwrapValue(value) {
  if (value == null) return null;
  if ("doubleValue" in value) return value.doubleValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("nullValue" in value) return null;
  return null;
}

async function fetchBumpPoints() {
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
  const results = await response.json();
  const points = results
    .filter((entry) => entry.document)
    .map((entry) => {
      const fields = entry.document.fields ?? {};
      return {
        latitude: unwrapValue(fields.latitude),
        longitude: unwrapValue(fields.longitude),
      };
    })
    .filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number")
    // Same (0,0) guard as generate-top-stretches.mjs -- a bump recorded
    // before the first GPS fix lands, not a real location.
    .filter((p) => !(p.latitude === 0 && p.longitude === 0));

  if (points.length === 0) {
    throw new Error("No usable bump locations found -- nothing to bound the bike-lane query to.");
  }
  return points;
}

// ---- Grouping bumps into separate ridden regions ----
// Same grid-binning idea as generate-top-stretches.mjs's clusterBumps, but
// unbounded (no MAX_STRETCH_METERS-style cap) -- here the goal is the
// opposite of that script's block-sized "stretches": keep one continuous
// ridden corridor together as a single query region.
function cellKeyFor(lat, lng) {
  const latStep = REGION_CELL_METERS / METERS_PER_DEGREE_LAT;
  const lonStep = REGION_CELL_METERS / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  const row = Math.floor(lat / latStep);
  const col = Math.floor(lng / lonStep);
  return { row, col, key: `${row},${col}` };
}

// Great-circle-ish distance between two points, in meters -- an
// equirectangular approximation, plenty accurate at street scale.
function metersBetween(lat1, lng1, lat2, lng2) {
  const latMidRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dLat = (lat2 - lat1) * METERS_PER_DEGREE_LAT;
  const dLng = (lng2 - lng1) * METERS_PER_DEGREE_LAT * Math.cos(latMidRad);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function boundsOf(points) {
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
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

// Diagonal of a bounding box, in meters -- checked against
// MAX_REGION_METERS to decide whether a merge is allowed.
function boundsDiagonalMeters(bounds) {
  return metersBetween(bounds.south, bounds.west, bounds.north, bounds.east);
}

// Union-find where each component also carries a running bounding box, and
// a union only goes through if the *combined* box still fits under
// MAX_REGION_METERS -- identical pattern to generate-top-stretches.mjs's
// BoundedUnionFind, same reason: keeps a long, mostly-continuous ride from
// flood-filling into one region with an oversized rectangular box.
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
  // the merge happened (or they were already merged), false if it was
  // rejected for exceeding the cap.
  tryUnion(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return true;

    const combined = mergeBounds(this.bounds.get(rootA), this.bounds.get(rootB));
    if (boundsDiagonalMeters(combined) > MAX_REGION_METERS) return false;

    this.parent.set(rootA, rootB);
    this.bounds.set(rootB, combined);
    return true;
  }
}

function clusterIntoRegions(points) {
  const cellsByKey = new Map(); // key -> { row, col, points: [] }
  for (const point of points) {
    const { row, col, key } = cellKeyFor(point.latitude, point.longitude);
    if (!cellsByKey.has(key)) cellsByKey.set(key, { row, col, points: [] });
    cellsByKey.get(key).points.push(point);
  }

  const uf = new BoundedUnionFind();
  for (const [key, cell] of cellsByKey) {
    uf.find(key);
    uf.bounds.set(key, boundsOf(cell.points));
  }

  const NEIGHBOR_OFFSETS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];
  // Candidate merges, deduped so each adjacent pair is only attempted once
  // regardless of which side it's visited from.
  const candidatePairs = [];
  for (const cell of cellsByKey.values()) {
    for (const [dr, dc] of NEIGHBOR_OFFSETS) {
      const neighborKey = `${cell.row + dr},${cell.col + dc}`;
      if (cellsByKey.has(neighborKey)) {
        const a = `${cell.row},${cell.col}`;
        const b = neighborKey;
        candidatePairs.push(a < b ? [a, b] : [b, a]);
      }
    }
  }

  // Repeat until a full pass makes no further merges -- merging is
  // order-sensitive near the cap (see generate-top-stretches.mjs's
  // identical comment): two components that don't fit together yet might
  // still have room to absorb a smaller neighbor first, changing what fits
  // on a later pass. Merges only ever reduce the component count, so this
  // always terminates.
  let mergedSomething = true;
  while (mergedSomething) {
    mergedSomething = false;
    for (const [a, b] of candidatePairs) {
      if (uf.find(a) === uf.find(b)) continue;
      if (uf.tryUnion(a, b)) mergedSomething = true;
    }
  }

  const groupsByRoot = new Map();
  for (const [key, cell] of cellsByKey) {
    const root = uf.find(key);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
    groupsByRoot.get(root).push(...cell.points);
  }

  return [...groupsByRoot.values()].filter((group) => group.length >= MIN_POINTS_PER_REGION);
}

function padBounds(bounds) {
  const midLat = (bounds.north + bounds.south) / 2;
  const latPad = BBOX_PADDING_METERS / METERS_PER_DEGREE_LAT;
  const lngPad = BBOX_PADDING_METERS / (METERS_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180));
  return {
    south: bounds.south - latPad,
    north: bounds.north + latPad,
    west: bounds.west - lngPad,
    east: bounds.east + lngPad,
  };
}

// ---- Overpass: bike infrastructure within a padded bbox ----
function classifyWay(tags) {
  if (tags.highway === "cycleway") return "track";
  const cyclewayValues = [tags.cycleway, tags["cycleway:left"], tags["cycleway:right"], tags["cycleway:both"]]
    .filter(Boolean);
  if (cyclewayValues.some((v) => v === "track")) return "track";
  if (cyclewayValues.some((v) => v === "lane" || v === "opposite_lane")) return "lane";
  if (cyclewayValues.some((v) => v === "shared_lane")) return "shared";
  return null; // shouldn't happen given the query filter below, but be defensive
}

// Runs the retry-with-backoff loop against ONE specific mirror URL.
// Throws once that mirror has exhausted OVERPASS_MAX_RETRIES -- the caller
// (fetchBikeLaneWays) is what moves on to the next mirror in the list.
async function queryOverpassMirror(mirrorUrl, query) {
  for (let attempt = 0; ; attempt++) {
    // A rejected fetch() (DNS hiccup, connection reset, or the server
    // refusing the connection outright once it's had enough) is a
    // different failure mode than an HTTP error response -- no `response`
    // object exists at all -- but it's just as retryable, and in practice
    // turned out to be the MORE common failure once a shared Overpass
    // instance was under enough load: a plain try/catch around the whole
    // attempt (not just the non-ok-status branch below) is what actually
    // catches it.
    let response;
    let networkErrorMessage = null;
    try {
      response = await politeFetch(mirrorUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": OVERPASS_USER_AGENT,
        },
        body: query,
      });
    } catch (error) {
      networkErrorMessage = error.message;
    }

    if (response?.ok) {
      const data = await response.json();
      return data.elements ?? [];
    }

    // 429/504 are the classic rate-limit/timeout signals; 500/502/503 are
    // generic-but-usually-transient server errors -- worth a retry rather
    // than an instant skip, since a query that worked fine on one mirror
    // 500'ing on another is a strong sign it's that server having a
    // moment, not the query.
    const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
    const retryableStatus = response && RETRYABLE_STATUSES.has(response.status);
    const retryable = networkErrorMessage !== null || retryableStatus;
    if (!retryable || attempt >= OVERPASS_MAX_RETRIES) {
      const detail = networkErrorMessage ?? `HTTP ${response.status} ${await response.text()}`;
      throw new Error(`${mirrorUrl} failed: ${detail}`);
    }
    // Exponential backoff -- a network-level refusal or any of the
    // retryable statuses above all mean this instance wants a real break,
    // not just the usual EXTERNAL_API_DELAY_MS gap.
    const delay = OVERPASS_RETRY_BASE_DELAY_MS * 2 ** attempt;
    const reason = networkErrorMessage ?? `HTTP ${response.status}`;
    console.log(`  ${mirrorUrl} ${reason}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${OVERPASS_MAX_RETRIES})...`);
    await sleep(delay);
  }
}

// Circuit breaker across the whole run: a mirror that has already
// exhausted its own retries once (a real outage, not a single blip -- a
// single blip is what the retry loop inside queryOverpassMirror is for)
// gets skipped on every later region instead of eating its full ~4-minute
// retry budget again and again for no benefit. If somehow every mirror
// ends up marked dead, the breaker resets and gives them all one more
// try -- better than permanently failing every remaining region if
// they've actually recovered by then.
const deadMirrors = new Set();

async function fetchBikeLaneWays(bbox) {
  // Overpass bbox order is south,west,north,east.
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query =
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];` +
    `(` +
      `way["highway"="cycleway"](${bboxStr});` +
      `way["cycleway"~"^(lane|track|opposite_lane|shared_lane)$"](${bboxStr});` +
      `way["cycleway:left"~"^(lane|track|shared_lane)$"](${bboxStr});` +
      `way["cycleway:right"~"^(lane|track|shared_lane)$"](${bboxStr});` +
      `way["cycleway:both"~"^(lane|track|shared_lane)$"](${bboxStr});` +
    `);` +
    `out geom;`;

  if (deadMirrors.size === OVERPASS_MIRRORS.length) {
    console.log("  All mirrors were marked dead -- giving them all one more try in case they've recovered.");
    deadMirrors.clear();
  }

  const mirrorErrors = [];
  for (const mirrorUrl of OVERPASS_MIRRORS) {
    if (deadMirrors.has(mirrorUrl)) {
      console.log(`  Skipping ${mirrorUrl} (already failed this run).`);
      continue;
    }
    try {
      return await queryOverpassMirror(mirrorUrl, query);
    } catch (error) {
      console.warn(`  ${mirrorUrl} exhausted its retries, marking it down for the rest of this run: ${error.message}`);
      deadMirrors.add(mirrorUrl);
      mirrorErrors.push(error.message);
    }
  }

  throw new Error(`All Overpass mirrors failed: ${mirrorErrors.join(" | ")}`);
}

// `out geom` gives each way's full node geometry inline, so no separate
// node-resolution pass is needed -- straight to a GeoJSON LineString.
function wayToFeature(way) {
  if (!way.geometry || way.geometry.length < 2) return null;
  const kind = classifyWay(way.tags ?? {});
  if (!kind) return null;
  return {
    type: "Feature",
    properties: {
      name: way.tags?.name ?? null,
      kind, // "track" | "lane" | "shared" -- see header comment
    },
    geometry: {
      type: "LineString",
      coordinates: way.geometry.map((pt) => [pt.lon, pt.lat]), // GeoJSON is [lng, lat]
    },
  };
}

// ---- Main ----
async function main() {
  console.log(`Fetching bump locations from Firestore project "${PROJECT_ID}"...`);
  const points = await fetchBumpPoints();
  console.log(`${points.length} usable bump locations.`);

  const regions = clusterIntoRegions(points);
  console.log(`Grouped into ${regions.length} ridden region(s) (dropped groups smaller than ${MIN_POINTS_PER_REGION} points).`);

  // Ways can legitimately turn up in more than one region's padded box if
  // two ridden areas are close together -- dedupe by OSM way id so the
  // output doesn't double-count a shared segment.
  const wayById = new Map();
  const failedRegions = [];
  let consecutiveFailures = 0;

  for (const [index, regionPoints] of regions.entries()) {
    const bbox = padBounds(boundsOf(regionPoints));
    console.log(
      `Region ${index + 1}/${regions.length}: ${regionPoints.length} bumps, ` +
      `bbox south ${bbox.south.toFixed(5)} north ${bbox.north.toFixed(5)} ` +
      `west ${bbox.west.toFixed(5)} east ${bbox.east.toFixed(5)}`
    );
    try {
      const ways = await fetchBikeLaneWays(bbox);
      console.log(`  -> Overpass returned ${ways.length} way(s).`);
      for (const way of ways) {
        wayById.set(way.id, way);
      }
      consecutiveFailures = 0;
    } catch (error) {
      // One region persistently failing (rate limit outlasting the retry
      // budget, a transient Overpass outage, etc.) shouldn't throw away
      // every other region already fetched -- log it, keep going, and
      // write out everything that did succeed. Rerunning the script picks
      // up all regions again, so a skipped one just gets tried again next
      // time.
      console.warn(`  Region ${index + 1} failed, skipping: ${error.message}`);
      failedRegions.push(index + 1);
      consecutiveFailures++;

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_COOLDOWN_THRESHOLD) {
        console.log(
          `  ${consecutiveFailures} regions failed in a row -- the shared instance is ` +
          `probably throttling this client as a whole. Cooling down for ` +
          `${Math.round(CONSECUTIVE_FAILURE_COOLDOWN_MS / 1000)}s before continuing...`
        );
        await sleep(CONSECUTIVE_FAILURE_COOLDOWN_MS);
        consecutiveFailures = 0;
      }
    }
  }

  const features = [...wayById.values()].map(wayToFeature).filter(Boolean);
  const byKind = features.reduce((counts, f) => {
    counts[f.properties.kind] = (counts[f.properties.kind] ?? 0) + 1;
    return counts;
  }, {});
  console.log(`\nBuilt ${features.length} unique lane segment(s) across all regions:`, byKind);
  if (failedRegions.length > 0) {
    console.warn(
      `${failedRegions.length} of ${regions.length} region(s) failed and were skipped ` +
      `(regions: ${failedRegions.join(", ")}) -- rerun the script to retry them.`
    );
  }

  const geojson = {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    features,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(geojson, null, 2) + "\n", "utf8");
  console.log(`Wrote ${features.length} bike lane segments to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
