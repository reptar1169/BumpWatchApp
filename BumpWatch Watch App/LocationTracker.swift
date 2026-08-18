import CoreLocation
import Foundation

/// Thin wrapper around CLLocationManager that just keeps the most recent
/// fix around so BumpDetector can tag each bump with a location without
/// every reader needing to be a full CLLocationManagerDelegate.
final class LocationTracker: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private(set) var lastLocation: CLLocation?
    var onAuthorizationDenied: (() -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        // Full accuracy for outdoor cycling; we're paying the battery cost
        // anyway via the workout session.
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.activityType = .fitness
        manager.distanceFilter = kCLDistanceFilterNone
    }

    func requestAuthorization() {
        manager.requestWhenInUseAuthorization()
    }

    func start() {
        manager.startUpdatingLocation()
    }

    func stop() {
        manager.stopUpdatingLocation()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            onAuthorizationDenied?()
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let newest = locations.last {
            lastLocation = newest
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Keep the last known fix; a transient GPS error shouldn't wipe it.
        print("LocationTracker error: \(error.localizedDescription)")
    }
}
