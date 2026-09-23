package com.jeffschoello.bumpwatch.wear.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.Text
import com.jeffschoello.bumpwatch.wear.R
import com.jeffschoello.bumpwatch.wear.ride.RideManager
import kotlin.math.roundToInt

// ---------------------------------------------------------------------
// NOTE ON CONFIDENCE: the swipe-page mechanics here (androidx.wear.compose
// .foundation.pager.HorizontalPager, imported alongside
// androidx.wear.compose.material3's Button/Text) are written from best
// current knowledge of the Wear Compose library, not verified against a
// compiler. If HorizontalPager's exact package/API shape has moved by the
// time this is opened in Android Studio, the fix is almost always just an
// import change or a small parameter rename -- the page content below
// (MainPage/StatsPage) doesn't depend on Pager internals and shouldn't
// need to change either way.
// ---------------------------------------------------------------------

/**
 * Root screen: a swipeable two-page layout, mirroring ContentView.swift's
 * TabView(.page) -- page 0 is the recording controls (start/pause/finish,
 * elapsed time, heart rate, bump count), page 1 is live distance/
 * calories/elevation. Swipe-between-pages is watchOS's own native
 * convention on the Swift side; HorizontalPager here is Wear Compose's
 * equivalent for the same gesture.
 */
@Composable
fun RootScreen(rideManager: RideManager) {
    val pagerState = rememberPagerState(pageCount = { 2 })
    HorizontalPager(state = pagerState) { page ->
        when (page) {
            0 -> MainPage(rideManager)
            else -> StatsPage(rideManager)
        }
    }
}

@Composable
private fun MainPage(rideManager: RideManager) {
    val isRecording by rideManager.isRecording.collectAsState()
    val isPaused by rideManager.isPaused.collectAsState()
    val elapsedSeconds by rideManager.elapsedSeconds.collectAsState()
    val bumpCount by rideManager.bumpCount.collectAsState()
    val lastBumpMagnitudeG by rideManager.lastBumpMagnitudeG.collectAsState()
    val heartRate by rideManager.currentHeartRateBPM.collectAsState()
    val lastError by rideManager.lastError.collectAsState()

    Column(
        modifier = Modifier.fillMaxSize().padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (isRecording) {
            Text(
                "♥ ${heartRate?.roundToInt() ?: "--"}",
                fontWeight = FontWeight.Bold,
                fontSize = 32.sp,
            )

            if (isPaused) {
                Text("Paused")
            }

            Text(formatElapsed(elapsedSeconds), fontSize = 18.sp)

            val magnitudeSuffix = lastBumpMagnitudeG?.let { " · last ${"%.2f".format(it)}g" } ?: ""
            Text("$bumpCount bumps$magnitudeSuffix", fontSize = 18.sp)

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { if (isPaused) rideManager.resumeRide() else rideManager.pauseRide() },
                    colors = if (isPaused) {
                        // Resume -- same green as the pre-recording Start
                        // button, since it's the same "go" action.
                        ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF34C759),
                            contentColor = Color.White,
                        )
                    } else {
                        ButtonDefaults.buttonColors(
                            containerColor = Color(0xFFFFA000),
                            contentColor = Color.Black,
                        )
                    },
                ) {
                    Text(if (isPaused) "Resume" else "Pause")
                }
                Button(
                    onClick = { rideManager.stopRide() },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFFE53935),
                        contentColor = Color.White,
                    ),
                ) {
                    Text("Finish")
                }
            }
        } else {
            // The launcher glyph itself (res/drawable/brand_logo.png --
            // cropped straight out of the same source icon used for
            // mipmap-*/ic_launcher_foreground.png, just without the
            // adaptive-icon safe-zone shrink since this isn't a launcher
            // icon). The title text below is colored with a gradient
            // sampled from that same glyph's own yellow-to-red bar
            // (#FFC03D -> #FF4E3D) so the wordmark reads as one mark
            // with the logo instead of plain default-styled text next
            // to it.
            Image(
                painter = painterResource(R.drawable.brand_logo),
                contentDescription = null,
                modifier = Modifier.height(64.dp),
            )
            Text(
                "Bike Lane Bumps",
                style = TextStyle(
                    brush = Brush.linearGradient(
                        colors = listOf(Color(0xFFFFC03D), Color(0xFFFF4E3D)),
                    ),
                ),
                fontWeight = FontWeight.Bold,
                fontSize = 20.sp,
            )
            Text("Tap to start recording your ride")
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = { rideManager.startRide() },
                modifier = Modifier.height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF34C759),
                    contentColor = Color.White,
                ),
            ) {
                Text("Start", fontSize = 18.sp)
            }
        }

        lastError?.let { Text(it) }
    }
}

/** The swipe-right page: live distance, calories, and elevation gain --
 * same three stats and "--" placeholder approach as ContentView.swift's
 * statsPage. */
@Composable
private fun StatsPage(rideManager: RideManager) {
    val distanceMeters by rideManager.currentDistanceMeters.collectAsState()
    val calories by rideManager.currentActiveEnergyKcal.collectAsState()
    val elevationMeters by rideManager.elevationGainMeters.collectAsState()

    Column(
        modifier = Modifier.fillMaxSize().padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // Miles/feet, matching the mph conversion already used for speed
        // elsewhere in this project (see UploadService.swift/app.js's
        // popup) rather than mixing unit systems across platforms.
        StatTile("Distance", distanceMeters?.let { "%.2f mi".format(it * 0.000621371) } ?: "-- mi")
        StatTile("Calories", calories?.let { "${it.roundToInt()} cal" } ?: "-- cal")
        StatTile("Elevation", "%.0f ft".format(elevationMeters * 3.28084))
    }
}

@Composable
private fun StatTile(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, fontWeight = FontWeight.SemiBold, fontSize = 22.sp)
        Text(label, fontSize = 15.sp)
    }
}

private fun formatElapsed(totalSeconds: Double): String {
    val total = totalSeconds.toInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return "%02d:%02d:%02d".format(h, m, s)
}
