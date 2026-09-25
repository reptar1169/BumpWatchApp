package com.jeffschoello.bumpwatch.wear

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.jeffschoello.bumpwatch.wear.ride.RideManager
import com.jeffschoello.bumpwatch.wear.ui.RootScreen

class MainActivity : ComponentActivity() {
    private lateinit var rideManager: RideManager

    /** Set when a Start tap had to ask for permissions first, so the ride
     * starts as soon as the prompt closes instead of needing a second tap. */
    private var startRideAfterPermissions = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        /* Results aren't branched on here -- a denial surfaces later as
           lastError once the call that actually needed it (starting the
           exercise session, or the first location fix) fails, the same
           "let the real failure be the signal" approach
           refreshWorkoutAuthorizationStatus() takes on the Swift side. */
        if (startRideAfterPermissions) {
            startRideAfterPermissions = false
            rideManager.startRide()
        }
    }

    /**
     * Permissions are requested when Start is tapped, not at launch. Asking
     * from onCreate collided with the launch screen: on a fresh install the
     * permission prompt never appeared, and the app sat dimmed and ignoring
     * every touch until it was closed and reopened. Asking in context -- right
     * when the user starts a ride -- is also what Wear OS guidelines
     * recommend.
     */
    private fun startRideWithPermissions() {
        val missing = requiredPermissions().filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            rideManager.startRide()
        } else {
            startRideAfterPermissions = true
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    /** Only the permissions that actually exist on this OS version -- asking
     * for one that doesn't (e.g. BODY_SENSORS on API 36+, where the manifest
     * caps it at maxSdkVersion 35) is auto-denied, and would otherwise make
     * every single Start tap look like it's missing something. */
    private fun requiredPermissions(): List<String> = buildList {
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        add(Manifest.permission.ACTIVITY_RECOGNITION)
        if (Build.VERSION.SDK_INT >= 36) {
            // Starting with targetSdk 36, heart rate access through Health
            // Services needs this health-permission-group string instead of
            // BODY_SENSORS (see AndroidManifest.xml's comment on it) --
            // a raw literal since it's not guaranteed to exist yet as a
            // Manifest.permission.* constant.
            add("android.permission.health.READ_HEART_RATE")
        } else {
            add(Manifest.permission.BODY_SENSORS)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            // For RideForegroundService's notification -- required at
            // runtime from API 33 on, doesn't exist before that.
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Must run before super.onCreate -- shows the branded launch screen
        // (app icon on black, see res/values/themes.xml) that Play's Wear
        // quality guidelines require, then switches to the normal theme.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        rideManager = RideManager.shared(applicationContext)
        rideManager.retryPendingUploads()

        setContent {
            RootScreen(rideManager, onStartRide = ::startRideWithPermissions)
        }
    }
}
