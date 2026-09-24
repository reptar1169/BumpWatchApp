import SwiftUI

struct ContentView: View {
    @StateObject private var rideManager = RideManager()

    /// Which page of the in-ride TabView is showing. Mirrors Apple's own
    /// Workout app: controls sit to the LEFT of the metrics (swipe right to
    /// reach Pause/End), metrics are what you land on, and extra stats sit
    /// to the right.
    private enum RecordingPage: Hashable {
        case controls, metrics, moreStats
    }

    @State private var recordingPage: RecordingPage = .metrics

    var body: some View {
        Group {
            if rideManager.isRecording {
                recordingPages
            } else {
                startScreen
            }
        }
        .onAppear {
            rideManager.requestPermissions()
            UploadService.shared.retryPendingUploads()
        }
        // Every new ride opens on the metrics page, never on whichever page
        // the previous ride happened to end on (usually controls, since
        // that's where End lives).
        .onChange(of: rideManager.isRecording) { _, isRecording in
            if isRecording { recordingPage = .metrics }
        }
    }

    // MARK: - Pre-ride

    /// Idle / starting screen. No paging here -- there's nothing to swipe
    /// to before a ride exists (the distance/calories/elevation page used
    /// to be reachable pre-ride, but only ever showed "--" placeholders).
    private var startScreen: some View {
        VStack(spacing: 8) {
            Text(statusText)
                .font(.headline)
            if rideManager.isStarting {
                // Deliberately not ProgressView() -- confirmed on-device
                // that it triggers a synchronous, first-time CoreUI
                // theme/asset load on watchOS (visible in the console as
                // "CUIThemeStore: No theme registered with id=0") that
                // stalls the main thread for multiple seconds, which is
                // exactly the freeze this state exists to avoid. The
                // headline above already reads "Starting…", so plain text
                // is enough here; this just reserves the same vertical
                // space so the layout doesn't jump.
                Text(" ")
                    .font(.caption)
            } else {
                Text("Tap to start recording your ride")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button(action: rideManager.startRide) {
                Text("Start")
                    .frame(maxWidth: .infinity)
            }
            .tint(.green)
            .buttonStyle(.borderedProminent)
            // Not hidden -- disabled. A HealthKit-session failure sets
            // lastError asynchronously and always clears isStarting, so
            // the button reliably comes back; disabling (rather than
            // hiding) keeps the layout stable while that resolves.
            .disabled(rideManager.isStarting)

            errorText
        }
        .padding()
    }

    // MARK: - In-ride pages

    /// Same layout as Apple's Workout app: [controls] <- [metrics] -> [more stats].
    /// Metrics is the default, so a glance at the wrist mid-ride shows
    /// numbers only, and Pause/End take a deliberate swipe to reach --
    /// no accidental taps on a bumpy road.
    private var recordingPages: some View {
        TabView(selection: $recordingPage) {
            controlsPage
                .tag(RecordingPage.controls)
            metricsPage
                .tag(RecordingPage.metrics)
            moreStatsPage
                .tag(RecordingPage.moreStats)
        }
        .tabViewStyle(.page(indexDisplayMode: .automatic))
    }

    /// Stats only -- no buttons. Heart rate, elapsed time, bump count.
    private var metricsPage: some View {
        VStack(spacing: 8) {
            heartRateHeadline

            if rideManager.isPaused {
                Text("Paused")
                    .font(.caption2)
                    .foregroundStyle(.yellow)
            }

            Text(formattedElapsed)
                .font(.system(.title2, design: .rounded).monospacedDigit())
            bumpCountLine
                .font(.caption)

            // Not a control, and rare (e.g. location access denied) -- but
            // important enough mid-ride that it shouldn't hide on a page
            // you'd only visit to pause.
            errorText
        }
        .padding()
    }

    /// Swipe-right page: End and Pause/Resume, laid out like the Workout
    /// app's controls (End on the left, Pause on the right, big tinted
    /// circles with a label underneath).
    private var controlsPage: some View {
        VStack(spacing: 10) {
            Text(formattedElapsed)
                .font(.system(.headline, design: .rounded).monospacedDigit())
                .foregroundStyle(rideManager.isPaused ? Color.yellow : Color.secondary)

            HStack(spacing: 20) {
                controlButton(
                    systemImage: "xmark",
                    label: "End",
                    tint: .red,
                    action: rideManager.stopRide
                )
                controlButton(
                    systemImage: rideManager.isPaused ? "play.fill" : "pause.fill",
                    label: rideManager.isPaused ? "Resume" : "Pause",
                    tint: rideManager.isPaused ? .green : .yellow,
                    action: togglePause
                )
            }
        }
        .padding()
    }

    /// A hand-built circle rather than `.buttonBorderShape(.circle)`, so the
    /// look is the Workout app's tinted-translucent-disc-with-colored-glyph
    /// rather than a solid filled button.
    private func controlButton(
        systemImage: String,
        label: String,
        tint: Color,
        action: @escaping @MainActor () -> Void
    ) -> some View {
        VStack(spacing: 4) {
            Button(action: action) {
                Image(systemName: systemImage)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(tint)
                    .frame(width: 58, height: 58)
                    .background(Circle().fill(tint.opacity(0.25)))
            }
            .buttonStyle(.plain)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var errorText: some View {
        if let error = rideManager.lastError {
            Text(error)
                .font(.caption2)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
        }
    }

    /// Swipe-left page (right of metrics): live distance, calories, and
    /// elevation gain. Shows "--" placeholders (mirroring
    /// heartRateValueText/bumpCountLine's existing approach) until the
    /// first sample of each type arrives, so the layout doesn't jump.
    private var moreStatsPage: some View {
        VStack(spacing: 14) {
            statTile(label: "Distance", value: distanceValueText)
            statTile(label: "Calories", value: calorieValueText)
            statTile(label: "Elevation", value: elevationValueText)
        }
        .padding()
    }

    private func statTile(label: String, value: String) -> some View {
        VStack(spacing: 0) {
            Text(value)
                .font(.system(.title3, design: .rounded).weight(.semibold).monospacedDigit())
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    /// Miles, matching the mph conversion already used for speed elsewhere
    /// in this project (see UploadService/app.js's popup) rather than
    /// mixing unit systems across the app.
    private var distanceValueText: String {
        guard let meters = rideManager.currentDistanceMeters else { return "-- mi" }
        return String(format: "%.2f mi", meters * 0.000621371)
    }

    private var calorieValueText: String {
        guard let kcal = rideManager.currentActiveEnergyKcal else { return "-- cal" }
        return "\(Int(kcal.rounded())) cal"
    }

    /// elevationGainMeters defaults to 0 rather than nil (a ride genuinely
    /// starts at zero gain), so this always has a real number to show --
    /// no placeholder branch needed, unlike distance/calories above.
    private var elevationValueText: String {
        String(format: "%.0f ft", rideManager.elevationGainMeters * 3.28084)
    }

    private var statusText: String {
        if rideManager.isStarting { return "Starting…" }
        return "BumpWatch"
    }

    private var formattedElapsed: String {
        let total = Int(rideManager.elapsedSeconds)
        return String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
    }

    /// "N bumps" plus, once at least one has landed, " · last X.XXg" with
    /// just the magnitude colored by severity -- keeps the live magnitude
    /// visible without adding a whole extra line to an already-tight watch
    /// screen. `.foregroundColor` (not `.foregroundStyle`) is what carries
    /// per-segment color through `Text` concatenation here.
    private var bumpCountLine: Text {
        let base = Text("\(rideManager.bumpCount) bumps")
            .foregroundColor(.secondary)
        guard let magnitude = rideManager.lastBumpMagnitudeG else { return base }
        let magnitudeText = Text(" · last \(String(format: "%.2f", magnitude))g")
            .foregroundColor(BumpSeverity.color(forMagnitudeG: magnitude))
        return base + magnitudeText
    }

    /// The main event of the recording screen -- previously a small
    /// caption2 "♥ 142 bpm" line, too small to read mid-ride. Now a
    /// headline-scale readout: a red heart glyph, rendered a size larger
    /// than the (bold, monospaced) number beside it so the heart itself
    /// draws the eye first, mirroring how dedicated fitness watch faces
    /// treat heart rate as the star of the screen rather than one stat
    /// among several.
    private var heartRateHeadline: some View {
        HStack(spacing: 4) {
            Text("♥")
                .font(.system(.largeTitle, design: .rounded))
                .foregroundColor(.red)
            Text(heartRateValueText)
                .font(.system(.title, design: .rounded).weight(.bold).monospacedDigit())
        }
    }

    /// "126" once a reading has arrived, or a plain placeholder beforehand
    /// -- mirrors bumpCountLine's "show something stable, fill in the real
    /// value once it lands" approach so the layout doesn't jump when the
    /// first heart rate sample comes in.
    private var heartRateValueText: String {
        guard let bpm = rideManager.currentHeartRateBPM else { return "--" }
        return "\(Int(bpm.rounded()))"
    }

    /// Pausing stays on the controls page (so Resume/End are right there);
    /// resuming slides back to metrics, the same way the Workout app does.
    private func togglePause() {
        if rideManager.isPaused {
            rideManager.resumeRide()
            withAnimation { recordingPage = .metrics }
        } else {
            rideManager.pauseRide()
        }
    }
}

#Preview {
    ContentView()
}
