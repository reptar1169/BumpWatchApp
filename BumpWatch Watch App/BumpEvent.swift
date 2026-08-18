import Foundation

/// A single detected "bump" (pothole, crack, expansion joint, etc.)
struct BumpEvent: Codable, Identifiable {
    var id: UUID = UUID()

    /// Seconds since the ride started. Simpler and smaller on the wire than
    /// absolute timestamps; the server derives absolute time from the ride's
    /// startTime + this offset.
    var rideElapsedSeconds: Double

    /// Peak acceleration magnitude of the bump, in g's, with gravity removed
    /// (i.e. this is 0 on a perfectly smooth, level surface).
    var magnitudeG: Double

    var latitude: Double
    var longitude: Double

    /// Horizontal accuracy of the GPS fix used for this bump, in meters.
    /// Lower is better. Use this on the server/web side to discount or
    /// filter noisy fixes if needed.
    var horizontalAccuracyMeters: Double

    /// Speed at the time of the bump, in meters/second, if available from
    /// CoreLocation (-1 if unknown).
    var speedMetersPerSecond: Double
}

/// A full ride: metadata plus every bump detected during it.
struct RideRecord: Codable, Identifiable {
    var id: String = UUID().uuidString
    var startTime: Date
    var endTime: Date?
    var bumps: [BumpEvent] = []

    /// Set to true once the ride has been successfully uploaded, so we know
    /// it's safe to delete the local copy (or at least stop retrying).
    var uploaded: Bool = false
}
