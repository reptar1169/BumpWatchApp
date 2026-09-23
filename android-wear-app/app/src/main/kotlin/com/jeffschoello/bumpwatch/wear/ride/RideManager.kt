package com.jeffschoello.bumpwatch.wear.ride

import android.content.Context
import android.content.Intent
import android.location.Location
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import androidx.health.services.client.HealthServices
import androidx.health.services.client.ExerciseClient
import androidx.health.services.client.ExerciseUpdateCallback
import androidx.health.services.client.data.Availability
import androidx.health.services.client.data.CumulativeDataPoint
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.ExerciseConfig
import androidx.health.services.client.data.ExerciseLapSummary
import androidx.health.services.client.data.ExerciseType
import androidx.health.services.client.data.ExerciseUpdate
import androidx.health.services.client.data.SampleDataPoint
import androidx.core.content.ContextCompat
import androidx.health.services.client.data.StatisticalDataPoint
import com.jeffschoello.bumpwatch.wear.location.LocationTracker
import com.jeffschoello.bumpwatch.wear.model.BumpEvent
import com.jeffschoello.bumpwatch.wear.model.RideRecord
import com.jeffschoello.bumpwatch.wear.model.RoutePoint
import com.jeffschoello.bumpwatch.wear.network.UploadService
import com.jeffschoello.bumpwatch.wear.sensors.BumpDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import java.time.Instant

// ---------------------------------------------------------------------
// NOTE ON CONFIDENCE: this file is the least certain of the port. The
// Health Services (androidx.health.services.client) API surface has
// shifted across versions -- exact builder shapes for ExerciseConfig,
// exactly which DataType/DataPoint subclasses are used for cumulative vs.
// statistical metrics, and the ExerciseClient/ExerciseUpdateCallback
// method signatures below are written from best current knowledge, NOT
// verified against a compiler (no Android toolchain or network to Maven
// was available while writing this). Expect Android Studio's autocomplete
// and quick-fixes to be the fastest way to true this section up --
// everything else in this module (BumpDetector, LocationTracker, the
// upload/auth/storage layer, the UI) is much more standard Android/Kotlin
// and should need little to no correction by comparison.
// ---------------------------------------------------------------------

private const val GRAVITY_MPS2 = 9.80665
private const val ELEVATION_NOISE_THRESHOLD_METERS = 0.15
// Route points are sampled by distance, not time -- dense through slow,
// turny blocks, sparse on a long straight stretch, quiet at a red light.
// 20m is about 4-6 points per typical city block: enough for the map to
// read as a real street without a laser survey. Mirrors
// RideManager.swift's routePointMinSpacingMeters exactly.
private const val ROUTE_POINT_MIN_SPACING_METERS = 20f
// Mirrors the server-side MAX_ROUTE_POINTS_PER_RIDE cap in
// functions/index.js -- keeps a pathological all-day ride's payload
// bounded. At 20m spacing this is ~60km of riding before sampling simply
// stops for the rest of the ride, well past a normal commute.
private const val MAX_ROUTE_POINTS_PER_RIDE = 3000

/**
 * Orchestrates a ride: starts a Health Services exercise session (gives
 * background execution + live heart rate/distance/calories -- the Android
 * equivalent of RideManager.swift's HKWorkoutSession/HKLiveWorkoutBuilder),
 * streams accelerometer data through BumpDetector, tags each detected bump
 * with the latest GPS fix, and persists/uploads the result.
 */
