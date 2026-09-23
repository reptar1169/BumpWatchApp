package com.jeffschoello.bumpwatch.wear

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import com.jeffschoello.bumpwatch.wear.ride.RideManager
import com.jeffschoello.bumpwatch.wear.ui.RootScreen

class MainActivity : ComponentActivity() {
    private lateinit var rideManager: RideManager

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* Results aren't branched on here -- a denial surfaces later as
           lastError once the call that actually needed it (starting the
           exercise session, or the first location fix) fails, the same
           "let the real failure be the signal" approach
           refreshWorkoutAuthorizationStatus() takes on the Swift side. */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        rideManager = RideManager.shared(applicationContext)

        permissionLauncher.launch(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.BODY_SENSORS,
                // Starting with targetSdk 36, heart rate access through
                // Health Services needs this new health-permission-group
                // string too (see AndroidManifest.xml's comment on it) --
                // requesting it as a raw literal since it's not guaranteed
                // to exist yet as a Manifest.permission.* constant.
                "android.permission.health.READ_HEART_RATE",
                Manifest.permission.ACTIVITY_RECOGNITION,
                // For RideForegroundService's notification -- a no-op on
                // pre-33 devices, required at runtime from API 33 on.
                Manifest.permission.POST_NOTIFICATIONS,
            )
        )
        rideManager.retryPendingUploads()

        setContent {
            RootScreen(rideManager)
        }
    }
}
