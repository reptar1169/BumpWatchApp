// Shared clustering/scoring/geocoding pipeline behind
// web/bikelanebumps-site/top-stretches.json (well, now the Firestore
// topStretches/current doc -- see below). Historically all of this lived
// directly inside scripts/generate-top-stretches.mjs; it's now a plain
// CommonJS module so BOTH that script (still useful as a local/manual
// debug tool -- see its own header) AND functions/index.js's scheduled
// recomputeTopStretches function run the exact same implementation. Two
// copies of an algorithm this fiddly (grid-corrected distances, bounded
// union-find, speed-weighted scoring, multi-mirror geocoding retries) WILL
// drift eventually if one of them gets tweaked and the other doesn't --
// this file exists so that can't happen.
//
// Callers supply already-cleaned-shape bump objects --
// { latitude, longitude, magnitudeG, horizontalAccuracyMeters,
// speedMetersPerSecond, timestamp } -- however they got them (Firestore
// REST for the standalone script, the Admin SDK for the scheduled
// function); this module doesn't know or care which, except that
// `timestamp`, when present, must be a real JS Date (callers convert from
// whatever Firestore hands them). isUsableBump() and the recency-window
// filter both still run inside processAllMetros() below, so callers don't
// need to duplicate that filtering themselves.
//
// ---- Why per metro, not one global top 5 ----
// This used to rank the 5 worst stretches across every bump in Firestore,
// full stop. That's fine as long as all the data comes from one city, but
// it stops being a fair "top 5" the moment a second city's rider starts
// contributing: whichever city has the most/worst-covered riding
// dominates every slot, and the whole point of the list -- something you
// can hand to *a* city's government -- breaks for every other city. So
// this groups bumps into metro areas FIRST (see groupByMetro below), then
// runs the same per-stretch clustering independently within each metro,
// producing one top-5 pair (weighted + unweighted) per metro instead of
// one pair for the whole dataset.
//
// ---- Why metro grouping is distance-linkage, not a coordinate grid ----
// web/bikelanebumps-site/app.js's zoomed-out "city dots" view groups
// bumps with a plain coordinate-grid round (buildCityClusters) -- simple,
// but it has hard boundary lines: two points a few meters apart on
// opposite sides of a grid line land in different buckets. That's a
// harmless cosmetic quirk for a dot on a country-wide map (worst case, one
// city shows as two nearby dots) but NOT harmless here, where the "metro"
// boundary determines which stretches get listed together as one city's
// pitch. Tested against this project's own real data: San Diego's Torrey
// Pines and Clairemont/Kearny Mesa bumps, ~9km apart, land in different
// 0.2-degree grid buckets purely because they straddle a rounding
// boundary -- a grid-based version of this would have split one city's
// list into two, one of them unnamed. So metro grouping here instead uses
// distance-based single-linkage clustering (see
// groupByMetro/MAX_METRO_LINK_METERS): two bump groups merge whenever
// they're within MAX_METRO_LINK_METERS of EACH OTHER, with no fixed grid
// lines to straddle. This also deliberately does NOT reuse the
// connectivity-based (flood-fill, 8-connected-cells-only) clustering used
// for stretches below -- that model fits actual stretches because a bike
// ride is a continuous line of GPS points, so adjacent cells really are
// the same physical ride. Two neighborhoods of the same city usually
// AREN'T connected by recorded bumps in between (nobody rides every block
// linking their two favorite routes just to satisfy a clustering
// algorithm), so requiring connectivity at metro scale would wrongly
// split one city into several "metros" for a different reason. Plain
// distance -- "is this other group of bumps within a metro's worth of
// here" -- is the right model for this specific question.
//
// ---- Why "stretch" isn't just "read the bumps collection" ----
// Bumps are stored as individual GPS points, not named road segments --
// there's no "stretch" in the data model. This module constructs one:
//   1. Bin every bump into a small grid cell (~120m, latitude-corrected so
//      cells are roughly square instead of longitude-squished).
//   2. Merge 8-connected non-empty cells into clusters, capped in how far
//      a merge can grow a cluster (see MAX_STRETCH_METERS) so a
//      multi-kilometer ride doesn't flood-fill into one useless "stretch."
//   3. Score each cluster by *total* severity (sum of magnitudeG across
//      its bumps), speed-weighted (see REFERENCE_SPEED_MPS/
//      speedWeightFor) so a jolt taken at a lower speed -- implying a
//      nastier surface defect -- outranks an equal jolt taken faster.
//   4. Reverse-geocode only the winning 5-per-metro centroids (via
//      OpenStreetMap's free Nominatim API) into a human-readable name,
//      plus one extra call per metro for a human-readable metro label.

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

