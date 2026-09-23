package com.jeffschoello.bumpwatch.wear.sensors

import kotlin.math.max
import kotlin.math.sqrt

/**
 * Turns a stream of accelerometer samples into discrete "bump" events --
 * a direct port of BumpDetector.swift's peak-detection algorithm, so both
 * platforms behave identically given the same input. The threshold/
 * debounce values are carried over as-is from BumpDetector.swift's own
 * field-tuning history (see its header comment) as a starting point --
 * Android's sensor characteristics and wrist-mount behavior may call for
 * retuning once this actually runs on real hardware, which nothing here
 * can substitute for. RideManager logs every recorded bump's magnitude,
 * same as the Swift side, so watch that during a real ride the same way.
 */
class BumpDetector {
    /** Minimum peak magnitude (in g) to count as a bump. */
    var thresholdG: Double = 3.0

    /** Minimum time between two counted bumps, in seconds. */
    var debounceIntervalSeconds: Double = 0.3

    private var lastBumpTimeSeconds: Double? = null
    private var risingEdgeMagnitude: Double = 0.0
    private var isTrackingPeak: Boolean = false

    /**
     * Feed one linear-acceleration sample in.
     *
     * @param xG, yG, zG each axis in **g's**, NOT the raw m/s^2 a sensor
     *   reports -- the caller (RideManager, using Sensor.TYPE_LINEAR_ACCELERATION,
     *   Android's equivalent of CoreMotion's already-gravity-removed
     *   userAcceleration) is responsible for the /9.80665 conversion, so
     *   thresholdG stays directly comparable to BumpDetector.swift's.
     * @param timestampSeconds any consistently-increasing clock (e.g.
     *   a sensor event's nanosecond timestamp / 1e9) -- only the
     *   difference between calls matters, not the absolute value.
     * @return the peak magnitude (in g) if this sample completes a
     *   qualifying bump, otherwise null.
     */
    fun ingest(xG: Double, yG: Double, zG: Double, timestampSeconds: Double): Double? {
        val magnitude = sqrt(xG * xG + yG * yG + zG * zG)

        if (magnitude >= thresholdG) {
            isTrackingPeak = true
            risingEdgeMagnitude = max(risingEdgeMagnitude, magnitude)
            return null
        }

        if (!isTrackingPeak) return null
        isTrackingPeak = false
        val peak = risingEdgeMagnitude
        risingEdgeMagnitude = 0.0

        val last = lastBumpTimeSeconds
        if (last != null && (timestampSeconds - last) < debounceIntervalSeconds) {
            return null
        }

        lastBumpTimeSeconds = timestampSeconds
        return peak
    }

    fun reset() {
        lastBumpTimeSeconds = null
        risingEdgeMagnitude = 0.0
        isTrackingPeak = false
    }
}
