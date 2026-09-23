package com.jeffschoello.bumpwatch.wear.model

import kotlinx.serialization.Serializable
import java.util.UUID

/**
 * A full ride: metadata plus every bump detected during it.
 *
 * startTime/endTime are ISO-8601 strings rather than a typed instant --
 * this mirrors what JSONEncoder(.iso8601) actually puts on the wire from
 * the Swift side, and it's exactly what functions/index.js's
 * `new Date(ride.startTime)` expects. RideManager builds these with
 * java.time.Instant.toString(), which produces the same format.
 */
/**
 * A single GPS sample taken periodically throughout the ride to trace its
 * actual path -- unlike BumpEvent, this isn't tied to a detected bump, it's
 * just "the bike was here at this point in the ride." Mirrors
 * RoutePoint in BumpEvent.swift field-for-field. See
 * RideManager.maybeRecordRoutePoint(_:) for the distance-based sampling
 * rule (roughly one point every 20m). This is what lets the map show which
 * streets were actually ridden, not just where a bump happened to occur.
 */
@Serializable
data class RoutePoint(
    /** Seconds since the ride started -- same convention as
     * BumpEvent.rideElapsedSeconds. */
    val rideElapsedSeconds: Double,
    val latitude: Double,
    val longitude: Double,
)

@Serializable
data class RideRecord(
    val id: String = UUID.randomUUID().toString(),
    val startTime: String,
    val endTime: String? = null,
    val bumps: MutableList<BumpEvent> = mutableListOf(),
    /** The ride's actual path, sampled roughly every 20m -- see
     * RoutePoint. Capped at RideManager's maxRoutePointsPerRide; separate
     * from bumps entirely (a ride can have route points and zero bumps,
     * which is the whole point -- see the "ride coverage" map layer this
     * feeds). */
    val routePoints: MutableList<RoutePoint> = mutableListOf(),
    /** Local-only bookkeeping -- not read by the server, same as
     * RideRecord.swift's `uploaded` field (see UploadService.swift: it
     * gets serialized and sent along anyway there too; submitRide simply
     * ignores fields it doesn't recognize). Lets RideStore know which
     * rides on disk still need to be (re)uploaded. */
    var uploaded: Boolean = false,
    val averageHeartRateBPM: Double? = null,
    val maxHeartRateBPM: Double? = null,
)