// A bump older than this is treated as no-longer-representative of
// CURRENT road conditions and left out of the ranking -- without deleting
// it from Firestore. This is what keeps a repaved stretch's old
// rough-road data from outranking a smooth one forever, and it does so
// automatically for every rider in every metro, with no per-ride
// bookkeeping: once enough time passes with no fresh evidence a stretch
// is still bad, it ages out on its own rather than needing someone to
// notice and flag it (see excludedFromScoring below for the manual
// override, which is still there for "I know right now, don't make me
// wait" cases).
//
// A stretch nobody has ridden within the window just won't have enough
// IN-WINDOW bumps to clear MIN_BUMPS_PER_STRETCH below, so it quietly
// drops off the list rather than being actively penalized for being
// stale -- it needs fresh confirmation to place again, same as a brand
// new stretch would. 365 days spans a full riding season in
// cold-winter metros so a quiet off-season doesn't wrongly age out a
// still-bad stretch; tune this one constant if that trade-off needs to
// move either direction.
const RECENCY_WINDOW_DAYS = 365;

// Metro grouping (see header comment) runs in two passes so the O(n^2)
// distance-linkage pass below stays cheap even with thousands of bumps:
// first bin bumps into small seed cells and work with per-cell centroids
// instead of every individual bump, then link/merge those centroids.
const METRO_SEED_CELL_METERS = 2000; // fine enough that a seed's centroid
                                      // stays a good stand-in for the bumps
                                      // inside it; coarse enough to keep
                                      // the number of seeds small.
const MAX_METRO_LINK_METERS = 40000; // 40km -- two bump groups this close
                                      // or closer are considered the same
                                      // metro. Big enough that unconnected
                                      // neighborhoods of one sprawling city
                                      // (San Diego's recorded riding
                                      // already spans close to this) still
                                      // merge into one metro; small enough
                                      // to keep genuinely separate cities
                                      // apart. NOTE: single-linkage means
                                      // this can chain -- A within range of
                                      // B within range of C merges all
                                      // three even if A and C themselves
                                      // are 80km apart. Not a concern at
                                      // the scale/spread this project
                                      // expects (a handful of riders each
                                      // covering their own city), but worth
                                      // knowing if metros ever come out
                                      // suspiciously large.

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
const TOP_N = 10; // per metro, not overall -- see header comment. The site only
                  // shows 5 by default (see app.js's renderStretchList), with a
                  // "see next 5" control revealing the rest -- computing and
                  // geocoding 10 up front means that expansion is instant, no
                  // second recompute or Firestore round-trip needed.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
// Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
// requires a real identifying User-Agent and caps free usage at 1 request/sec.
const NOMINATIM_USER_AGENT = "bikelanebumps.org top-stretches script (schoellojeff@gmail.com)";

