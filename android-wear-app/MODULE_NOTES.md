# BumpWatch for Wear OS -- first-draft port

This module is a Wear OS port of `BumpWatch Watch App`, written to the same
architecture and against the same `submitRide` Firestore contract as the
Apple Watch app -- see the root `README.md` for the shared backend.

**Important: this was written without a working Android toolchain.** Java
and Gradle are present in the environment that wrote this, but it has no
network access to Maven Central or Google's Maven repo, and no Android SDK
-- so nothing here has actually been compiled, and there's no physical
Wear OS device to validate real sensor/GPS behavior either. Treat this as
a solid, carefully-reasoned first draft to open in Android Studio, not a
tested build. Every file was hand-checked for obvious syntax problems
(brace balance, etc.) but that's a much weaker guarantee than a real
compile.

## What's included

- `model/` -- `BumpEvent`/`RideRecord`, field-for-field matches of
  `BumpEvent.swift`/`RideRecord.swift` so `functions/index.js`'s
  `submitRide` doesn't need to know which platform sent a ride.
- `sensors/BumpDetector.kt` -- direct port of `BumpDetector.swift`'s
  peak-detection algorithm, same threshold (3.0g) and debounce (0.3s) as
  a starting point.
- `location/LocationTracker.kt` -- FusedLocationProviderClient wrapper,
  same role as `LocationTracker.swift`.
- `auth/AuthService.kt` -- Firebase anonymous auth. Simpler than the
  Swift side: the real Firebase Auth SDK runs on Wear OS, so there's no
  need for `AuthService.swift`'s hand-rolled REST/token-refresh dance.
- `network/UploadService.kt` -- POSTs to the same `submitRide` Cloud
  Function URL as `UploadService.swift`, `Authorization: Bearer <token>`.
- `ride/RideStore.kt` -- same "one JSON file per ride, deleted only after
  a confirmed upload" approach as `RideStore.swift`.
- `ride/RideManager.kt` -- orchestrates a Health Services exercise
  session (heart rate/distance/calories), the accelerometer (bump
  detection) and barometer (elevation gain, computed the same way
  `RideManager.swift` does via `CMAltimeter` -- neither platform's OS
  hands elevation gain to third-party apps as a live sample). **This file
  has the most API-surface uncertainty -- see its header comment.**
- `ui/RootScreen.kt` -- Compose UI, a swipeable two-page layout mirroring
  `ContentView.swift`'s `TabView(.page)`: recording controls on page one,
  live distance/calories/elevation on page two.

## What's deliberately left out of this pass

