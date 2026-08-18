import SwiftUI

/// Maps a bump's magnitude to a color on the same warm severity gradient
/// used by the heatmap/markers on bikelanebumps.org, so a bump reads as the
/// same color whether you're looking at your wrist mid-ride or the website
/// afterward.
///
/// The website derives its color ceiling from the 95th percentile of
/// whatever's currently on the map -- that only works with a full dataset
/// to look back across. Live on the Watch there's no such dataset, just
/// "this one bump, right now," so there's no percentile to compute against.
/// This uses a fixed ceiling instead, chosen from real ride data (rides
/// have topped out around 12-20g for a hard hit).
enum BumpSeverity {
    static let colorCeilingG: Double = 15.0

    // Same 5-stop gradient as HEAT_GRADIENT in the website's app.js -- keep
    // these two in sync if the palette ever changes.
    private static let stops: [(location: Double, rgb: (Double, Double, Double))] = [
        (0.00, (0xff, 0xf3, 0xc4)),
        (0.25, (0xff, 0xd8, 0x73)),
        (0.50, (0xff, 0xab, 0x3d)),
        (0.75, (0xff, 0x6f, 0x3c)),
        (1.00, (0xb0, 0x14, 0x1c)),
    ]

    static func color(forMagnitudeG magnitude: Double) -> Color {
        let t = max(0, min(1, magnitude / colorCeilingG))

        for i in 0..<(stops.count - 1) {
            let a = stops[i]
            let b = stops[i + 1]
            guard t >= a.location && t <= b.location else { continue }
            let localT = (t - a.location) / (b.location - a.location)
            let r = a.rgb.0 + (b.rgb.0 - a.rgb.0) * localT
            let g = a.rgb.1 + (b.rgb.1 - a.rgb.1) * localT
            let bl = a.rgb.2 + (b.rgb.2 - a.rgb.2) * localT
            return Color(red: r / 255, green: g / 255, blue: bl / 255)
        }

        let last = stops[stops.count - 1].rgb
        return Color(red: last.0 / 255, green: last.1 / 255, blue: last.2 / 255)
    }
}
