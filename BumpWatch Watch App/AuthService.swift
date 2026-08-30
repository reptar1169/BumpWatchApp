import Foundation

/// Gives the Watch app a stable per-rider identity via Firebase's
/// anonymous auth, WITHOUT the Firebase Auth SDK -- like Firestore, it
/// doesn't support watchOS (see UploadService.swift's header comment for
/// the same constraint on Firestore). Firebase's REST API works fine
/// everywhere URLSession does, though, so this talks to the Identity
/// Toolkit REST API directly -- the same "plain HTTPS" approach
/// UploadService already uses to reach the submitRide Cloud Function.
///
/// The resulting ID token is what UploadService sends as
/// `Authorization: Bearer <token>` on every upload. See
/// functions/index.js's authenticateRequest() for how the server verifies
/// it, and the README's "Auth: transition plan" section for why the
/// Cloud Function still also accepts the old shared API key for a while.
final class AuthService {
    static let shared = AuthService()

    /// Firebase's project-identifying "Web API key" -- meant to be public
    /// and shipped in client code (it's already embedded the same way in
    /// web/bikelanebumps-site/app.js's firebaseConfig). It does NOT grant
    /// access to anything by itself; firestore/firestore.rules plus this
    /// service's own ID-token verification are what actually gate access.
    private let webAPIKey = "AIzaSyAGAT9b57URau1ClR1P2a1AN7xoSpbQAgA"

    private let signUpURL = URL(string: "https://identitytoolkit.googleapis.com/v1/accounts:signUp")!
    private let tokenRefreshURL = URL(string: "https://securetoken.googleapis.com/v1/token")!

    /// Safety margin before a token's real expiry -- avoids a race where a
    /// token that looks valid when currentIdToken() checks it expires
    /// moments later, mid-upload.
    private static let refreshMarginSeconds: TimeInterval = 300

    private struct Identity: Codable {
        let uid: String
        var idToken: String
        var refreshToken: String
        var expiresAt: Date
    }

    enum AuthError: Error { case transport(Error), serverRejected(Int), malformedResponse }

    private let identityFileURL: URL
    /// In-memory copy of what's on disk, so a burst of uploads (e.g.
    /// retryPendingUploads() flushing several queued rides at once) checks
    /// token validity once instead of separately hitting disk each time.
    private var cachedIdentity: Identity?

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        identityFileURL = docs.appendingPathComponent("auth-identity.json")
        cachedIdentity = Self.loadFromDisk(at: identityFileURL)
    }

    private static func loadFromDisk(at url: URL) -> Identity? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Identity.self, from: data)
    }

    private func persist(_ identity: Identity) {
        cachedIdentity = identity
        do {
            let data = try JSONEncoder().encode(identity)
            try data.write(to: identityFileURL, options: .atomic)
        } catch {
            print("AuthService persist error: \(error.localizedDescription)")
        }
    }

    /// Returns a currently-valid ID token, signing up (first launch) or
    /// refreshing (expired) as needed. UploadService calls this right
    /// before each upload attempt rather than caching a token itself,
    /// since a ride can sit queued offline for a while (see
    /// RideStore/retryPendingUploads) and a token cached from ride-start
    /// could easily be stale by the time it's actually sent.
    func currentIdToken() async throws -> String {
        if let identity = cachedIdentity,
           identity.expiresAt.timeIntervalSinceNow > Self.refreshMarginSeconds {
            return identity.idToken
        }

        if let identity = cachedIdentity {
            do {
                return try await refresh(identity).idToken
            } catch {
                // A stale/revoked refresh token shouldn't strand the rider
                // permanently -- fall through to a fresh anonymous sign-up
                // instead. That mints a NEW uid, so a (rare) refresh
                // failure could in principle split one rider's history
                // across two uids -- an acceptable tradeoff against
                // uploads just failing forever, for a Watch app that
                // already tolerates imperfect connectivity everywhere
                // else.
                print("AuthService refresh failed, signing up fresh: \(error)")
            }
        }

        return try await signUpAnonymously().idToken
    }

    private func signUpAnonymously() async throws -> Identity {
        var request = URLRequest(url: signUpURL.appendingQueryItem(name: "key", value: webAPIKey))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["returnSecureToken": true])

        let (data, response) = try await send(request)
        try Self.checkOK(response)

        struct SignUpResponse: Decodable {
            let localId: String
            let idToken: String
            let refreshToken: String
            let expiresIn: String // seconds, as a STRING -- an Identity Toolkit quirk
        }
        guard let decoded = try? JSONDecoder().decode(SignUpResponse.self, from: data) else {
            throw AuthError.malformedResponse
        }

        let identity = Identity(
            uid: decoded.localId,
            idToken: decoded.idToken,
            refreshToken: decoded.refreshToken,
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expiresIn) ?? 3600)
        )
        persist(identity)
        return identity
    }

    private func refresh(_ identity: Identity) async throws -> Identity {
        var request = URLRequest(url: tokenRefreshURL.appendingQueryItem(name: "key", value: webAPIKey))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = "grant_type=refresh_token&refresh_token=\(identity.refreshToken)"
            .data(using: .utf8)

        let (data, response) = try await send(request)
        try Self.checkOK(response)

        // The Secure Token endpoint's response uses snake_case field names
        // -- genuinely different from accounts:signUp's camelCase above.
        // Not a typo; that's just how these two Firebase REST APIs are.
        struct RefreshResponse: Decodable {
            let user_id: String
            let id_token: String
            let refresh_token: String
            let expires_in: String
        }
        guard let decoded = try? JSONDecoder().decode(RefreshResponse.self, from: data) else {
            throw AuthError.malformedResponse
        }

        let refreshed = Identity(
            uid: decoded.user_id,
            idToken: decoded.id_token,
            refreshToken: decoded.refresh_token,
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expires_in) ?? 3600)
        )
        persist(refreshed)
        return refreshed
    }

    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await URLSession.shared.data(for: request)
        } catch {
            throw AuthError.transport(error)
        }
    }

    private static func checkOK(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw AuthError.serverRejected(code)
        }
    }
}

private extension URL {
    func appendingQueryItem(name: String, value: String) -> URL {
        var components = URLComponents(url: self, resolvingAgainstBaseURL: false)!
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: name, value: value)]
        return components.url!
    }
}
