package com.jeffschoello.bumpwatch.wear.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberOverscrollEffect
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.EdgeButtonSize
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import com.jeffschoello.bumpwatch.wear.R
import com.jeffschoello.bumpwatch.wear.ride.RideManager
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

// Same palette the previous layout used for Start/Pause/Finish, so the
// controls keep their meaning across the redesign.
private val Green = Color(0xFF34C759)
private val Amber = Color(0xFFFFA000)
private val Red = Color(0xFFE53935)

// Page order mirrors ContentView.swift and Apple's own Workout app:
// [controls] <- [metrics] -> [more stats]. Metrics is where a ride opens,
// so a glance mid-ride shows numbers only, and Pause/End take a deliberate
// swipe right to reach -- no accidental taps on a bumpy road.
private const val PAGE_CONTROLS = 0
private const val PAGE_METRICS = 1
private const val PAGE_MORE_STATS = 2
private const val PAGE_COUNT = 3

/**
 * Root screen. Before a ride: a single Start screen (no paging -- the
 * distance/calories/elevation page used to be reachable pre-ride but only
 * ever showed "--" placeholders). During a ride: the three-page pager
 * above.
 */
@Composable
fun RootScreen(rideManager: RideManager, onStartRide: () -> Unit) {
    val isRecording by rideManager.isRecording.collectAsState()
    if (isRecording) {
        RecordingPager(rideManager)
    } else {
        StartScreen(rideManager, onStartRide)
    }
}

@Composable
private fun RecordingPager(rideManager: RideManager) {
    // RecordingPager leaves composition whenever a ride ends (RootScreen
    // swaps in StartScreen), so this state is created fresh for every new
    // ride -- initialPage alone is enough to always open on metrics, no
    // separate "reset on start" effect needed (unlike the SwiftUI side,
    // where the selection @State outlives the TabView).
    val pagerState = rememberPagerState(initialPage = PAGE_METRICS, pageCount = { PAGE_COUNT })
    val scope = rememberCoroutineScope()

    HorizontalPager(state = pagerState) { page ->
        when (page) {
            PAGE_CONTROLS -> ControlsPage(
                rideManager = rideManager,
                // Resuming slides back to metrics, the way the Workout app
                // does; pausing stays put so Resume/End are right there.
                onResumed = { scope.launch { pagerState.animateScrollToPage(PAGE_METRICS) } },
            )
            PAGE_METRICS -> MetricsPage(rideManager)
            PAGE_MORE_STATS -> MoreStatsPage(rideManager)
        }
    }
}

/**
 * Every page is a ScalingLazyColumn rather than a fixed, centered Column.
 * Google Play rejected 9.0 because with a large system font size the Start
 * screen's text ran off the round edges and the Start button was pushed off
 * the bottom entirely -- a fixed Column has nowhere for overflow to go. This
 * scrolls (touch and rotary crown/bezel) when content doesn't fit, auto-
 * centers when it does, and the horizontal inset keeps wrapped lines away
 * from the curved edges of a round display.
 */
@Composable
private fun PageColumn(content: ScalingLazyListScope.() -> Unit) {
    val screenWidth = LocalConfiguration.current.screenWidthDp.dp
    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = rememberScalingLazyListState(),
        contentPadding = PaddingValues(horizontal = screenWidth * 0.10f, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        content = content,
    )
}

// ---------------------------------------------------------------------
// Pre-ride
// ---------------------------------------------------------------------

/**
 * Start is an EdgeButton in a ScreenScaffold -- Wear's standard spot for a
 * screen's primary action. It hugs the bottom curve of a round display, so
 * it can't get clipped by the edge the way an ordinary full-width Button
 * sitting at the bottom of the list did, and the logo/title/text above it
 * scroll independently if a large font size makes them taller than the
 * screen.
 */
