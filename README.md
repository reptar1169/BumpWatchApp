# BumpWatch

A standalone Apple Watch app that records the location and severity of bumps
(potholes, cracks, bad expansion joints) while you ride, so they can be
plotted as a heatmap on your existing web map — the goal being to point at
exactly which stretches of bike lane need maintenance.

## How it works

1. **On the Watch**, tap Start. This begins a HealthKit cycling workout
   session (the same mechanism every cycling/running app uses to get
   reliable background execution and continuous GPS on watchOS, even with
   the screen off), starts accelerometer sampling at 50 Hz, and starts
   CoreLocation updates.
2. Every accelerometer sample is fed through a simple peak detector
   (`BumpDetector.swift`). When the acceleration magnitude (gravity removed)
   spikes above a threshold and then falls back down, that's counted as one
   bump, tagged with the most recent GPS fix, timestamp, and heart rate
   reading. Heart rate itself comes from the HealthKit workout session
   already running for background execution (see above) -- no extra sensor
   setup needed; `RideManager` reads it via `HKLiveWorkoutBuilder`'s live
   statistics and shows the current reading on the watch face while
   recording, and the ride's average/max heart rate are saved with the ride
   when it finishes.
3. Bumps are held in memory and periodically flushed to a JSON file on the
   Watch (`RideStore.swift`), so nothing is lost if the app is killed
   mid-ride.
4. Tap Stop to end the ride. The finished ride (metadata + every bump) is
   POSTed to a Cloud Function, authenticated as you (see "Auth" below),
   which writes it into Firestore. If there's no connectivity at that
   moment, the ride stays on disk marked "not yet uploaded" and retries
   automatically next time the app launches.
5. **Your web page** queries Firestore for bumps and renders them as a
   weighted heatmap layer (see `web/heatmap-integration.js`), and shows a
   per-metro "priority stretches" list computed by a nightly Cloud Function
   (see "Automated recompute" below).

## Why a Cloud Function instead of writing to Firestore directly from the Watch

The Firestore client SDK does not support watchOS (confirmed against
Firebase's current platform support docs — iOS/macOS/tvOS and
community-supported visionOS only). Rather than routing everything through
your iPhone, the Watch app talks HTTPS directly (which `URLSession` handles
fine on any Apple platform) to a small Cloud Function, which uses the
Admin SDK server-side to write to Firestore. This is also arguably a better
architecture regardless of the SDK gap: your Firestore security rules can
simply reject all direct client writes (see `firestore/firestore.rules`),
and the function is a natural place to validate/rate-limit incoming rides.

## Auth

Every ride upload authenticates as a specific rider, via Firebase's
anonymous auth -- **not** the Firebase Auth SDK, which (like Firestore)
doesn't support watchOS. `AuthService.swift` talks to Firebase's Identity
Toolkit REST API directly instead (same "plain HTTPS" approach
`UploadService.swift` already uses for the Cloud Function itself): it signs
up anonymously on first launch, persists the resulting uid/tokens to disk,
and refreshes the ID token as needed. `UploadService` sends that token as
`Authorization: Bearer <token>` on every upload; `functions/index.js`
verifies it with the Admin SDK and stamps the ride with `submittedByUid`.

You'll need to enable the **Anonymous** sign-in provider for your project
once: Firebase Console → Authentication → Sign-in method → Anonymous →
Enable. Nothing else to configure -- there's no user-facing sign-in screen,
the Watch just gets an identity automatically.

### Transition plan (retiring the old API-key auth)

Earlier versions of this app authenticated every upload with a single
shared secret (`X-Api-Key`, checked against `BUMPWATCH_API_KEY`) -- fine
for a personal, single-user project, but not real authentication, and not
appropriate once the app is public on the App Store. `functions/index.js`
now accepts EITHER a valid Firebase auth token OR the legacy key
(`authenticateRequest()`), specifically so that copies of the app already
installed from the App Store keep uploading without interruption while the
new build works through App Review and rolls out -- an already-shipped
build can't be changed retroactively to start sending the new header.

Each ride records which path it came in on (`submittedVia: "auth"` or
`"legacy-key"`), so you can check in Firestore how adoption of the new
build is going. Once `legacy-key` rides have stopped showing up for a
while (give it a few weeks past when you'd expect most active users to
have auto-updated), you can retire the old path:

1. Remove the `X-Api-Key` branch from `authenticateRequest()` in
   `functions/index.js`.
