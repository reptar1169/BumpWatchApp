import Foundation

/// Persists rides to disk as individual JSON files under Documents/Rides/.
///
/// Kept deliberately simple (no SwiftData/CoreData) so a ride is never lost:
/// every ride is written to disk incrementally as it records, and the file
/// only gets deleted once the server has confirmed the upload succeeded.
final class RideStore {
    static let shared = RideStore()

    private let ridesDirectory: URL

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        ridesDirectory = docs.appendingPathComponent("Rides", isDirectory: true)
        try? FileManager.default.createDirectory(at: ridesDirectory, withIntermediateDirectories: true)
    }

    private func fileURL(for rideID: String) -> URL {
        ridesDirectory.appendingPathComponent("\(rideID).json")
    }

    func save(_ ride: RideRecord) {
        do {
            let data = try JSONEncoder().encode(ride)
            try data.write(to: fileURL(for: ride.id), options: .atomic)
        } catch {
            print("RideStore save error: \(error.localizedDescription)")
        }
    }

    func delete(_ ride: RideRecord) {
        try? FileManager.default.removeItem(at: fileURL(for: ride.id))
    }

    /// All rides currently on disk, most recent first. Includes rides still
    /// pending upload (e.g. from a previous launch that ended without
    /// connectivity).
    func allRides() -> [RideRecord] {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: ridesDirectory, includingPropertiesForKeys: nil
        ) else { return [] }

        let rides = files.compactMap { url -> RideRecord? in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? JSONDecoder().decode(RideRecord.self, from: data)
        }
        return rides.sorted { $0.startTime > $1.startTime }
    }

    func pendingUploadRides() -> [RideRecord] {
        allRides().filter { !$0.uploaded }
    }
}
