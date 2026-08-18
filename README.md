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
   bump, tagged with the most recent GPS fix and timestamp.
3. Bumps are held in memory and periodically flushed to a JSON file on the
   Watch (`RideStore.swift`), so nothing is lost if the app is killed
   mid-ride.
4. Tap Stop to end the ride. The finished ride (metadata + every bump) is
   POSTed to a Cloud Function, which writes it into Firestore. If there's no
   connectivity at that moment, the ride stays on disk marked
   "not yet uploaded" and retries automatically next time the app launches.
5. **Your web page** queries Firestore for bumps and renders them as a
   weighted heatmap layer (see `web/heatmap-integration.js`).

## Why a Cloud Function instead of writing to Firestore directly from the Watch

The Firestore client SDK does not support watchOS (confirmed against
Firebase's current platform support docs — iOS/macOS/tvOS and
community-supported visionOS only). Rather than routing everything through
your iPhone, the Watch app talks HTTPS directly (which `URLSession` handles
fine on any Apple platform) to a small Cloud Function, which uses the
Admin SDK server-side to write to Firestore. This is also arguably a better
architecture regardless of the SDK gap: your Firestore security rules can
simply reject all direct client writes (see `firestore/firestore.rules`),
and the function is a natural place to validate/rate-limit incoming rides
later if needed.

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
BumpWatch Watch App/     Swift sources for the watch app
project.yml              XcodeGen config to generate the .xcodeproj
functions/                Cloud Function (Node.js) that relays to Firestore
firestore/firestore.rules Security rules: clients can read, only the function can write
web/heatmap-integration.js  Example Firestore query + Leaflet heatmap layer
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

## Deploying the Cloud Function

Requires the Firebase CLI (`npm install -g firebase-tools`) and that you're
logged in (`firebase login`) with access to your existing Firestore
project.

```
cd bump-watch-app
firebase use --add            # pick your existing Firebase project
firebase functions:secrets:set BUMPWATCH_API_KEY   # paste any random string
firebase deploy --only functions,firestore:rules
```

After deploying, copy the function's URL (Firebase CLI prints it, something
like `https://us-central1-YOUR-PROJECT.cloudfunctions.net/submitRide`) into
`UploadService.endpoint` in the Watch app, and paste the same secret you set
above into `UploadService.apiKey`. Rebuild and install on the Watch.

> The API key check is a lightweight guard appropriate for a personal,
> single-user project — not real authentication. If you ever want other
> people using this, swap it for Firebase Auth (anonymous sign-in on the
> Watch via the REST API, then verify the ID token in the function) and
> tighten `firestore.rules` accordingly.

## Firestore schema

```
rides/{rideId}
  startTime: Timestamp
  endTime: Timestamp
  bumpCount: number
  receivedAt: Timestamp        (server write time)

rides/{rideId}/bumps/{bumpId}
  timestamp: Timestamp
  magnitudeG: number           (peak acceleration, gravity removed)
  location: GeoPoint
  latitude: number
  longitude: number
  horizontalAccuracyMeters: number | null
  speedMetersPerSecond: number | null
```

`location` is stored as a `GeoPoint` for potential future geo-queries;
`latitude`/`longitude` are duplicated as plain numbers because they're
simpler to consume from a heatmap library that just wants `[lat, lng]`
pairs.

## Tuning bump detection

`BumpDetector.thresholdG` (default 0.45g) and `debounceInterval` (default
250ms) are the two knobs. Ride over a pavement seam or pothole you know
well, check the bump count on the watch face, and adjust — lower the
threshold if real bumps are being missed, raise it if smooth pavement is
triggering false positives (this will vary by how you mount/wear the Watch
and by riding speed).

## Possible next steps

- Save the GPS track as an `HKWorkoutRoute` too, so rides also show up with
  a route map in the Fitness app (not implemented here to keep the first
  version simple).
- Bounding-box filtering for the heatmap query using geohashes
  (`geofire-common`) once you have enough rides that pulling every bump on
  every page load gets slow.
- A companion "my rides" list on the web page, not just the heatmap.