// Nominatim tells us *the nearest road* to a point, but not what crosses it
// -- there's no "intersection" concept in a reverse-geocode response. To
// label a stretch as "Balboa Ave between X and Y" instead of just "Balboa
// Ave, Clairemont", we separately ask OpenStreetMap's Overpass API for the
// nearest *differently-named* road at each end of the stretch.
//
// Same multi-mirror-with-retry setup as generate-bike-lanes.mjs, for the
// same reason: overpass-api.de (the main instance) can IP-block a client
// outright, and this session's debugging of that script already left it in
// a bad mood -- a run of this script hit 429s and outright connection
// failures on every single cross-street lookup. Falling through to another
// mirror once the current one exhausts its retries fixes that without
// needing to babysit which URL is hardcoded in.
const OVERPASS_MIRRORS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  // private.coffee keeps just barely succeeding on retry 1 or 2 instead of
  // fully failing, so the circuit breaker never marks it dead and it never
  // falls through to the two healthier mirrors above. Tried last now so a
  // run isn't stuck waiting out its retry budget first; kept in the list
  // rather than dropped in case it recovers.
  "https://overpass.private.coffee/api/interpreter",
];
// Overpass's own usage guidance (https://wiki.openstreetmap.org/wiki/Overpass_API)
// says under 10,000 queries/day is "fine for a one-off use" and asks for an
// identifying User-Agent -- no hard per-second cap like Nominatim, but no
// reason to hammer it either.
const OVERPASS_USER_AGENT = NOMINATIM_USER_AGENT;
const CROSS_STREET_SEARCH_RADIUS_METERS = 60;
const OVERPASS_MAX_RETRIES = 4;
const OVERPASS_RETRY_BASE_DELAY_MS = 15000; // 15s/30s/60s/120s
// The query string's own [timeout:25] is a hint to the SERVER for how long
// IT should spend executing -- it does nothing if the server (or something
// in front of it) just sits on the connection without ever responding.
// Hit exactly that in production: overpass.private.coffee took multiple
// MINUTES per attempt to eventually return a 504, not 25 seconds -- so 4
// retries with backoff still added up to 40+ minutes for a single run and
// blew through the Cloud Function's own 1800s timeout before it could
// finish, let alone write anything to Firestore. A client-side abort
// bounds each attempt to a fixed worst case regardless of how badly a
// mirror is hanging, which is what actually makes OVERPASS_MAX_RETRIES and
// the mirror-to-mirror circuit breaker below behave like their numbers
// suggest instead of ballooning unpredictably.
const OVERPASS_FETCH_TIMEOUT_MS = 30000;

// Circuit breaker across the whole run -- a mirror that's already
// exhausted its retries once gets skipped on every later cross-street
// lookup instead of eating its full retry budget again and again. This
// script only makes a handful of Overpass calls total (2 per stretch), so
// the cost of one bad mirror is smaller than in generate-bike-lanes.mjs,
// but there's no reason to pay it more than once either.
const deadOverpassMirrors = new Set();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// See RECENCY_WINDOW_DAYS above. A bump with no usable timestamp (older
// data predating the field, or a parsing hiccup upstream) is let through
// rather than silently dropped -- a schema gap shouldn't quietly erase
// data that was never actually flagged as stale.
function isWithinRecencyWindow(bump, cutoffMs) {
  if (!(bump.timestamp instanceof Date) || Number.isNaN(bump.timestamp.getTime())) return true;
  return bump.timestamp.getTime() >= cutoffMs;
}

// ---- Grid math shared by both clustering passes ----
const METERS_PER_DEGREE_LAT = 111_320;

// Latitude-corrected grid cell containing (lat, lng), at the given cell
// size in meters -- shared by metro seeding (METRO_SEED_CELL_METERS) and
// stretch clustering (CELL_METERS) below, just at different scales.
function cellKeyFor(lat, lng, cellMeters) {
  const latStep = cellMeters / METERS_PER_DEGREE_LAT;
  const lonStep = cellMeters / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  const row = Math.floor(lat / latStep);
  const col = Math.floor(lng / lonStep);
  return { row, col, key: `${row},${col}` };
}

