package com.jeffschoello.bumpwatch.wear.location

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Thin wrapper around FusedLocationProviderClient that just keeps the most
 * recent fix around, mirroring LocationTracker.swift's role: RideManager
 * reads lastLocation to tag a bump, rather than every reader needing to be
 * its own location callback.
 */
class LocationTracker(context: Context) {
    private val client: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(context)

    var lastLocation: Location? = null
        private set

    /** Fires on every fix, same rate as lastLocation updates -- RideManager
     * uses this to sample route points independently of bump detection
     * (see RideManager.maybeRecordRoutePoint). Not throttled here on
     * purpose: the distance-based "is this far enough from the last
     * recorded point" decision belongs to whoever's building the route,
     * not to this thin wrapper -- mirrors LocationTracker.swift's
     * onLocationUpdate. */
    var onLocationUpdate: ((Location) -> Unit)? = null

    // High accuracy for outdoor cycling -- same reasoning as
    // LocationTracker.swift's kCLLocationAccuracyBest: we're paying the
    // battery cost anyway via the exercise session.
    private val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L).build()

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let {
                lastLocation = it
                onLocationUpdate?.invoke(it)
            }
        }
    }

    // Caller (RideManager.startRide(), via MainActivity's permission
    // launcher) is responsible for ACCESS_FINE_LOCATION already being
    // granted before this is called.
    @SuppressLint("MissingPermission")
    fun start() {
        client.requestLocationUpdates(request, callback, null)
    }

    fun stop() {
        client.removeLocationUpdates(callback)
    }
}