class RideManager(
    private val context: Context,
    private val rideStore: RideStore = RideStore(context),
    private val uploadService: UploadService = UploadService(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    val isRecording = MutableStateFlow(false)
    val isPaused = MutableStateFlow(false)
    val elapsedSeconds = MutableStateFlow(0.0)
    val bumpCount = MutableStateFlow(0)
    val lastBumpMagnitudeG = MutableStateFlow<Double?>(null)
    val currentHeartRateBPM = MutableStateFlow<Double?>(null)
    val currentDistanceMeters = MutableStateFlow<Double?>(null)
    val currentActiveEnergyKcal = MutableStateFlow<Double?>(null)
    /** Defaults to 0 (not null) -- a ride genuinely starts at zero gain,
     * mirroring RideManager.swift's elevationGainMeters. */
    val elevationGainMeters = MutableStateFlow(0.0)
    val lastError = MutableStateFlow<String?>(null)

    private val exerciseClient: ExerciseClient = HealthServices.getClient(context).exerciseClient

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    // TYPE_LINEAR_ACCELERATION is Android's equivalent of CoreMotion's
    // userAcceleration -- gravity already subtracted out.
    private val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    // Not every Wear OS watch has a barometer -- getDefaultSensor returns
    // null on those, and registerListener below is skipped accordingly,
    // same "gracefully do nothing" fallback CMAltimeter.isRelativeAltitudeAvailable()
    // gives the Swift side.
    private val barometer = sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE)

    private val locationTracker = LocationTracker(context)
    private val bumpDetector = BumpDetector()

    private var currentRide: RideRecord? = null
    private var rideStartMillis: Long = 0
    private var pauseStartMillis: Long = 0
    private var timerJob: Job? = null
    private var lastSaveMillis: Long = 0

    private var baselineAltitudeMeters: Double? = null
    private var lastRelativeAltitudeMeters: Double? = null

    private var rideAverageHeartRateBPM: Double? = null
    private var rideMaxHeartRateBPM: Double? = null

    // Last fix a route point was recorded from, so maybeRecordRoutePoint
    // can measure distance since it. Reset to null at the start of every
    // ride (see startRide) so spacing is judged fresh each time, never
    // against a previous ride's last point.
    private var lastRoutePointLocation: Location? = null

    init {
        locationTracker.onLocationUpdate = { location -> maybeRecordRoutePoint(location) }
    }

    // ---- Sensors ----

    private val accelListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val xG = event.values[0] / GRAVITY_MPS2
            val yG = event.values[1] / GRAVITY_MPS2
            val zG = event.values[2] / GRAVITY_MPS2
            val peak = bumpDetector.ingest(xG, yG, zG, event.timestamp / 1_000_000_000.0)
            if (peak != null) recordBump(peak)
        }
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    // Barometric relative-altitude tracking, the same approach
    // startAltimeterUpdates() in RideManager.swift uses via CMAltimeter --
    // HealthKit/Health Services don't hand elevation gain to third-party
    // apps as a live sample either way, it's system-computed metadata on
    // someone else's saved workout, so both platforms fall back to the
    // watch's own barometer directly.
    private val barometerListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val altitude = SensorManager.getAltitude(
                SensorManager.PRESSURE_STANDARD_ATMOSPHERE, event.values[0]
            ).toDouble()

            val baseline = baselineAltitudeMeters
            if (baseline == null) {
                // First reading establishes the baseline -- everything
                // after this is relative to it, mirroring CMAltimeter's
                // own "relative to whenever updates began" semantics.
                baselineAltitudeMeters = altitude
                lastRelativeAltitudeMeters = 0.0
                return
            }

            val relative = altitude - baseline
            val last = lastRelativeAltitudeMeters
            lastRelativeAltitudeMeters = relative
            if (last != null) {
                val delta = relative - last
                if (delta > ELEVATION_NOISE_THRESHOLD_METERS) {
                    elevationGainMeters.value += delta
                }
            }
        }
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    // ---- Exercise session (Health Services) ----

    private val exerciseCallback = object : ExerciseUpdateCallback {
        override fun onExerciseUpdateReceived(update: ExerciseUpdate) {
            // HEART_RATE_BPM is a *sample* data type -- getData() returns a
            // List<SampleDataPoint<T>> (one entry per reading since the last
            // callback), so lastOrNull() picks the most recent one.
            update.latestMetrics.getData(DataType.HEART_RATE_BPM).lastOrNull()?.let {
                (it as? SampleDataPoint<Double>)?.let { sample -> currentHeartRateBPM.value = sample.value }
            }
            // DISTANCE_TOTAL, CALORIES_TOTAL, and HEART_RATE_BPM_STATS are
            // *aggregate* data types (Cumulative/Statistical), not sample
            // types -- getData() for these returns a single nullable
            // DataPoint<T>? directly (it's already the running total/summary
            // for the exercise), not a List. That's what "Unresolved
            // reference 'firstOrNull'" was pointing at: there's no List to
            // call it on for this category, unlike HEART_RATE_BPM above.
            update.latestMetrics.getData(DataType.DISTANCE_TOTAL)?.let {
                (it as? CumulativeDataPoint<Double>)?.let { total -> currentDistanceMeters.value = total.total }
            }
            update.latestMetrics.getData(DataType.CALORIES_TOTAL)?.let {
                (it as? CumulativeDataPoint<Double>)?.let { total -> currentActiveEnergyKcal.value = total.total }
            }
            update.latestMetrics.getData(DataType.HEART_RATE_BPM_STATS)?.let { stats ->
                (stats as? StatisticalDataPoint<Double>)?.let {
                    rideAverageHeartRateBPM = it.average
                    rideMaxHeartRateBPM = it.max
                }
            }
        }
        override fun onLapSummaryReceived(lapSummary: ExerciseLapSummary) {}
        override fun onRegistered() {}
        override fun onRegistrationFailed(throwable: Throwable) {
            lastError.value = "Exercise session failed to start: ${throwable.message}"
        }
        override fun onAvailabilityChanged(dataType: DataType<*, *>, availability: Availability) {}
    }

    fun startRide() {
        if (isRecording.value) return
        lastError.value = null

        val start = System.currentTimeMillis()
        rideStartMillis = start
        currentRide = RideRecord(startTime = Instant.ofEpochMilli(start).toString())
        lastRoutePointLocation = null

        val config = ExerciseConfig.builder(ExerciseType.BIKING)
            .setDataTypes(
                setOf(
                    DataType.HEART_RATE_BPM,
                    DataType.HEART_RATE_BPM_STATS,
                    DataType.DISTANCE_TOTAL,
                    DataType.CALORIES_TOTAL,
                )
            )
            .setIsAutoPauseAndResumeEnabled(false)
            .build()

        scope.launch {
            try {
                exerciseClient.setUpdateCallback(exerciseCallback)
                exerciseClient.startExerciseAsync(config).await()
            } catch (error: Exception) {
                lastError.value = "Couldn't start exercise session: ${error.message}"
            }
        }

        // See RideForegroundService's header comment -- this is what
        // actually backs the FOREGROUND_SERVICE_HEALTH permission and
        // keeps the process alive + visibly recording while the watch is
        // backgrounded mid-ride, not just a formality.
        ContextCompat.startForegroundService(context, Intent(context, RideForegroundService::class.java))

        bumpDetector.reset()
        locationTracker.start()
        accelerometer?.let {
            sensorManager.registerListener(accelListener, it, SensorManager.SENSOR_DELAY_GAME)
        }
        baselineAltitudeMeters = null
        lastRelativeAltitudeMeters = null
        barometer?.let {
            sensorManager.registerListener(barometerListener, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
        startTimer()

        isRecording.value = true
        isPaused.value = false
        bumpCount.value = 0
        lastBumpMagnitudeG.value = null
        currentHeartRateBPM.value = null
        currentDistanceMeters.value = null
        currentActiveEnergyKcal.value = null
        elevationGainMeters.value = 0.0
        rideAverageHeartRateBPM = null
        rideMaxHeartRateBPM = null
    }

    fun pauseRide() {
        if (!isRecording.value || isPaused.value) return
        isPaused.value = true
        pauseStartMillis = System.currentTimeMillis()
        sensorManager.unregisterListener(accelListener)
        sensorManager.unregisterListener(barometerListener)
        timerJob?.cancel()
        scope.launch { runCatching { exerciseClient.pauseExerciseAsync().await() } }
    }

    fun resumeRide() {
        if (!isRecording.value || !isPaused.value) return
        val pausedFor = System.currentTimeMillis() - pauseStartMillis
        rideStartMillis += pausedFor
        isPaused.value = false
        accelerometer?.let {
            sensorManager.registerListener(accelListener, it, SensorManager.SENSOR_DELAY_GAME)
        }
        baselineAltitudeMeters = null
        lastRelativeAltitudeMeters = null
        barometer?.let {
            sensorManager.registerListener(barometerListener, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
        startTimer()
        scope.launch { runCatching { exerciseClient.resumeExerciseAsync().await() } }
    }

    fun stopRide() {
        if (!isRecording.value) return
        sensorManager.unregisterListener(accelListener)
        sensorManager.unregisterListener(barometerListener)
        locationTracker.stop()
        timerJob?.cancel()
        context.stopService(Intent(context, RideForegroundService::class.java))

        val end = System.currentTimeMillis()
        isRecording.value = false
        isPaused.value = false

        scope.launch {
            runCatching { exerciseClient.endExerciseAsync().await() }
            finalizeRide(end)
        }
    }

    /** No-op placeholder -- actual runtime permission prompts
     * (ACCESS_FINE_LOCATION, BODY_SENSORS, ACTIVITY_RECOGNITION) happen in
     * MainActivity via ActivityResultContracts, since that needs an
     * Activity context this class deliberately doesn't hold. Kept here so
     * MainActivity has one obvious place to call on launch, mirroring
     * RideManager.swift's requestPermissions() entry point. */
    fun requestPermissions() {}

    fun retryPendingUploads() {
        scope.launch {
            for (ride in rideStore.pendingUploadRides()) {
                if (uploadService.upload(ride) is UploadService.UploadResult.Success) {
                    rideStore.save(ride.copy(uploaded = true))
                }
            }
        }
    }

    private fun startTimer() {
        timerJob = scope.launch {
            while (isActive) {
                elapsedSeconds.value = (System.currentTimeMillis() - rideStartMillis) / 1000.0
                delay(1000)
            }
        }
    }

    private fun recordBump(magnitudeG: Double) {
        val ride = currentRide ?: return
        val location = locationTracker.lastLocation
        val bump = BumpEvent(
            rideElapsedSeconds = (System.currentTimeMillis() - rideStartMillis) / 1000.0,
            magnitudeG = magnitudeG,
            latitude = location?.latitude ?: 0.0,
            longitude = location?.longitude ?: 0.0,
            horizontalAccuracyMeters = location?.accuracy?.toDouble() ?: -1.0,
            speedMetersPerSecond = location?.speed?.toDouble() ?: -1.0,
            headingDegrees = location?.bearing?.toDouble() ?: -1.0,
            heartRateBPM = currentHeartRateBPM.value,
        )
        ride.bumps.add(bump)
        bumpCount.value = ride.bumps.size
        lastBumpMagnitudeG.value = magnitudeG

        // Left in deliberately, same as RideManager.swift's recordBump():
        // the fastest way to see real magnitudes while thresholdG is
        // still being validated on this platform's hardware.
        android.util.Log.d("BumpWatch", "bump #${bumpCount.value}: ${"%.2f".format(magnitudeG)}g")

        val now = System.currentTimeMillis()
        if (bumpCount.value == 1 || now - lastSaveMillis > 3000) {
            rideStore.save(ride)
            lastSaveMillis = now
        }
    }

    // Called on every GPS fix (see the onLocationUpdate wiring in init{}
    // above), completely independent of bump detection -- a ride with
    // zero bumps still traces its full route. Only appends a point once
    // the bike has moved at least ROUTE_POINT_MIN_SPACING_METERS from the
    // last recorded one, and stops entirely once MAX_ROUTE_POINTS_PER_RIDE
    // is hit rather than growing the payload without bound.
    private fun maybeRecordRoutePoint(location: Location) {
        val ride = currentRide ?: return
        if (ride.routePoints.size >= MAX_ROUTE_POINTS_PER_RIDE) return

        lastRoutePointLocation?.let { last ->
            if (location.distanceTo(last) < ROUTE_POINT_MIN_SPACING_METERS) return
        }
        lastRoutePointLocation = location

        ride.routePoints.add(
            RoutePoint(
                rideElapsedSeconds = (location.time - rideStartMillis) / 1000.0,
                latitude = location.latitude,
                longitude = location.longitude,
            )
        )
    }

    companion object {
        // A ride, once started, needs to stay backed by the SAME
        // RideManager instance for as long as it's recording -- its live
        // StateFlows (isRecording, elapsedSeconds, heart rate, etc.) are
        // the only place that state lives; nothing is persisted or
        // shared any other way. MainActivity used to construct a fresh
        // RideManager in onCreate() every time, which is fine for a
        // normal cold start but wrong for the exact scenario
        // RideForegroundService exists for: its OngoingActivity
        // notification's touch intent (or just reopening the app from
        // the app list) launches a NEW MainActivity instance while the
        // process -- and the ride actually still recording in the
        // background -- never died. Without this, that reopened
        // Activity constructed a brand new RideManager whose
        // isRecording defaulted back to false, so the UI showed the
        // pre-recording Start screen even though a ride was still
        // actively being tracked underneath it (the OngoingActivity
        // indicator staying visible the whole time was the tell).
        // Routing every caller through shared() instead keeps the app on
        // one RideManager instance for the process's whole lifetime, so
        // a reopened Activity's Compose UI just re-observes the same
        // live StateFlows instead of starting over.
        @Volatile
        private var sharedInstance: RideManager? = null

        fun shared(context: Context): RideManager {
            return sharedInstance ?: synchronized(this) {
                sharedInstance ?: RideManager(context.applicationContext).also { sharedInstance = it }
            }
        }
    }

    private fun finalizeRide(endMillis: Long) {
        val ride = currentRide ?: return
        val finished = ride.copy(
            endTime = Instant.ofEpochMilli(endMillis).toString(),
            averageHeartRateBPM = rideAverageHeartRateBPM,
            maxHeartRateBPM = rideMaxHeartRateBPM,
        )
        currentRide = null
        rideStore.save(finished)

        scope.launch {
            if (uploadService.upload(finished) is UploadService.UploadResult.Success) {
                rideStore.save(finished.copy(uploaded = true))
            }
            // Failure: left on disk with uploaded=false; retryPendingUploads()
            // picks it up later, same recovery path as the Watch app.
        }
    }
}
