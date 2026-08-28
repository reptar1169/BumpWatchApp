import SwiftUI

struct ContentView: View {
    @StateObject private var rideManager = RideManager()

    var body: some View {
        VStack(spacing: 8) {
            Text(statusText)
                .font(.headline)

            if rideManager.isRecording {
                Text(formattedElapsed)
                    .font(.system(.title2, design: .rounded).monospacedDigit())
                bumpCountLine
                    .font(.caption)
                heartRateLine
                    .font(.caption2)
            } else if rideManager.isStarting {
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
        .onAppear {
            rideManager.requestPermissions()
            UploadService.shared.retryPendingUploads()
        }
    }

    private var statusText: String {
        if rideManager.isRecording { return rideManager.isPaused ? "Paused" : "Recording" }
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

    /// "♥ 142 bpm" once a reading has arrived, or a plain placeholder
    /// beforehand -- mirrors bumpCountLine's "show something stable, fill
    /// in the real value once it lands" approach so the layout doesn't jump
    /// when the first heart rate sample comes in.
    private var heartRateLine: Text {
        guard let bpm = rideManager.currentHeartRateBPM else {
            return Text("♥ --").foregroundColor(.secondary)
        }
        return Text("♥ \(Int(bpm.rounded())) bpm").foregroundColor(.secondary)
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