- Color-coded bump severity (`BumpSeverity.swift`'s equivalent) -- kept
  out to control scope/risk; easy to add back once the core loop works.
- `generate-bike-lanes.mjs`/`generate-top-stretches.mjs`/the website all
  already work identically regardless of which platform submitted a ride
  -- no backend changes were needed or made for this.

## Manual steps only you can do

1. **Register a new Android app in the Firebase console**, under the
   existing `bikelanebumps` project, with package name
   `com.jeffschoello.bumpwatch.wear`. Download the real
   `google-services.json` it gives you and place it at `app/google-services.json`
   -- the Gradle build will fail without it (there's no way for me to
   generate this file; it's tied to your Firebase project).
2. **Open this folder in Android Studio** and let it sync. The Gradle
   wrapper jar itself isn't included (nothing here could generate that
   binary) -- Android Studio will offer to create/repair it on first open.
3. **Test on a real Wear OS watch** once you have one. `thresholdG = 3.0`
   was tuned from real iOS ride data on Apple Watch hardware -- the
   algorithm is ported faithfully, but Android's sensor and wrist-mount
   characteristics may call for a different number. Watch the
   `BumpWatch` logcat tag during a real ride the same way the Swift side's
   console output was used to tune this originally.

## Launcher icon

Added `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`
(adaptive icon: solid `ic_launcher_background` color layer + a
`ic_launcher_foreground` glyph layer), referenced from
`AndroidManifest.xml`'s `android:icon`/`android:roundIcon`. The
foreground PNG itself lives in real density buckets
(`mipmap-mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi/ic_launcher_foreground.png`,
108/162/216/324/432px) rather than directly inside `mipmap-anydpi-v26` --
first pass put it there since that's where the XML descriptors live, but
that showed up as a plain dark circle (background only, foreground never
drawn) once actually installed. `anydpi-v26` is for density-independent
XML resources; a fixed-resolution PNG dropped there isn't reliably
resolved. No legacy (pre-API-26) fallback PNGs needed -- `minSdk = 30`
already guarantees adaptive icon support.

The glyph and background color are both pulled straight from the
existing watchOS icon at `BumpWatch Watch App/Assets.xcassets/AppIcon
.appiconset/AppIcon.png`, not a new design -- isolated by chroma-keying
out its background (saturation-based, since the background is a
desaturated dark gradient throughout and the glyph is a saturated
yellow/orange/red one) and rescaled down to fit inside the 66/108dp
adaptive-icon safe zone so the wheel-and-bump glyph doesn't get clipped
by round watch launchers. Same bike-wheel-over-a-bump mark on both
platforms now.

## Foreground service + OngoingActivity (added post-submission)

Play Console's FOREGROUND_SERVICE_HEALTH declaration flagged something
real, not just paperwork: the app declared that permission in the
manifest but never actually implemented a foreground `Service` -- Health
Services' own docs are explicit that `ExerciseClient` alone doesn't keep
the process alive or show anything to the user in the background ("Use a
continuously running ForegroundService in conjunction with
ExerciseClient..."). Without it, a ride recording while the watch was
backgrounded was at real risk of being silently killed by the OS.

Added `ride/RideForegroundService.kt`: started from `RideManager.startRide()`
and stopped from `stopRide()`, it does nothing but hold the foreground-
service slot and post an `OngoingActivity` notification ("Recording your
ride") for as long as a ride is active -- that's what makes it show up on
the watch face itself, not just the notification shade, and what
satisfies Play's "noticeable to the user when they're not directly
interacting with your app" requirement. `RideManager` still owns all the
real exercise/sensor/location logic; this service doesn't duplicate any
of it.

Also added: `android.permission.FOREGROUND_SERVICE_LOCATION` and
`android.permission.POST_NOTIFICATIONS` (the manifest declaration for
the latter, plus a runtime request in `MainActivity.kt` -- required from
API 33 on, a no-op before that) and the `<service>` element itself with
`android:foregroundServiceType="health|location"`, and the
`androidx.wear:wear-ongoing:1.1.0` dependency for the `OngoingActivity`
API.

For the Play Console video demonstration: start a ride, then press the
watch's home/back button to background the app -- the OngoingActivity
indicator should be visible at the top of the watch face (or in the
notification shade) the whole time, proving the recording keeps running
without the app in the foreground. That's the actual behavior the
permission exists for, and the clearest thing to point a reviewer at.

Recording that demo surfaced a second real bug: reopening the app (via
the OngoingActivity's touch intent, or just from the app list) showed
the pre-recording Start screen instead of the still-in-progress ride,
even though the OngoingActivity indicator confirmed the ride was still
actively recording. Cause: `MainActivity.onCreate()` constructed a
brand new `RideManager(applicationContext)` every time it ran, and a
ride's entire live state (isRecording, elapsedSeconds, heart rate, bump
count, ...) lives only in that instance's StateFlows -- nothing is
persisted elsewhere. The OngoingActivity notification's touch intent
launches a new MainActivity instance while the process (kept alive by
RideForegroundService) never actually died, so the reopened Activity's
fresh RideManager had no idea a ride was already underway. Fixed by
making RideManager a process-wide singleton (`RideManager.shared(context)`,
a companion object on `RideManager` itself) instead of a per-Activity
instance -- MainActivity.kt now calls `RideManager.shared(applicationContext)`
rather than `RideManager(applicationContext)` directly, so a reopened
Activity's Compose UI reconnects to the one RideManager that's actually
still recording instead of starting a new one.

## Library versions used

Checked against developer.android.com / mvnrepository.com as of Aug 2026
(AGP 9.3.0, Kotlin 2.4.10, `androidx.health:health-services-client:1.0.0`,
`androidx.wear.compose:compose-material3:1.5.0`,
`com.google.firebase:firebase-bom:34.18.0`) -- but never resolved by an
actual Gradle sync. Take whatever newer versions Android Studio suggests.
