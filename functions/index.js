const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// Set with:
//   firebase functions:secrets:set BUMPWATCH_API_KEY
// then paste the same value into UploadService.apiKey in the watch app.
const API_KEY = defineSecret("BUMPWATCH_API_KEY");

const MAX_BATCH_SIZE = 450; // Firestore batch limit is 500 writes; leave headroom.

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

    if (req.get("X-Api-Key") !== API_KEY.value()) {
      res.status(401).send("Unauthorized");
      return;
    }

    const ride = req.body;
    if (!ride || typeof ride.id !== "string" || !Array.isArray(ride.bumps)) {
      res.status(400).send("Malformed ride payload");
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
            heartRateBPM: typeof bump.heartRateBPM === "number" ? bump.heartRateBPM : null,
          });
        }
        await batch.commit();
      }

      logger.info(`Stored ride ${ride.id} with ${ride.bumps.length} bumps`);
      res.status(200).json({ ok: true, rideId: ride.id, bumps: ride.bumps.length });
    } catch (error) {
      logger.error("Failed to store ride", error);
      res.status(500).send("Internal error");
    }
  }
);
