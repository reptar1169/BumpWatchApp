package com.jeffschoello.bumpwatch.wear.model

import kotlinx.serialization.Serializable

/**
 * A single detected "bump" (pothole, crack, expansion joint, etc.) --
 * mirrors BumpEvent.swift field-for-field so functions/index.js's
 * submitRide handler (the shared contract both platforms POST to) doesn't
 * need to know or care which platform sent a given ride.
 */
@Serializable
data class BumpEvent(
    /** Seconds since the ride started -- the server derives absolute time
     * from the ride's startTime + this offset. */
    val rideElapsedSeconds: Double,
    /** Peak acceleration magnitude of the bump, in g's, gravity removed. */
    val magnitudeG: Double,
    val latitude: Double,
    val longitude: Double,
    /** Horizontal accuracy of the GPS fix used for this bump, in meters. */
    val horizontalAccuracyMeters: Double,
    /** Speed in meters/second. -1 if unknown -- matches BumpEvent.swift's
     * sentinel convention (see its comment for why this is -1 and not a
     * JSON null on the wire; functions/index.js's write path only ever
     * sees a real number from either platform). */
    val speedMetersPerSecond: Double,
    /** Degrees clockwise from true north. -1 if unknown, same convention
     * as speedMetersPerSecond above. */
    val headingDegrees: Double,
    /** Heart rate (bpm) at the moment of the bump, null if unavailable. */
    val heartRateBPM: Double? = null,
)