// Great-circle-ish distance between two points, in meters -- an
// equirectangular approximation, which is plenty accurate at the
// block-to-metro scale this script works at.
function metersBetween(lat1, lng1, lat2, lng2) {
  const latMidRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dLat = (lat2 - lat1) * METERS_PER_DEGREE_LAT;
  const dLng = (lng2 - lng1) * METERS_PER_DEGREE_LAT * Math.cos(latMidRad);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function centroidOf(bumps) {
  const lat = bumps.reduce((sum, b) => sum + b.latitude, 0) / bumps.length;
  const lng = bumps.reduce((sum, b) => sum + b.longitude, 0) / bumps.length;
  return { lat, lng };
}

// ---- Metro grouping ----
// Plain (uncapped) union-find -- unlike BoundedUnionFind below, a metro
// merge has no per-merge size cap to check, just "are these two seeds
// within MAX_METRO_LINK_METERS." See header comment for why distance
// linkage instead of a coordinate grid.
class UnionFind {
  constructor() {
    this.parent = new Map();
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
  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

// Groups bumps into metro areas via two-pass single-linkage clustering --
// see the header comment for why this replaced a coordinate-grid bucket.
function groupByMetro(bumps) {
  // Pass 1: bin into small seed cells so pass 2's O(n^2) distance checks
  // run over a manageable number of points instead of every bump.
  const seedCells = new Map(); // key -> bump[]
  for (const bump of bumps) {
    const { key } = cellKeyFor(bump.latitude, bump.longitude, METRO_SEED_CELL_METERS);
    if (!seedCells.has(key)) seedCells.set(key, []);
    seedCells.get(key).push(bump);
  }
  const seeds = [...seedCells.entries()].map(([key, cellBumps]) => ({
    key,
    centroid: centroidOf(cellBumps),
  }));

  // Pass 2: merge any two seeds within MAX_METRO_LINK_METERS of each
  // other. No adjacency/connectivity requirement -- see header comment on
  // why metro grouping is plain distance, not the flood-fill model used
  // for stretches.
  const uf = new UnionFind();
  for (const seed of seeds) uf.find(seed.key);
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const distance = metersBetween(
        seeds[i].centroid.lat, seeds[i].centroid.lng,
        seeds[j].centroid.lat, seeds[j].centroid.lng
      );
      if (distance <= MAX_METRO_LINK_METERS) uf.union(seeds[i].key, seeds[j].key);
    }
  }

  const groups = new Map(); // root -> bump[]
  for (const [key, cellBumps] of seedCells) {
    const root = uf.find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(...cellBumps);
  }
  return [...groups.values()];
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

// Runs the block-level connectivity clustering described in the header
// comment on a single metro's bumps. Called once per metro group -- each
// call builds its own local grid, so results from one metro never bleed
// into another's (which also means a stretch straddling two different
// metros' rounding buckets can't happen: METRO_GRID_DEGREES is coarse
// enough, and MAX_STRETCH_METERS small enough, that no single stretch is
// anywhere near the metro grid's cell size).
function clusterBumps(bumps) {
  const cellsByKey = new Map(); // key -> { row, col, bumps: [] }

  for (const bump of bumps) {
    const { row, col, key } = cellKeyFor(bump.latitude, bump.longitude, CELL_METERS);
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

// A stretch ridden N times racks up roughly N times the bumps and total
// severity of the same stretch ridden once, even if it's genuinely no
// worse per ride -- so ranking by a raw total effectively rewards "ridden
// more often" over "actually worse," and a frequently-ridden mediocre
// stretch can bump a rarely-ridden but far worse one out of the top N.
// Dividing by how many DISTINCT rides contributed (not bump count, which
// scales with rides for the same reason) corrects for that: two rides
// each hitting the same 10 bumps score the same as one ride hitting those
// 10 bumps once, rather than double. Falls back to 1 if no bump in the
// cluster carries a rideId (shouldn't happen given the schema, but scoring
// shouldn't divide by zero over it).
function countDistinctRides(bumps) {
  const rideIds = new Set(bumps.map((b) => b.rideId).filter(Boolean));
  return rideIds.size || 1;
}

function summarizeCluster(bumps) {
  const count = bumps.length;
  const totalSeverityG = bumps.reduce((sum, b) => sum + b.magnitudeG, 0);
  const avgSeverityG = totalSeverityG / count;
  const rideCount = countDistinctRides(bumps);

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
    rideCount,
    // Per-ride, not per-cluster totals -- see countDistinctRides above for
    // why. These two are what actually drive ranking; totalSeverityG
    // itself never gets divided, since it's still shown to readers as a
    // literal "N bumps, X.Xg total" figure and needs to stay that.
    score: weightedSeverityG / rideCount,
    unweightedScore: totalSeverityG / rideCount,
  };
}

// ---- Reverse geocoding (top N per metro, plus one metro label each) ----
async function reverseGeocode(lat, lng, zoom) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", String(zoom));
  url.searchParams.set("addressdetails", "1");

  const response = await politeFetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Nominatim reverse geocode failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function reverseGeocodeStretch(lat, lng) {
  const data = await reverseGeocode(lat, lng, 17); // road-level detail, not building-level
  const address = data.address ?? {};
  return {
    road: address.road || address.pedestrian || address.cycleway || null,
    locality: address.suburb || address.neighbourhood || address.city || address.town || null,
    displayName: data.display_name ?? null,
  };
}

// One call per metro (not per stretch) at a coarser zoom, purely to get a
// human-readable "City, State" label for grouping the list on the page --
// separate from reverseGeocodeStretch's road-level lookup above, which
// answers a different question ("what street is this stretch on").
async function reverseGeocodeMetroLabel(lat, lng) {
  const data = await reverseGeocode(lat, lng, 10); // city-level detail
  const address = data.address ?? {};
  const place = address.city || address.town || address.village || address.county || null;
  if (!place) return data.display_name ?? null;
  return address.state ? `${place}, ${address.state}` : place;
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

// Retries ONE specific mirror with exponential backoff. Throws once that
// mirror has exhausted OVERPASS_MAX_RETRIES -- the caller
// (findNearbyCrossStreet) is what moves on to the next mirror.
async function queryOverpassMirror(mirrorUrl, query) {
  for (let attempt = 0; ; attempt++) {
    // A rejected fetch() (network-level refusal, not an HTTP response) is
    // just as retryable as a 429/5xx -- see generate-bike-lanes.mjs's
    // identical comment; that was the more common failure mode in
    // practice once a mirror was under real load.
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
        // AbortSignal.timeout rejects with a DOMException ("TimeoutError")
        // once this fires, which the catch below treats the same as any
        // other network-level failure -- retryable, same as a rejected
        // fetch() already was.
        signal: AbortSignal.timeout(OVERPASS_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      networkErrorMessage = error.message;
    }

    if (response?.ok) return response.json();

    const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
    const retryableStatus = response && RETRYABLE_STATUSES.has(response.status);
    const retryable = networkErrorMessage !== null || retryableStatus;
    if (!retryable || attempt >= OVERPASS_MAX_RETRIES) {
      const detail = networkErrorMessage ?? `HTTP ${response.status}`;
      throw new Error(`${mirrorUrl} failed: ${detail}`);
    }
    const delay = OVERPASS_RETRY_BASE_DELAY_MS * 2 ** attempt;
    const reason = networkErrorMessage ?? `HTTP ${response.status}`;
    console.warn(`    ${mirrorUrl} ${reason}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${OVERPASS_MAX_RETRIES})...`);
    await sleep(delay);
  }
}

async function findNearbyCrossStreet(lat, lng, ownRoadName) {
  const query =
    `[out:json][timeout:25];` +
    `way(around:${CROSS_STREET_SEARCH_RADIUS_METERS},${lat},${lng})` +
    `[highway~"^(${CROSS_STREET_HIGHWAY_TYPES})$"][name];` +
    `out center tags;`;

  if (deadOverpassMirrors.size === OVERPASS_MIRRORS.length) {
    deadOverpassMirrors.clear(); // give them all one more try in case they've recovered
  }

  let data = null;
  const mirrorErrors = [];
  for (const mirrorUrl of OVERPASS_MIRRORS) {
    if (deadOverpassMirrors.has(mirrorUrl)) continue;
    try {
      data = await queryOverpassMirror(mirrorUrl, query);
      break;
    } catch (error) {
      deadOverpassMirrors.add(mirrorUrl);
      mirrorErrors.push(error.message);
    }
  }
  if (data === null) {
    throw new Error(`All Overpass mirrors failed: ${mirrorErrors.join(" | ")}`);
  }

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

function fallbackMetroName(lat, lng) {
  return `Unnamed metro area near ${lat.toFixed(2)}, ${lng.toFixed(2)}`;
}

// Geocodes one cluster into its final stretch entry -- pulled out of
// processMetro() so it can be called once per DISTINCT cluster, then
// shared between the weighted and unweighted rankings below when the same
// stretch happens to place in both (e.g. the Balboa Ave stretches tend to
// rank highly either way, within their own metro). Nominatim/Overpass
// lookups aren't cheap, so this dedup matters.
async function buildStretchEntry(cluster) {
  const { summary, bumps } = cluster;
  const speedNote = summary.avgSpeedMph == null ? "unknown avg speed" : `avg ${summary.avgSpeedMph}mph`;
  console.log(
    `    Geocoding: ${summary.count} bumps, total ${summary.totalSeverityG}g (${speedNote}), ` +
    `speed-weighted score ${Math.round(summary.score * 100) / 100} ` +
    `at (${summary.centroid.lat.toFixed(5)}, ${summary.centroid.lng.toFixed(5)})...`
  );

  let geocode = { road: null, locality: null, displayName: null };
  try {
    geocode = await reverseGeocodeStretch(summary.centroid.lat, summary.centroid.lng);
  } catch (error) {
    console.warn(`      centroid geocode failed: ${error.message}`);
  }

  // Only bother looking up cross streets if we actually got a road name to
  // pair them with -- "between X and Y" means nothing without knowing
  // which road it's a stretch of.
  let crossStreetA = null;
  let crossStreetB = null;
  if (geocode.road) {
    const [endpointA, endpointB] = findClusterEndpoints(bumps);
    try {
      crossStreetA = await findNearbyCrossStreet(endpointA.latitude, endpointA.longitude, geocode.road);
    } catch (error) {
      console.warn(`      cross-street lookup (end A) failed: ${error.message}`);
    }
    try {
      crossStreetB = await findNearbyCrossStreet(endpointB.latitude, endpointB.longitude, geocode.road);
    } catch (error) {
      console.warn(`      cross-street lookup (end B) failed: ${error.message}`);
    }
  }

  const name =
    buildStretchName(geocode, crossStreetA, crossStreetB) ??
    fallbackName(summary.centroid.lat, summary.centroid.lng);

  console.log(`      -> ${name}`);

  return {
    name,
    lat: summary.centroid.lat,
    lng: summary.centroid.lng,
    bounds: summary.bounds,
    bumpCount: summary.count,
    totalSeverityG: summary.totalSeverityG,
    avgSeverityG: summary.avgSeverityG,
    avgSpeedMph: summary.avgSpeedMph,
    // Exposed mainly so a reader (or a future UI) can tell "one bad ride"
    // apart from "corroborated across N rides" -- see countDistinctRides.
    rideCount: summary.rideCount,
  };
}

// Runs the full stretch pipeline (cluster -> rank -> geocode) for one
// metro's bumps. Returns null if nothing in this metro clears
// MIN_BUMPS_PER_STRETCH -- callers skip the metro entirely rather than
// including an empty entry (and, notably, never spend a metro-label
// geocode call on a metro with nothing to report).
async function processMetro(metroBumps) {
  const clusters = clusterBumps(metroBumps)
    .map((bumps) => ({ bumps, summary: summarizeCluster(bumps) }))
    .filter((cluster) => cluster.summary.count >= MIN_BUMPS_PER_STRETCH);

  if (clusters.length === 0) return null;

  // Two independent rankings of the SAME clusters -- speed-weighted score
  // (see speedWeightFor above) vs. plain total severity. These can and do
  // surface different top 5s, not just reorder the same one: a stretch
  // ridden consistently slower can place in the weighted top 5 without
  // having enough raw severity to place in the unweighted one, and vice
  // versa. That's the whole point of offering both on the site.
  const weightedRanked = [...clusters].sort((a, b) => b.summary.score - a.summary.score).slice(0, TOP_N);
  const unweightedRanked = [...clusters]
    .sort((a, b) => b.summary.unweightedScore - a.summary.unweightedScore)
    .slice(0, TOP_N);

  // Geocode each DISTINCT cluster needed by either list exactly once --
  // cluster objects are unique by reference (see the .map() above), so a
  // Set built on the object itself is a clean way to dedupe a cluster that
  // lands in both of this metro's top 5s.
  const distinctClusters = [...new Set([...weightedRanked, ...unweightedRanked])];

  const entryByCluster = new Map();
  for (const cluster of distinctClusters) {
    entryByCluster.set(cluster, await buildStretchEntry(cluster));
  }

  const metroCentroid = centroidOf(metroBumps);
  let metroName;
  try {
    metroName = await reverseGeocodeMetroLabel(metroCentroid.lat, metroCentroid.lng);
  } catch (error) {
    console.warn(`    metro label geocode failed: ${error.message}`);
  }
  metroName ??= fallbackMetroName(metroCentroid.lat, metroCentroid.lng);

  // Total bumps across ALL qualifying clusters in this metro (not just the
  // top 5), used only to sort the metro list itself -- the most-ridden
  // metro leads the page.
  const totalBumps = clusters.reduce((sum, c) => sum + c.summary.count, 0);

  return {
    name: metroName,
    lat: metroCentroid.lat,
    lng: metroCentroid.lng,
    weighted: weightedRanked.map((cluster) => entryByCluster.get(cluster)),
    unweighted: unweightedRanked.map((cluster) => entryByCluster.get(cluster)),
    totalBumps, // internal-only, dropped before writing output
  };
}

// ---- Entry point ----
// Runs the full pipeline over an already-fetched, not-yet-cleaned bump
// list and returns { metros }, ready to write into Firestore (the
// scheduled function) or wrap with a generatedAt timestamp and save to
// disk (the standalone script). Does no fetching and no writing itself --
// see the header comment for why that split exists.
async function processAllMetros(rawBumps) {
  const usableBumps = rawBumps.filter(isUsableBump);
  console.log(`${usableBumps.length} usable after dropping (0,0)/low-accuracy fixes (of ${rawBumps.length} total).`);

  const recencyCutoffMs = Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentBumps = usableBumps.filter((bump) => isWithinRecencyWindow(bump, recencyCutoffMs));
  console.log(
    `${recentBumps.length} within the ${RECENCY_WINDOW_DAYS}-day recency window (of ${usableBumps.length} usable).`
  );

  const metroGroups = groupByMetro(recentBumps);
  console.log(`${metroGroups.length} rough metro area(s) of bumps to process.`);

  const metros = [];
  for (const [index, metroBumps] of metroGroups.entries()) {
    console.log(`\nMetro ${index + 1}/${metroGroups.length}: ${metroBumps.length} bumps.`);
    const metro = await processMetro(metroBumps);
    if (metro === null) {
      console.log(`  Nothing clears ${MIN_BUMPS_PER_STRETCH}+ bumps per stretch here yet -- skipping.`);
      continue;
    }
    console.log(`  -> ${metro.name}`);
    metros.push(metro);
  }

  // Most-ridden metro first.
  metros.sort((a, b) => b.totalBumps - a.totalBumps);
  for (const metro of metros) delete metro.totalBumps; // internal sort key only

  return { metros };
}

module.exports = {
  processAllMetros,
  isUsableBump,
  isWithinRecencyWindow,
  RECENCY_WINDOW_DAYS,
  groupByMetro,
  clusterBumps,
  summarizeCluster,
};
