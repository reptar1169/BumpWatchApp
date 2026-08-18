#!/usr/bin/env node
/**
 * One-off admin script: deletes every bump document (across all rides) whose
 * magnitudeG is below a given threshold. Built to scrub out the noise
 * recorded before BumpDetector.thresholdG was raised from 0.45g to 1.3g.
 *
 * This talks to Firestore directly via the Admin SDK, so it needs real
 * credentials -- unlike `firebase firestore:delete`, which rides on your
 * `firebase login` session, this needs a service account key:
 *
 *   1. Firebase console -> gear icon -> Project settings -> Service accounts
 *   2. "Generate new private key" -- downloads a JSON file
 *   3. Save it as functions/serviceAccountKey.json (already gitignored --
 *      never commit this file, it's a master key to your whole project)
 *
 * Usage (from inside the functions/ directory, so node_modules resolves):
 *   node scripts/delete-low-magnitude-bumps.js            # deletes < 1.3g
 *   node scripts/delete-low-magnitude-bumps.js 1.0         # custom threshold
 *   node scripts/delete-low-magnitude-bumps.js --dry-run   # count only, no delete
 */
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const thresholdArg = args.find((a) => !a.startsWith("--"));
const threshold = thresholdArg ? parseFloat(thresholdArg) : 1.3;

if (Number.isNaN(threshold)) {
  console.error("Usage: node delete-low-magnitude-bumps.js [threshold] [--dry-run]");
  process.exit(1);
}

const keyPath = path.join(__dirname, "..", "serviceAccountKey.json");
let serviceAccount;
try {
  serviceAccount = require(keyPath);
} catch {
  console.error(
    `Couldn't find a service account key at ${keyPath}\n\n` +
      "Firebase console -> gear icon -> Project settings -> Service accounts ->\n" +
      "Generate new private key, then save the download as functions/serviceAccountKey.json."
  );
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  console.log(`Querying bumps with magnitudeG < ${threshold} ...`);
  const snap = await db
    .collectionGroup("bumps")
    .where("magnitudeG", "<", threshold)
    .get();

  if (snap.empty) {
    console.log("No matching bumps found.");
    return;
  }

  console.log(`Found ${snap.size} bump(s) below ${threshold}g.`);
  if (dryRun) {
    console.log("--dry-run set, nothing deleted.");
    return;
  }

  const docs = snap.docs;
  const BATCH_SIZE = 450; // Firestore batch limit is 500; leave headroom.
  let deleted = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deleted += Math.min(BATCH_SIZE, docs.length - i);
    console.log(`Deleted ${deleted}/${docs.length}...`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
