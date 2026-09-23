#!/usr/bin/env node
// Writes a LOCAL PREVIEW of web/bikelanebumps-site/top-stretches.json --
// useful for eyeballing a change to the clustering/scoring logic (or just
// checking in on the data) without waiting for the nightly job.
//
// Run manually:
//   node scripts/generate-top-stretches.mjs
//
// This is no longer what the live site reads. functions/index.js's
// recomputeTopStretches runs the SAME pipeline (imported from
// functions/topStretchesCore.js -- see that file's header for why the
// algorithm lives there and not duplicated in both places) on a nightly
// schedule and writes straight into Firestore
// (topStretches/current), which web/bikelanebumps-site/app.js reads
// live. That's what replaced "rerun this by hand, review the JSON,
// redeploy hosting" -- see the README's "Automated recompute" section.
//
// This script still exists because it's a faster local loop for checking
// a tuning change (say, a different REFERENCE_SPEED_MPS in
// topStretchesCore.js) against real data than waiting for the scheduled
// function and reading Firestore -- the output file below is just for
// your own eyes, not consumed by anything.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { processAllMetros } = require("../functions/topStretchesCore.js");

const PROJECT_ID = "bikelanebumps"; // matches .firebaserc
const FIRESTORE_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;

// Firestore's `bumps` collection group is public-read (see
// firestore/firestore.rules), so this needs no credentials -- same access
// level as the web page's own heatmap query. (The scheduled Cloud
// Function doesn't need this REST dance -- it already has Admin SDK
// access and queries Firestore directly.)
const BUMP_FETCH_LIMIT = 20000; // generous headroom above the current ~1100

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_PATH = path.join(__dirname, "..", "web", "bikelanebumps-site", "top-stretches.json");

// ---- Firestore REST helpers ----
// The REST API wraps every field in a `{ <type>Value: ... }` envelope
// (e.g. { doubleValue: 3.2 } or { integerValue: "3" } -- integers come
// back as strings). This unwraps the handful of field types BumpEvent
// actually uses. (topStretchesCore.js doesn't need this -- the scheduled
// function gets already-unwrapped values from doc.data() via the Admin
// SDK.)
function unwrapValue(value) {
  if (value == null) return null;
  if ("doubleValue" in value) return value.doubleValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  return null;
}

// doc.name is the full resource path, e.g.
// ".../documents/rides/RIDE_ID/bumps/AUTO_ID" -- rideId isn't a stored
// field on the bump doc itself, it's the parent segment of this path
// (same thing the Admin SDK side gets via doc.ref.parent.parent.id in
// functions/index.js's fetchAllBumpsForRecompute).
function rideIdFromResourceName(name) {
  const match = typeof name === "string" ? name.match(/\/rides\/([^/]+)\/bumps\//) : null;
  return match ? match[1] : null;
}

function parseBumpDocument(doc) {
  const fields = doc.fields ?? {};
  const get = (name) => unwrapValue(fields[name]);
  const rawTimestamp = get("timestamp");
  return {
    latitude: get("latitude"),
    longitude: get("longitude"),
    magnitudeG: get("magnitudeG"),
    horizontalAccuracyMeters: get("horizontalAccuracyMeters"),
    speedMetersPerSecond: get("speedMetersPerSecond"),
    // REST gives timestampValue back as an ISO string (see unwrapValue
    // above); topStretchesCore's recency-window filter wants a real Date.
    timestamp: rawTimestamp ? new Date(rawTimestamp) : null,
    rideId: rideIdFromResourceName(doc.name),
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

// ---- Main ----
async function main() {
  console.log(`Fetching bumps from Firestore project "${PROJECT_ID}"...`);
  const rawBumps = await fetchAllBumps();
  console.log(`Fetched ${rawBumps.length} bump documents.`);

  const { metros } = await processAllMetros(rawBumps);

  const output = {
    generatedAt: new Date().toISOString(),
    metros,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${metros.length} metro area(s) to ${OUTPUT_PATH} (local preview only -- see header comment)`);
  for (const metro of metros) {
    console.log(`\n${metro.name}:`);
    console.log(`  Speed-weighted top ${metro.weighted.length}:`);
    for (const s of metro.weighted) console.log(`    - ${s.name} (${s.bumpCount} bumps, ${s.totalSeverityG}g total)`);
    console.log(`  Raw-severity top ${metro.unweighted.length} (no speed weighting):`);
    for (const s of metro.unweighted) console.log(`    - ${s.name} (${s.bumpCount} bumps, ${s.totalSeverityG}g total)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
