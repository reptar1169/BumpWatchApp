package com.jeffschoello.bumpwatch.wear.ride

import android.content.Context
import android.util.Log
import com.jeffschoello.bumpwatch.wear.model.RideRecord
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Persists rides to disk as individual JSON files under filesDir/rides/ --
 * the same "write incrementally as it records, delete only once the
 * server has confirmed the upload" approach as RideStore.swift, so a ride
 * is never lost to a crash or a killed process mid-ride.
 */
class RideStore(context: Context) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val ridesDir = File(context.filesDir, "rides").apply { mkdirs() }

    private fun fileFor(rideId: String) = File(ridesDir, "$rideId.json")

    fun save(ride: RideRecord) {
        try {
            fileFor(ride.id).writeText(json.encodeToString(RideRecord.serializer(), ride))
        } catch (error: Exception) {
            Log.e("RideStore", "save error", error)
        }
    }

    fun delete(ride: RideRecord) {
        fileFor(ride.id).delete()
    }

    /** All rides currently on disk, most recent first. Includes rides
     * still pending upload (e.g. from a previous launch that ended
     * without connectivity). */
    fun allRides(): List<RideRecord> =
        (ridesDir.listFiles { f -> f.extension == "json" }?.toList() ?: emptyList())
            .mapNotNull { f ->
                runCatching { json.decodeFromString(RideRecord.serializer(), f.readText()) }.getOrNull()
            }
            .sortedByDescending { it.startTime }

    fun pendingUploadRides(): List<RideRecord> = allRides().filter { !it.uploaded }
}