2. `firebase deploy --only functions`.
3. `firebase functions:secrets:destroy BUMPWATCH_API_KEY` (optional
   cleanup).

## What "standalone" means here, concretely

The Watch app has **no companion iPhone app at all** — it's built with
Xcode's single-target watchOS app structure, so there's nothing on your
phone required to be running (or even installed) during a ride. You do
still need an iPhone to *pair* the Watch in the first place and to install
the app via Xcode (that's an Apple Watch hardware requirement, not
something this project can work around) — but once installed, the ride
itself only depends on the Watch's own GPS and radio, so a WiFi- or
cellular-equipped Watch will upload rides without your phone nearby. A
GPS-only Watch with no WiFi in range will queue the ride and upload it next
time it's near WiFi or paired with your phone again.

## Project layout

```
BumpWatch Watch App/          Swift sources for the watch app
  AuthService.swift             Anonymous Firebase auth via REST (see "Auth" above)
  UploadService.swift           Sends a finished ride to the Cloud Function
project.yml                   XcodeGen config to generate the .xcodeproj
functions/
  index.js                      Cloud Function: relays rides to Firestore + nightly recompute
  topStretchesCore.js           Shared clustering/scoring/geocoding pipeline (see its header)
firestore/firestore.rules     Security rules: clients can read, only functions can write
scripts/
  generate-top-stretches.mjs    Local preview tool -- NOT what the live site reads anymore
  generate-bike-lanes.mjs       Still the manual/production path -- see "Automated recompute"
web/bikelanebumps-site/       The website (app.js reads bumps + top-stretches from Firestore live)
web/heatmap-integration.js    Standalone example Firestore query + Leaflet heatmap layer
```

## Setting up the Xcode project

Two options — pick whichever you're more comfortable with:

**Option A — XcodeGen (recommended, reproducible)**

```
brew install xcodegen
cd bump-watch-app
xcodegen generate
open BumpWatch.xcodeproj
```

Then in Xcode: select the BumpWatch target → Signing & Capabilities → pick
your team (this fills in `DEVELOPMENT_TEAM` for you) → make sure
HealthKit capability shows up (it's declared in `project.yml`'s
entitlements).

Rerun `xcodegen generate` any time a Swift file is added under
`BumpWatch Watch App/` (it picks up the whole directory) -- harmless to
rerun even when nothing changed.

**Option B — By hand**

In Xcode: File → New → Project → watchOS → **App** (the standalone
template, no "Include Notification Scene", no companion app). Delete the
generated placeholder Swift files and drag in everything from
`BumpWatch Watch App/` in this folder. Add the HealthKit capability under
Signing & Capabilities, and add the `UIBackgroundModes` (`location`,
`workout-processing`) and usage-description keys from `project.yml` into
your Info tab if they're not already there.

Build to your paired Watch (Xcode → your Watch as the run destination; the
Watch must be on the same WiFi/paired for the initial install).

## Deploying the Cloud Functions

Requires the Firebase CLI (`npm install -g firebase-tools`) and that you're
logged in (`firebase login`) with access to your existing Firestore
project.

```
cd bump-watch-app
firebase use --add            # pick your existing Firebase project
firebase functions:secrets:set BUMPWATCH_API_KEY   # only needed during the auth transition -- see above
firebase deploy --only functions,firestore:rules
```

