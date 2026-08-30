import Foundation

/// Sends a finished ride to the `submitRide` Cloud Function, which is the
/// piece that actually writes into Firestore.
///
/// We go through a Cloud Function instead of talking to Firestore directly
/// because the Firebase Firestore SDK does not support watchOS (as of
/// mid-2026 it's iOS/macOS/tvOS/community-supported visionOS only). A plain
/// HTTPS POST via URLSession works everywhere, including watchOS, so the
/// function acts as the bridge: watch -> HTTPS -> Cloud Function -> Firestore
/// (via the Admin SDK, server-side).
final class UploadService {
    static let shared = UploadService()

    /// Set this to your deployed function URL, e.g.
    /// "https://us-central1-bikelanebump.cloudfunctions.net/submitRide"
    var endpoint: URL = URL(string: "https://us-east1-bikelanebumps.cloudfunctions.net/submitRide")!

    enum UploadError: Error { case serverRejected(Int), transport(Error) }

    /// The Cloud Function parses dates with JavaScript's `new Date(...)`,
    /// which expects ISO 8601 strings -- not Swift's default numeric
    /// "seconds since 2001" encoding. Must stay in sync with the decoding
    /// strategy RideStore would need if it ever read a server response.
    private static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    /// Every upload authenticates as this rider via AuthService (see its
    /// header comment) rather than the old shared API key -- each ride now
    /// carries a real per-rider identity instead of "anyone with the
    /// key." AuthService.currentIdToken() handles sign-up/refresh, so this
    /// just needs to ask for a token right before sending.
    func upload(_ ride: RideRecord, completion: @escaping (Result<Void, UploadError>) -> Void) {
        Task {
            do {
                let idToken = try await AuthService.shared.currentIdToken()

                var request = URLRequest(url: endpoint)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
                request.httpBody = try Self.makeEncoder().encode(ride)

                let (_, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                    completion(.failure(.serverRejected(code)))
                    return
                }
                completion(.success(()))
            } catch {
                // Covers both AuthService failures (couldn't sign in/
                // refresh -- e.g. no connectivity yet) and the upload
                // request itself failing; either way the ride stays
                // marked not-yet-uploaded and retryPendingUploads() below
                // will try again later, same as before this change.
                completion(.failure(.transport(error)))
            }
        }
    }

    /// Call this on launch and whenever the watch regains connectivity to
    /// flush anything left over from a ride that ended offline.
    func retryPendingUploads() {
        for ride in RideStore.shared.pendingUploadRides() {
            upload(ride) { result in
                switch result {
                case .success:
                    var uploaded = ride
                    uploaded.uploaded = true
                    RideStore.shared.save(uploaded)
                case .failure(let error):
                    print("Retry upload failed for ride \(ride.id): \(error)")
                }
            }
        }
    }
}
