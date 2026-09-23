package com.jeffschoello.bumpwatch.wear.network

import com.jeffschoello.bumpwatch.wear.auth.AuthService
import com.jeffschoello.bumpwatch.wear.model.RideRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Sends a finished ride to the submitRide Cloud Function -- the exact same
 * server-side contract UploadService.swift POSTs to (see
 * functions/index.js), so a ride recorded on this Android app lands in
 * Firestore in precisely the same shape as one from the Watch app. We go
 * through the Function (rather than writing to Firestore directly, which
 * the Firestore SDK *does* support here, unlike watchOS) because
 * firestore.rules denies client writes to rides/bumps outright --
 * submitRide via the Admin SDK is the only path in, on either platform.
 */
class UploadService(private val authService: AuthService = AuthService()) {
    private val client = OkHttpClient()
    private val json = Json { encodeDefaults = true }

    /** Matches UploadService.swift's endpoint exactly. */
    private val endpoint = "https://us-east1-bikelanebumps.cloudfunctions.net/submitRide"

    sealed class UploadResult {
        object Success : UploadResult()
        data class Failure(val reason: String) : UploadResult()
    }

    suspend fun upload(ride: RideRecord): UploadResult = withContext(Dispatchers.IO) {
        try {
            val idToken = authService.currentIdToken()
            val body = json.encodeToString(RideRecord.serializer(), ride)
                .toRequestBody("application/json; charset=utf-8".toMediaType())

            val request = Request.Builder()
                .url(endpoint)
                .addHeader("Authorization", "Bearer $idToken")
                .post(body)
                .build()

            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    UploadResult.Success
                } else {
                    UploadResult.Failure("Server rejected upload: HTTP ${response.code}")
                }
            }
        } catch (error: Exception) {
            // Ride stays marked not-yet-uploaded on disk either way --
            // RideManager.retryPendingUploads() tries again later, same
            // recovery path as UploadService.swift's transport-error case.
            UploadResult.Failure(error.message ?: "Unknown upload error")
        }
    }
}