After deploying, copy `submitRide`'s URL (Firebase CLI prints it, something
like `https://us-east1-YOUR-PROJECT.cloudfunctions.net/submitRide`) into
`UploadService.endpoint` in the Watch app. Rebuild and install on the
Watch. (There's no API key to paste anymore -- see "Auth" above.)

Don't forget the one-time Anonymous auth provider step under "Auth" above
-- without it, every upload from a new build will fail until you enable
it.

If this is the **first** scheduled function (`recomputeTopStretches`) ever
deployed to this Firebase project, the CLI may prompt you to enable the
Cloud Scheduler API and pick a default Cloud region for it -- a one-time
setup step Firebase asks for, not something specific to this project.

## Firestore schema

```
rides/{rideId}
  startTime: Timestamp
  endTime: Timestamp
  bumpCount: number
  averageHeartRateBPM: number | null
  maxHeartRateBPM: number | null
  receivedAt: Timestamp        (server write time)
  submittedByUid: string | null  (Firebase anonymous-auth uid; null for legacy-key rides -- see "Auth")
  submittedVia: "auth" | "legacy-key"

rides/{rideId}/bumps/{bumpId}
  timestamp: Timestamp
  magnitudeG: number           (peak acceleration, gravity removed)
  location: GeoPoint
  latitude: number
  longitude: number
  horizontalAccuracyMeters: number | null
  speedMetersPerSecond: number | null
  headingDegrees: number | null  (0-359.9, clockwise from true north; -1/null if unknown)
  heartRateBPM: number | null  (most recent HealthKit reading when the bump landed)

topStretches/current           (written by the nightly recomputeTopStretches function)
  generatedAt: Timestamp
  metros: [{ name, lat, lng, weighted: [...], unweighted: [...] }]  (see topStretchesCore.js)
```

`location` is stored as a `GeoPoint` for potential future geo-queries;
`latitude`/`longitude` are duplicated as plain numbers because they're
simpler to consume from a heatmap library that just wants `[lat, lng]`
pairs.

## Automated recompute

`functions/index.js`'s `recomputeTopStretches` runs the clustering/
scoring/geocoding pipeline (`functions/topStretchesCore.js` -- shared with
the local preview script so there's exactly one implementation, not two
that can drift apart) on a nightly schedule, and writes straight into the
`topStretches/current` Firestore doc. `web/bikelanebumps-site/app.js` reads
that doc live. This is what replaced the old "rerun the script by hand,
review the JSON, `firebase deploy --only hosting`" workflow for
top-stretches specifically -- necessary now that rides can arrive from
riders in different cities on their own schedule, not just in the
occasional batch you'd run yourself and remember to redeploy after.

The nightly run skips itself (no Nominatim/Overpass calls, no Firestore
write) unless a ride has been saved since the last successful recompute --
worth doing while the app has few enough riders that most nights are
otherwise a no-op burning real API quota for an identical result. Because
of that gate, the Firebase console's "Force run" button on
`recomputeTopStretches` will ALSO skip on a quiet night (it just re-fires
the same scheduled trigger, with no way to pass it a bypass). To force a
real recompute against whatever's already in Firestore -- e.g. retesting a
code change without waiting for a new ride -- hit `forceRecomputeTopStretches`
instead, the same way the watch app authenticates to `submitRide`:
```
curl -X POST -H "X-Api-Key: <BUMPWATCH_API_KEY>" <forceRecomputeTopStretches URL>
```

`scripts/generate-top-stretches.mjs` still exists, but only as a **local
preview tool** -- useful for checking a tuning change (e.g. a different
`REFERENCE_SPEED_MPS` in `topStretchesCore.js`) against real data faster
than waiting for the nightly job. Nothing on the live site reads the JSON
file it writes anymore.

**`scripts/generate-bike-lanes.mjs` is deliberately NOT automated the same
way (yet).** It makes far more Overpass API calls than top-stretches does,
paced 2 seconds apart with up to 4 retries and 120-second backoffs per
region, plus a whole-run 90-second cooldown after repeated failures -- a
run can reasonably take many minutes and depends on a rate-limited public
service having a good day. That's a much worse fit for an unattended
scheduled function (a silent timeout partway through is hard to notice or
debug) than for something you watch run and can just retry. Worth
revisiting once the top-stretches nightly job has a track record of
running cleanly -- at that point the same "write to Firestore instead of
a static file" pattern would apply.

## Tuning bump detection

`BumpDetector.thresholdG` (default 3.0g) and `debounceInterval` (default
0.3s) are the two knobs. Ride over a pavement seam or pothole you know
well, check the bump count on the watch face, and adjust — lower the
threshold if real bumps are being missed, raise it if smooth pavement is
triggering false positives (this will vary by how you mount/wear the Watch
and by riding speed).

Prefer tuning ranking over tuning detection where possible: raising
thresholdG permanently drops data at record time (no way to recover a
missed bump later), while severity/speed weighting in
`functions/topStretchesCore.js` can be freely retuned after the fact
against data you've already collected.

## Possible next steps

- Save the GPS track as an `HKWorkoutRoute` too, so rides also show up with
  a route map in the Fitness app (not implemented here to keep the first
  version simple).
- Bounding-box filtering for the heatmap query using geohashes
  (`geofire-common`) once you have enough rides that pulling every bump on
  every page load gets slow.
- A companion "my rides" list on the web page, not just the heatmap.
- Per-`submittedByUid` rate limiting / abuse detection in `submitRide`,
  now that rides carry real per-rider identity instead of one shared key.
- Automate `generate-bike-lanes.mjs` the same way as top-stretches once
  the nightly job has proven reliable -- see "Automated recompute" above.