@Composable
private fun StartScreen(rideManager: RideManager, onStartRide: () -> Unit) {
    val lastError by rideManager.lastError.collectAsState()
    val listState = rememberScalingLazyListState()
    val screenWidth = LocalConfiguration.current.screenWidthDp.dp

    ScreenScaffold(
        scrollState = listState,
        contentPadding = PaddingValues(
            start = screenWidth * 0.10f,
            end = screenWidth * 0.10f,
            top = 20.dp,
        ),
        edgeButton = {
            EdgeButton(
                // Goes through MainActivity so any missing permissions get
                // asked for first -- see startRideWithPermissions().
                onClick = onStartRide,
                buttonSize = EdgeButtonSize.Medium,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Green,
                    contentColor = Color.White,
                ),
                // Lets a scroll gesture that starts on the button still
                // scroll the list, same as the Wear Material3 sample.
                modifier = Modifier.scrollable(
                    listState,
                    orientation = Orientation.Vertical,
                    reverseDirection = true,
                    overscrollEffect = rememberOverscrollEffect(),
                ),
            ) {
                Text("Start", fontSize = 18.sp)
            }
        },
    ) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            // Includes the bottom gap above the EdgeButton -- see
            // ScreenScaffold's edgeButtonSpacing.
            contentPadding = contentPadding,
            // Start from the top rather than centering an item mid-screen;
            // centering is what pushed the old Start button down into the
            // curved bottom edge.
            autoCentering = null,
        ) {
            item {
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
            }
            item {
                Text(
                    "Bike Lane Bumps",
                    style = TextStyle(
                        brush = Brush.linearGradient(
                            colors = listOf(Color(0xFFFFC03D), Color(0xFFFF4E3D)),
                        ),
                    ),
                    fontWeight = FontWeight.Bold,
                    fontSize = 20.sp,
                    textAlign = TextAlign.Center,
                )
            }
            item {
                Text("Tap to start recording your ride", textAlign = TextAlign.Center)
            }
            lastError?.let { message -> item { ErrorText(message) } }
        }
    }
}

// ---------------------------------------------------------------------
// In-ride pages
// ---------------------------------------------------------------------

/** Stats only -- no buttons. Heart rate, elapsed time, bump count. */
@Composable
private fun MetricsPage(rideManager: RideManager) {
    val isPaused by rideManager.isPaused.collectAsState()
    val elapsedSeconds by rideManager.elapsedSeconds.collectAsState()
    val bumpCount by rideManager.bumpCount.collectAsState()
    val lastBumpMagnitudeG by rideManager.lastBumpMagnitudeG.collectAsState()
    val heartRate by rideManager.currentHeartRateBPM.collectAsState()
    val lastError by rideManager.lastError.collectAsState()

    PageColumn {
        item {
            Text(
                "♥ ${heartRate?.roundToInt() ?: "--"}",
                fontWeight = FontWeight.Bold,
                fontSize = 32.sp,
                textAlign = TextAlign.Center,
            )
        }
        if (isPaused) {
            item { Text("Paused", color = Amber, textAlign = TextAlign.Center) }
        }
        item { Text(formatElapsed(elapsedSeconds), fontSize = 18.sp, textAlign = TextAlign.Center) }
        item {
            val magnitudeSuffix = lastBumpMagnitudeG?.let { " · last ${"%.2f".format(it)}g" } ?: ""
            Text("$bumpCount bumps$magnitudeSuffix", fontSize = 18.sp, textAlign = TextAlign.Center)
        }
        // Not a control, and rare (e.g. location permission denied) -- but
        // important enough mid-ride that it shouldn't hide on a page you'd
        // only visit to pause.
        lastError?.let { message -> item { ErrorText(message) } }
    }
}

/**
 * Swipe-right page: End and Pause/Resume, laid out like the Workout app's
 * controls (End on the left, Pause on the right, big tinted circles with a
 * label underneath).
 */
