const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const {
  findShareTarget,
  renderShareImage,
  buildSharePageHtml,
  buildFallbackPageHtml,
} = require("./shareCard");

initializeApp();
const db = getFirestore();

// Set with:
//   firebase functions:secrets:set BUMPWATCH_API_KEY
// then paste the same value into UploadService.apiKey in the watch app.
//
// This is now the LEGACY auth path -- kept only so already-installed copies
// of the app (which can't be retroactively changed) keep uploading while
// the new build works its way through App Review and adoption. See
// authenticateRequest() below and the README's "Auth: transition plan"
// section for when/how to retire this.
const API_KEY = defineSecret("BUMPWATCH_API_KEY");

const MAX_BATCH_SIZE = 450; // Firestore batch limit is 500 writes; leave headroom.

// A real ride's bump count is bounded by how many peak-detector events a
// few hours of pedaling can produce -- realistically well under a thousand
// even for a long, rough ride. This isn't a precise physical limit, just a
// generous ceiling that rejects an obviously-abusive payload (a scripted
// flood of fake bumps) before it costs a few hundred Firestore writes.
// Only worth having now that the app is public on the App Store rather
// than just running on Jeff's own Watch.
const MAX_BUMPS_PER_RIDE = 5000;

// ---- Route points ("ride coverage" -- see functions/topStretchesCore.js's
// sibling doc, the map's ride-coverage layer) ----
// A route point is a periodic GPS sample taken throughout the ride,
// independent of bump detection -- see RoutePoint in both watch apps'
// RideManager. Unlike bumps, these don't need per-point Firestore queries
// (the map always reads a whole ride's route at once, never one point at a
// time), so they're stored as a single array field on the ride doc itself
// rather than a subcollection -- no batching needed, same request that
// already writes the ride's metadata.
const MAX_ROUTE_POINTS_PER_RIDE = 3000; // mirrors both watch apps'
                                         // client-side cap -- keeps a
                                         // malformed or abusive payload
                                         // bounded even if a client's own
                                         // cap is bypassed.

// A route is a far bigger privacy exposure than a scattered bump point --
// it's the shape of somewhere a specific person actually went, and a route
// that starts or ends at a house is a home address, especially on a quiet
// block with only one or two riders. This trims every point within this
// radius of the route's own first/last point before it's ever written to
// Firestore, the same way Strava's privacy zones work. A ride short enough
// that its whole route sits inside 2x this radius trims away to nothing --
// intentional: better an empty route than one that's essentially all
// "near home."
const ROUTE_ENDPOINT_TRIM_METERS = 150;

const METERS_PER_DEGREE_LAT = 111_320; // same constant topStretchesCore.js
                                        // uses for its own grid math.

function metersBetween(a, b) {
  const latMidRadians = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const dLat = (a.latitude - b.latitude) * METERS_PER_DEGREE_LAT;
  const dLng = (a.longitude - b.longitude) * METERS_PER_DEGREE_LAT * Math.cos(latMidRadians);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// Trims by straight-line radius from the route's own endpoint, not
// cumulative distance traveled -- deliberately, so a loop ride that passes
// back near its own start mid-route gets that pass trimmed too, instead of
// only ever protecting the first/last few minutes of travel time.
function trimRouteEndpoints(points) {
  if (points.length === 0) return [];

  const originStart = points[0];
  let startIdx = 0;
  while (
    startIdx < points.length &&
    metersBetween(points[startIdx], originStart) < ROUTE_ENDPOINT_TRIM_METERS
  ) {
    startIdx++;
  }

  const originEnd = points[points.length - 1];
  let endIdx = points.length - 1;
  while (endIdx >= 0 && metersBetween(points[endIdx], originEnd) < ROUTE_ENDPOINT_TRIM_METERS) {
    endIdx--;
  }

  if (startIdx > endIdx) return [];
  return points.slice(startIdx, endIdx + 1);
}

// ---- Auth ----
// Two accepted forms, checked in this order:
//   1. `Authorization: Bearer <Firebase ID token>` -- the new per-rider
//      path. The Watch signs in anonymously via the Identity Toolkit REST
//      API (see AuthService.swift; the Firebase Auth SDK itself doesn't
//      support watchOS) and sends the resulting ID token here, verified
//      with the Admin SDK. This is what every NEW build of the app uses.
//   2. `X-Api-Key: <shared secret>` -- the original single-key guard from
//      when this was a personal, single-user project. Kept working only
//      for the transition described above; carries no per-rider identity
//      (uid stays null on rides submitted this way).
// Anything matching neither is rejected. Returns a discriminated result
// rather than throwing so the caller can produce a specific 401 message.
async function authenticateRequest(req) {
  const authHeader = req.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const idToken = authHeader.slice("Bearer ".length).trim();
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      return { ok: true, uid: decoded.uid, via: "auth" };
    } catch (error) {
      logger.warn("ID token verification failed", error);
      return { ok: false, message: "Invalid or expired auth token" };
    }
  }

  if (req.get("X-Api-Key") === API_KEY.value()) {
    return { ok: true, uid: null, via: "legacy-key" };
  }

  return { ok: false, message: "Unauthorized" };
}

