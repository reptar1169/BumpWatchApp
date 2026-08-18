import CoreMotion
import Foundation

/// Turns a stream of accelerometer samples into discrete "bump" events.
///
/// Approach: CoreMotion's `userAcceleration` already has gravity removed, so
/// on a smooth flat surface its magnitude sits near 0g. A pothole, curb cut,
/// or expansion joint shows up as a short, sharp spike. We look for local
/// peaks above a threshold and debounce so one physical bump (which can
/// rattle the sensor for 100-200ms, and can hit the front wheel then the
/// back wheel) doesn't get counted many times.
final class BumpDetector {
    /// Minimum peak magnitude (in g) to count as a bump.
    ///
    /// Field test history: 0.45g logged 1787 "bumps" in 10 minutes on a
    /// decent road -- the sensor was saturating on ordinary wrist/riding
    /// noise, not detecting discrete events. Raised to 1.3g, still too
    /// sensitive. Currently at 3.0g. RideManager logs every recorded bump's
    /// magnitude to the console, so keep an eye on that during rides -- if
    /// normal pavement is still triggering bumps, raise this further; if a
    /// known pothole/crack doesn't register, it's too high.
    var thresholdG: Double = 3.0

    /// Minimum time between two counted bumps.
    var debounceInterval: TimeInterval = 0.3

    private var lastBumpTime: Date?
    private var risingEdgeMagnitude: Double = 0
    private var isTrackingPeak = false

    /// Feed one motion sample in. Returns the peak magnitude (in g) if this
    /// sample completes a qualifying bump, otherwise nil.
    func ingest(userAcceleration a: CMAcceleration, at timestamp: Date) -> Double? {
        let magnitude = sqrt(a.x * a.x + a.y * a.y + a.z * a.z)

        if magnitude >= thresholdG {
            isTrackingPeak = true
            risingEdgeMagnitude = max(risingEdgeMagnitude, magnitude)
            return nil
        }

        // Magnitude dropped back below threshold: the spike is over. If we
        // were tracking one and we're outside the debounce window, emit it.
        guard isTrackingPeak else { return nil }
        isTrackingPeak = false
        defer { risingEdgeMagnitude = 0 }

        if let last = lastBumpTime, timestamp.timeIntervalSince(last) < debounceInterval {
            return nil
        }

        lastBumpTime = timestamp
        return risingEdgeMagnitude
    }

    func reset() {
        lastBumpTime = nil
        risingEdgeMagnitude = 0
        isTrackingPeak = false
    }
}