@Composable
private fun ControlsPage(rideManager: RideManager, onResumed: () -> Unit) {
    val isPaused by rideManager.isPaused.collectAsState()
    val elapsedSeconds by rideManager.elapsedSeconds.collectAsState()

    PageColumn {
        item {
            Text(
                formatElapsed(elapsedSeconds),
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (isPaused) Amber else Color.LightGray,
                textAlign = TextAlign.Center,
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                ControlButton(
                    glyph = ControlGlyph.End,
                    label = "End",
                    tint = Red,
                    onClick = { rideManager.stopRide() },
                )
                ControlButton(
                    glyph = if (isPaused) ControlGlyph.Play else ControlGlyph.Pause,
                    label = if (isPaused) "Resume" else "Pause",
                    tint = if (isPaused) Green else Amber,
                    onClick = {
                        if (isPaused) {
                            rideManager.resumeRide()
                            onResumed()
                        } else {
                            rideManager.pauseRide()
                        }
                    },
                )
            }
        }
    }
}

private enum class ControlGlyph { End, Pause, Play }

/**
 * Tinted translucent disc with a colored glyph, matching the SwiftUI side's
 * controlButton. The glyphs are drawn on a Canvas rather than pulled from an
 * icon set, since this module doesn't depend on material-icons and three
 * simple shapes don't justify adding it.
 */
@Composable
private fun ControlButton(glyph: ControlGlyph, label: String, tint: Color, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(58.dp)
                .clip(CircleShape)
                .background(tint.copy(alpha = 0.25f))
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(modifier = Modifier.size(22.dp)) {
                val w = size.width
                val h = size.height
                when (glyph) {
                    ControlGlyph.End -> {
                        val stroke = 3.dp.toPx()
                        drawLine(tint, Offset(0f, 0f), Offset(w, h), stroke, StrokeCap.Round)
                        drawLine(tint, Offset(w, 0f), Offset(0f, h), stroke, StrokeCap.Round)
                    }
                    ControlGlyph.Pause -> {
                        val barWidth = w * 0.32f
                        val radius = CornerRadius(barWidth / 3f)
                        drawRoundRect(tint, Offset(w * 0.08f, 0f), Size(barWidth, h), radius)
                        drawRoundRect(tint, Offset(w * 0.60f, 0f), Size(barWidth, h), radius)
                    }
                    ControlGlyph.Play -> {
                        val path = Path().apply {
                            moveTo(w * 0.15f, 0f)
                            lineTo(w, h / 2f)
                            lineTo(w * 0.15f, h)
                            close()
                        }
                        drawPath(path, tint)
                    }
                }
            }
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(label, fontSize = 13.sp, color = Color.LightGray, textAlign = TextAlign.Center)
    }
}

/** Swipe-left page (right of metrics): live distance, calories, and
 * elevation gain -- same three stats and "--" placeholder approach as
 * ContentView.swift's moreStatsPage. */
@Composable
private fun MoreStatsPage(rideManager: RideManager) {
    val distanceMeters by rideManager.currentDistanceMeters.collectAsState()
    val calories by rideManager.currentActiveEnergyKcal.collectAsState()
    val elevationMeters by rideManager.elevationGainMeters.collectAsState()

    PageColumn {
        // Miles/feet, matching the mph conversion already used for speed
        // elsewhere in this project (see UploadService.swift/app.js's
        // popup) rather than mixing unit systems across platforms.
        item { StatTile("Distance", distanceMeters?.let { "%.2f mi".format(it * 0.000621371) } ?: "-- mi") }
        item { StatTile("Calories", calories?.let { "${it.roundToInt()} cal" } ?: "-- cal") }
        item { StatTile("Elevation", "%.0f ft".format(elevationMeters * 3.28084)) }
    }
}

@Composable
private fun StatTile(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, textAlign = TextAlign.Center)
        Text(label, fontSize = 15.sp, textAlign = TextAlign.Center)
    }
}

@Composable
private fun ErrorText(message: String) {
    Text(message, fontSize = 12.sp, color = Red, textAlign = TextAlign.Center)
}

private fun formatElapsed(totalSeconds: Double): String {
    val total = totalSeconds.toInt()
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return "%02d:%02d:%02d".format(h, m, s)
}