/**
 * Receives a finished ride (metadata + bump array) from the watch app and
 * writes it into Firestore:
 *   rides/{rideId}                     -- ride metadata
 *   rides/{rideId}/bumps/{autoId}       -- one doc per bump, with absolute
 *                                          timestamp + lat/lng, ready to
 *                                          query for the heatmap.
 *
 * This exists as an HTTPS relay (rather than having the watch write to
 * Firestore directly) because the Firestore client SDK does not support
 * watchOS. A plain HTTPS POST works from any platform.
 */
exports.submitRide = onRequest(
  { region: "us-east1", secrets: [API_KEY], cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const authResult = await authenticateRequest(req);
    if (!authResult.ok) {
      res.status(401).send(authResult.message);
      return;
    }

    const ride = req.body;
    if (!ride || typeof ride.id !== "string" || !Array.isArray(ride.bumps)) {
      res.status(400).send("Malformed ride payload");
      return;
    }
    if (ride.bumps.length > MAX_BUMPS_PER_RIDE) {
      res.status(400).send(`Ride payload too large (max ${MAX_BUMPS_PER_RIDE} bumps)`);
      return;
    }

    const rawRoutePoints = Array.isArray(ride.routePoints) ? ride.routePoints : [];
    if (rawRoutePoints.length > MAX_ROUTE_POINTS_PER_RIDE) {
      res.status(400).send(`Ride route too large (max ${MAX_ROUTE_POINTS_PER_RIDE} points)`);
      return;
    }
    // Same "drop the bad ones, don't fail the whole ride" approach
    // topStretchesCore.js's isUsableBump takes with bumps -- a malformed
    // point (missing field, the (0,0) no-fix sentinel) is just excluded
    // from the route rather than rejecting an otherwise-good upload.
    const cleanedRoutePoints = rawRoutePoints
      .filter(
        (p) =>
          p &&
          typeof p.latitude === "number" &&
          typeof p.longitude === "number" &&
          typeof p.rideElapsedSeconds === "number" &&
          !(p.latitude === 0 && p.longitude === 0)
      )
      .map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        rideElapsedSeconds: p.rideElapsedSeconds,
      }));
    const routePoints = trimRouteEndpoints(cleanedRoutePoints);

    const startTime = new Date(ride.startTime);
    const endTime = ride.endTime ? new Date(ride.endTime) : null;
    if (isNaN(startTime.getTime())) {
      res.status(400).send("Invalid startTime");
      return;
    }

    try {
      const rideRef = db.collection("rides").doc(ride.id);
      await rideRef.set(
        {
          startTime,
          endTime,
          bumpCount: ride.bumps.length,
          routePoints,
          averageHeartRateBPM:
            typeof ride.averageHeartRateBPM === "number" ? ride.averageHeartRateBPM : null,
          maxHeartRateBPM:
            typeof ride.maxHeartRateBPM === "number" ? ride.maxHeartRateBPM : null,
          receivedAt: FieldValue.serverTimestamp(),
          // uid is null for rides submitted via the legacy API key (no
          // per-rider identity available that way) -- see
          // authenticateRequest() above.
          submittedByUid: authResult.uid,
          submittedVia: authResult.via,
        },
        { merge: true }
      );

      const bumpsRef = rideRef.collection("bumps");

      for (let offset = 0; offset < ride.bumps.length; offset += MAX_BATCH_SIZE) {
        const batch = db.batch();
        const chunk = ride.bumps.slice(offset, offset + MAX_BATCH_SIZE);

        for (const bump of chunk) {
          if (
            typeof bump.latitude !== "number" ||
            typeof bump.longitude !== "number" ||
            typeof bump.magnitudeG !== "number"
          ) {
            continue; // skip malformed entries rather than failing the whole ride
          }
          const bumpTime = new Date(
            startTime.getTime() + (bump.rideElapsedSeconds ?? 0) * 1000
          );
          const docRef = bumpsRef.doc();
          batch.set(docRef, {
            rideId: ride.id,
            timestamp: bumpTime,
            magnitudeG: bump.magnitudeG,
            location: new (require("firebase-admin/firestore").GeoPoint)(
              bump.latitude,
              bump.longitude
            ),
            latitude: bump.latitude,
            longitude: bump.longitude,
            horizontalAccuracyMeters: bump.horizontalAccuracyMeters ?? null,
            speedMetersPerSecond: bump.speedMetersPerSecond ?? null,
            headingDegrees: bump.headingDegrees ?? null,
            heartRateBPM: typeof bump.heartRateBPM === "number" ? bump.heartRateBPM : null,
          });
        }
        await batch.commit();
      }

      logger.info(
        `Stored ride ${ride.id} with ${ride.bumps.length} bumps (via ${authResult.via})`
      );
      res.status(200).json({ ok: true, rideId: ride.id, bumps: ride.bumps.length });
    } catch (error) {
      logger.error("Failed to store ride", error);
      res.status(500).send("Internal error");
    }
  }
);

