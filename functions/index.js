const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

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
// Once a night is deliberately conservative: this pipeline makes real
// calls to Nominatim (1/sec) and Overpass (rate-limited, multi-mirror with
// retries) for every stretch across every metro, and ridden area doesn't
// meaningfully change hour to hour. Nothing about the design requires
// nightly specifically -- adjust the schedule below if that cadence stops
// fitting how fast new cities/riders show up.
const { processAllMetros } = require("./topStretchesCore");

async function fetchAllBumpsForRecompute() {
  const snapshot = await db.collectionGroup("bumps").get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      latitude: typeof data.latitude === "number" ? data.latitude : null,
      longitude: typeof data.longitude === "number" ? data.longitude : null,
      magnitudeG: typeof data.magnitudeG === "number" ? data.magnitudeG : null,
      horizontalAccuracyMeters:
        typeof data.horizontalAccuracyMeters === "number" ? data.horizontalAccuracyMeters : null,
      speedMetersPerSecond:
        typeof data.speedMetersPerSecond === "number" ? data.speedMetersPerSecond : null,
    };
  });
}

exports.recomputeTopStretches = onSchedule(
  {
    schedule: "0 9 * * *", // ~1-2am US Pacific, adjust freely -- see comment above
    region: "us-east1",
    timeoutSeconds: 300, // generous headroom for Nominatim/Overpass pacing across several metros
    memory: "512MiB",
  },
  async () => {
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
);
