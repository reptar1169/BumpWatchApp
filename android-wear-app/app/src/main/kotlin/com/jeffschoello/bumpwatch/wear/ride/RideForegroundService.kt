package com.jeffschoello.bumpwatch.wear.ride

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import com.jeffschoello.bumpwatch.wear.MainActivity
import com.jeffschoello.bumpwatch.wear.R

/**
 * Exists for one reason: to be the actual foreground-service component
 * backing the FOREGROUND_SERVICE_HEALTH/FOREGROUND_SERVICE_LOCATION
 * manifest permissions, and to post the visible "recording your ride"
 * notification (as an OngoingActivity, so it also shows on the watch
 * face) for as long as a ride is active.
 *
 * RideManager still owns all the real exercise/sensor/location logic --
 * it already runs off applicationContext rather than the Activity, so
 * this service doesn't duplicate any of that. It's here because Health
 * Services' own docs are explicit that ExerciseClient alone doesn't keep
 * the process alive or show anything to the user in the background:
 * "Use a continuously running ForegroundService in conjunction with
 * ExerciseClient to help ensure correct operation for the entire
 * workout" (developer.android.com/health-and-fitness/health-services/active-data),
 * and separately, Play Console's own FOREGROUND_SERVICE_HEALTH policy
 * requires the permission's use to be "noticeable to the user when
 * they're not directly interacting with your app" -- an OngoingActivity
 * is the standard way to satisfy that on Wear OS (see
 * developer.android.com/training/wearables/notifications/ongoing-activity).
 *
 * Without this, a ride recording in the background risked being silently
 * killed by the OS with nothing to show for it -- this isn't just a
 * Play Store paperwork fix.
 */
class RideForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        postForegroundNotification()
        return START_NOT_STICKY
    }

    private fun postForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Ride recording",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }

        val launchIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )

        val notificationBuilder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Bike Lane Bumps")
            .setContentText("Recording your ride")
            .setSmallIcon(R.drawable.brand_logo)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_WORKOUT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(launchIntent)

        // OngoingActivity is what actually surfaces this on the watch
        // face (not just the notification shade) -- the Google-recommended
        // pattern this whole service exists to implement. Both a static
        // icon and a touch intent are required (or it throws).
        val status = Status.Builder()
            .addTemplate("Recording your ride")
            .build()
        val ongoingActivity = OngoingActivity.Builder(applicationContext, NOTIFICATION_ID, notificationBuilder)
            .setStaticIcon(R.drawable.brand_logo)
            .setTouchIntent(launchIntent)
            .setStatus(status)
            .build()
        ongoingActivity.apply(applicationContext)

        val notification = notificationBuilder.build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val CHANNEL_ID = "ride_recording"
        private const val NOTIFICATION_ID = 4201
    }
}