// ---- Scheduled recompute: top-stretches ----
// Runs the same clustering/scoring/geocoding pipeline as
// scripts/generate-top-stretches.mjs (imported from topStretchesCore.js,
// the shared implementation both use -- see that file's header comment)
// automatically overnight, and writes the result into Firestore instead of
// a static file the website reads at build time. This is what replaces
// "rerun the script by hand, review the JSON, redeploy hosting" for
// top-stretches specifically -- see the README for why bike-lane
// generation (scripts/generate-bike-lanes.mjs) is NOT included here yet.
//
// Once a night is already deliberately conservative: this pipeline makes
// real calls to Nominatim (1/sec) and Overpass (rate-limited, multi-mirror
// with retries) for every stretch across every metro. While the app has
// few enough riders that most nights get zero new rides, most of those
// nightly runs would just regenerate the exact same result -- so
// recomputeTopStretches below skips the night entirely (no Nominatim/
// Overpass calls, no Firestore write) unless a ride has actually landed
// since the last successful recompute. See hasNewRideSinceLastRecompute()
// and forceRecomputeTopStretches (further down) for the escape hatch this
// gate needs: the Firebase console's "Force run" button just re-fires
// this same scheduled trigger, so it would ALSO get skipped on a quiet
// night -- forceRecomputeTopStretches is a separate, always-unconditional
// endpoint for retesting a code change against existing data without
// waiting for (or faking) a new ride. Nothing about any of this requires
// nightly specifically -- adjust the schedule below if that cadence stops
// fitting how fast new cities/riders show up.
const { processAllMetros } = require("./topStretchesCore");

// True if a ride has been saved since the last successful recompute (or if
// there's no record of a successful recompute yet at all). Deliberately
// timestamp-comparison rather than a hand-maintained "dirty" flag written
// by submitRide -- one less write on the ride-upload hot path, and it
// self-heals from existing data instead of silently skipping forever if a
// flag write ever failed or got missed.
async function hasNewRideSinceLastRecompute() {
  const [latestRideSnap, currentSnap] = await Promise.all([
    db.collection("rides").orderBy("receivedAt", "desc").limit(1).get(),
    db.collection("topStretches").doc("current").get(),
  ]);

  if (latestRideSnap.empty) return false; // no rides recorded at all -- nothing to compute yet

  const latestRideAt = latestRideSnap.docs[0].data().receivedAt;
  if (!latestRideAt) return true; // shouldn't happen, but don't let a missing field mean "skip forever"

  const lastGeneratedAt = currentSnap.exists ? currentSnap.data().generatedAt : null;
  if (!lastGeneratedAt) return true; // never successfully recomputed -- definitely run

  return latestRideAt.toMillis() > lastGeneratedAt.toMillis();
}

