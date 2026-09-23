import SwiftUI

struct ContentView: View {
    @StateObject private var rideManager = RideManager()

    var body: some View {
        // watchOS's native swipe-between-pages convention (the same one
        // Apple's own Workout app uses for Now Playing / Metrics / Elapsed
        // Time) -- mainPage is the original single-screen layout, unchanged;
        // statsPage is the new page this swipes to on the right.
        TabView {
            mainPage
            statsPage
        }
        .tabViewStyle(.page(indexDisplayMode: .automatic))
        .onAppear {
            rideManager.requestPermissions()
            UploadService.shared.retryPendingUploads()
        }
    }

    private var mainPage: some View {
        VStack(spacing: 8) {
            if rideManager.isRecording {
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
            } else if rideManager.isStarting {
                Text(statusText)
                    .font(.headline)
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
                Text(statusText)
                    .font(.headline)
                Text("Tap to start recording your ride")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if rideManager.isRecording {
                HStack(spacing: 8) {
                    Button(action: togglePause) {
                        Text(rideManager.isPaused ? "Resume" : "Pause")
                            .frame(maxWidth: .infinity)
                    }
                    .tint(rideManager.isPaused ? .green : .yellow)
                    .buttonStyle(.borderedProminent)

                    Button(action: rideManager.stopRide) {
                        Text("Finish")
                            .frame(maxWidth: .infinity)
                    }
                    .tint(.red)
                    .buttonStyle(.borderedProminent)
                }
            } else {
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
            }

            if let error = rideManager.lastError {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
    }

    /// The swipe-right page: live distance, calories, and elevation gain
    /// for the in-progress ride. Shows "--" placeholders (mirroring
    /// heartRateValueText/bumpCountLine's existing approach) rather than
    /// hiding the page entirely before a ride starts or before the first
    /// sample of each type has arrived -- simpler than conditionally
    /// changing which pages exist, and swiping over to an empty-looking
    /// page pre-ride is a reasonable way to discover it exists.
    private var statsPage: some View {
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

    private func togglePause() {
        if rideManager.isPaused {
            rideManager.resumeRide()
        } else {
            rideManager.pauseRide()
        }
    }
}

#Preview {
    ContentView()
}
