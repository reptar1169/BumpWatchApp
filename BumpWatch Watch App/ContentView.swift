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
    ///
    /// Same layout as the Wear OS app's start screen (RootScreen.kt): the
    /// brand mark, a yellow-to-red "Bike Lane Bumps" wordmark, the prompt,
    /// then Start. Wrapped in a ScrollView so it still fits on the smallest
    /// watches and at large text sizes.
    private var startScreen: some View {
        ScrollView {
            VStack(spacing: 6) {
                BrandMark()
                    .frame(height: 44)
                    .accessibilityHidden(true)

                Text("Bike Lane Bumps")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(BrandMark.gradient)
                    .multilineTextAlignment(.center)

                // Deliberately plain text rather than ProgressView() while
                // starting -- confirmed on-device that ProgressView
                // triggers a synchronous, first-time CoreUI theme/asset
                // load on watchOS (visible in the console as "CUIThemeStore:
                // No theme registered with id=0") that stalls the main
                // thread for multiple seconds, which is exactly the freeze
                // this state exists to avoid.
                Text(rideManager.isStarting ? "Starting…" : "Tap to start recording your ride")
                    .font(.footnote)
                    .multilineTextAlignment(.center)

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
                .padding(.top, 4)

                errorText
            }
            .padding(.horizontal)
        }
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

/// The bikelanebumps.org mark (a wheel riding over a bump in the road),
/// drawn from the same geometry as the website's favicon.svg -- the Wear OS
/// app shows the same mark as an image. Drawn in code rather than loaded
/// from the asset catalog, so it's crisp at any size and adds no image-load
/// work on the launch screen (see the ProgressView note in startScreen).
private struct BrandMark: View {
    static let yellow = Color(red: 1.0, green: 0.753, blue: 0.239)  // #FFC03D
    static let red = Color(red: 1.0, green: 0.306, blue: 0.239)     // #FF4E3D
    static let gradient = LinearGradient(
        colors: [yellow, red], startPoint: .leading, endPoint: .trailing
    )

    // Bounds of the drawing inside favicon.svg's 100x100 viewBox,
    // including stroke widths: x 7...93, y 13...77.
    private static let minX: CGFloat = 7
    private static let minY: CGFloat = 13
    private static let width: CGFloat = 86
    private static let height: CGFloat = 64

    var body: some View {
        Canvas { context, size in
            let s = min(size.width / Self.width, size.height / Self.height)
            let ox = (size.width - Self.width * s) / 2 - Self.minX * s
            let oy = (size.height - Self.height * s) / 2 - Self.minY * s
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }

            // Wheel: circle r=22 at (50,38), 5-wide stroke, plus a hub dot.
            let wheel = Path(ellipseIn: CGRect(x: ox + 28 * s, y: oy + 16 * s, width: 44 * s, height: 44 * s))
            context.stroke(wheel, with: .color(Self.yellow), lineWidth: 5 * s)
            let hub = Path(ellipseIn: CGRect(x: ox + 47 * s, y: oy + 35 * s, width: 6 * s, height: 6 * s))
            context.fill(hub, with: .color(Self.yellow))

            // Road with a bump, yellow-to-red left to right.
            var road = Path()
            road.move(to: pt(10, 74))
            road.addLine(to: pt(34, 74))
            road.addQuadCurve(to: pt(66, 74), control: pt(50, 54))
            road.addLine(to: pt(90, 74))
            context.stroke(
                road,
                with: .linearGradient(
                    Gradient(colors: [Self.yellow, Self.red]),
                    startPoint: pt(10, 74), endPoint: pt(90, 74)
                ),
                style: StrokeStyle(lineWidth: 6 * s, lineCap: .round, lineJoin: .round)
            )
        }
        .aspectRatio(Self.width / Self.height, contentMode: .fit)
    }
}

#Preview {
    ContentView()
}