// The actual recompute -- pulled out of recomputeTopStretches below so
// forceRecomputeTopStretches can run the exact same pipeline unconditionally,
// without duplicating it.
async function runTopStretchesRecompute() {
  logger.info("recomputeTopStretches: starting");
  const bumps = await fetchAllBumpsForRecompute();
  logger.info(`recomputeTopStretches: fetched ${bumps.length} bump documents`);

  const { metros } = await processAllMetros(bumps, { log: (msg) => logger.info(msg) });

  await db.collection("topStretches").doc("current").set({
    generatedAt: FieldValue.serverTimestamp(),
    metros,
  });

  logger.info(`recomputeTopStretches: wrote ${metros.length} metro area(s) to Firestore`);
}

async function fetchAllBumpsForRecompute() {
  // Rides flagged excludedFromScoring (set by hand on the ride doc in the
  // Firestore console) are left in Firestore untouched, but their bumps
  // are skipped here so a repaved-over ride's old bump data stops
  // influencing the nightly top-stretches recompute. Nothing is deleted;
  // this only affects which bumps feed the scoring pipeline.
  const [bumpsSnapshot, ridesSnapshot] = await Promise.all([
    db.collectionGroup("bumps").get(),
    db.collection("rides").get(),
  ]);

  const excludedRideIds = new Set(
    ridesSnapshot.docs
      .filter((doc) => doc.data().excludedFromScoring === true)
      .map((doc) => doc.id)
  );

  return bumpsSnapshot.docs
    .filter((doc) => !excludedRideIds.has(doc.ref.parent.parent.id))
    .map((doc) => {
      const data = doc.data();
      return {
        latitude: typeof data.latitude === "number" ? data.latitude : null,
        longitude: typeof data.longitude === "number" ? data.longitude : null,
        magnitudeG: typeof data.magnitudeG === "number" ? data.magnitudeG : null,
        horizontalAccuracyMeters:
          typeof data.horizontalAccuracyMeters === "number" ? data.horizontalAccuracyMeters : null,
        speedMetersPerSecond:
          typeof data.speedMetersPerSecond === "number" ? data.speedMetersPerSecond : null,
        // Admin SDK hands back a Firestore Timestamp -- topStretchesCore's
        // recency-window filter wants a plain JS Date (see its header
        // comment on the shared bump shape).
        timestamp: typeof data.timestamp?.toDate === "function" ? data.timestamp.toDate() : null,
        // A bump doc's parent is always rides/{rideId} (see the schema
        // comment above) -- topStretchesCore uses this to tell "one road
        // ridden many times" apart from "one ride that hit a lot of
        // bumps," which a raw bump-count/severity total can't distinguish
        // on its own (see its own comment on rideCount for why that
        // matters).
        rideId: doc.ref.parent.parent.id,
      };
    });
}

// ---- Share cards for the top-5 "priority stretches" list ----
// See shareCard.js's header comment for why this needs to be a real
// server response rather than something the client-rendered site can
// produce on its own -- Facebook/X read static <meta> tags, they don't
// run the site's JS.
//
// Firebase Hosting rewrites /share/** to this one function (see
// firebase.json), so everything after the "/share/" prefix -- both the
// crawler-facing HTML page and its /image.png -- is parsed and dispatched
// right here rather than by any router.
const SITE_ORIGIN = "https://www.bikelanebumps.org";
const SHARE_PATH_PATTERN = /^\/share\/([^/]+)\/(weighted|unweighted)\/(\d+)(\/image\.png)?\/?$/;

exports.shareCard = onRequest({ region: "us-east1", cors: false }, async (req, res) => {
  const match = req.path.match(SHARE_PATH_PATTERN);
  if (!match) {
    res.status(404).set("Content-Type", "text/html").send(buildFallbackPageHtml(SITE_ORIGIN));
    return;
  }
  const [, metroSlugParam, mode, rankParam, isImageRequest] = match;

  let metros = [];
  try {
    const snapshot = await db.collection("topStretches").doc("current").get();
    if (snapshot.exists) {
      const data = snapshot.data();
      metros = Array.isArray(data.metros) ? data.metros : [];
    }
  } catch (error) {
    // A read failure shouldn't 500 a link someone's actively sharing --
    // fall through to the same "not found" handling as a stale/bad slug.
    logger.error("shareCard: failed to read topStretches/current", error);
  }

  const target = findShareTarget(metros, metroSlugParam, mode, rankParam);
  if (!target) {
    // Covers both a genuinely malformed slug/rank AND a share link to a
    // stretch that no longer places in its metro's top 5 after a nightly
    // recompute -- either way, there's nothing to render, so send whoever
    // (or whatever crawler) followed the link back to the current list
    // rather than a bare error.
    res.status(404).set("Content-Type", "text/html").send(buildFallbackPageHtml(SITE_ORIGIN));
    return;
  }

  // topStretches/current only changes once a night -- an hour of caching
  // means a crawler re-fetching a link preview it already has doesn't
  // regenerate the same PNG/HTML on every hit, without risking a stale
  // response sticking around long past the next recompute.
  res.set("Cache-Control", "public, max-age=3600");

  if (isImageRequest) {
    const buf = renderShareImage({
      rank: target.rank,
      metroName: target.metro.name,
      stretchName: target.stretch.name,
      bumpCount: target.stretch.bumpCount,
      avgSeverityG: target.stretch.avgSeverityG,
    });
    res.set("Content-Type", "image/png");
    res.status(200).send(buf);
    return;
  }

  const html = buildSharePageHtml({
    siteOrigin: SITE_ORIGIN,
    metroSlugParam,
    mode,
    rank: target.rank,
    metro: target.metro,
    stretch: target.stretch,
  });
  res.set("Content-Type", "text/html");
  res.status(200).send(html);
});

exports.recomputeTopStretches = onSchedule(
  {
    schedule: "0 9 * * *", // ~1-2am US Pacific, adjust freely -- see comment above
    region: "us-east1",
    // 300s was the original guess here and it was wrong -- a real run hit
    // overpass.private.coffee during a multi-minute 500/502 outage and the
    // FIRST invocation didn't even finish geocoding its first stretch
    // before Cloud Run killed it at the 300s mark. 1800s gives real
    // headroom for a bad mirror day (multiple retries at 15/30/60/120s
    // backoff, across several stretches) without needing to redesign the
    // retry/circuit-breaker logic itself. Worth knowing this is still not
    // an absolute guarantee -- a sufficiently prolonged full outage across
    // ALL THREE Overpass mirrors could in principle still exceed even
    // this, since the circuit breaker clears and retries everything once
    // all three go dead (see deadOverpassMirrors in topStretchesCore.js) --
    // but that's a much rarer failure mode than what actually happened
    // here, and missing one night's recompute is harmless regardless (see
    // header comment).
    timeoutSeconds: 1800,
    memory: "512MiB",
    // Explicit rather than relying on the default -- a failed run isn't
    // urgent (there's always tomorrow night, or forceRecomputeTopStretches), and
    // an automatic retry piling a second concurrent invocation onto an
    // already-struggling Overpass mirror is actively counterproductive,
    // which is part of what happened during the incident described above.
    retryCount: 0,
  },
  async () => {
    if (!(await hasNewRideSinceLastRecompute())) {
      logger.info("recomputeTopStretches: no new rides since the last recompute, skipping");
      return;
    }
    await runTopStretchesRecompute();
  }
);

// ---- Manual, unconditional recompute (bypasses the gate above) ----
// recomputeTopStretches skips a night where nothing changed, but the
// Firebase console's "Force run" re-fires that exact same scheduled
// trigger with no way to pass it a bypass flag -- so it would ALSO get
// skipped on a quiet night. This is the escape hatch: hit this endpoint
// instead of the console's Force Run when retesting a code change against
// whatever's already in Firestore, no new ride required. Same auth as
// submitRide (this also burns real Nominatim/Overpass quota and rewrites
// what every visitor sees, so it shouldn't be open to just anyone) --
// call it with:
//   curl -X POST -H "X-Api-Key: <BUMPWATCH_API_KEY>" <this function's URL>
exports.forceRecomputeTopStretches = onRequest(
  {
    region: "us-east1",
    secrets: [API_KEY],
    cors: false,
    // Same reasoning as recomputeTopStretches's own timeoutSeconds comment
    // above -- a bad Overpass-mirror day needs real headroom.
    timeoutSeconds: 1800,
    memory: "512MiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const authResult = await authenticateRequest(req);
    if (!authResult.ok) {
      res.status(401).send(authResult.message);
      return;
    }

    try {
      await runTopStretchesRecompute();
      res.status(200).json({ ok: true });
    } catch (error) {
      logger.error("forceRecomputeTopStretches failed", error);
      res.status(500).send("Internal error");
    }
  }
);
