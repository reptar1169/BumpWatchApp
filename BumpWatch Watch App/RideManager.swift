import Combine
import CoreLocation
import CoreMotion
import Foundation
import HealthKit

/// Orchestrates a ride: starts a HealthKit workout session (this is what
/// gives us reliable background execution + continuous GPS on the Watch
/// with the screen off or wrist down -- the same mechanism every cycling
/// app uses), streams accelerometer data through BumpDetector, tags each
/// detected bump with the latest GPS fix, and persists/uploads the result.
@MainActor
final class RideManager: NSObject, ObservableObject {
    @Published var isRecording = false
    /// True from the moment Start is tapped until the (possibly slow, see
    /// startRide()) HKWorkoutSession finishes constructing. Lets the UI show
    /// an honest "Starting…" state instead of appearing frozen or ignoring
    /// the tap.
    @Published var isStarting = false
    /// True while a recording ride is paused. Only meaningful when
    /// `isRecording` is also true -- pausing doesn't end the ride, it just
    /// stops bump detection and the elapsed-time clock until resumed.
    @Published var isPaused = false
    @Published var elapsedSeconds: TimeInterval = 0
    @Published var bumpCount: Int = 0
    /// Magnitude, in g, of the most recently recorded bump this ride. Nil
    /// until the first bump lands. Drives the merged "N bumps · last X.XXg"
    /// line in ContentView, colored via BumpSeverity.
    @Published var lastBumpMagnitudeG: Double?
    /// Most recent heart rate reading (bpm) from HealthKit for the
    /// in-progress ride. Nil until the first sample arrives -- on watchOS
    /// this is usually within a few seconds of starting a workout session,
    /// but can take longer if the sensor hasn't acquired a signal yet (e.g.
    /// a loose band).
    @Published var currentHeartRateBPM: Double?
    @Published var lastError: String?

    private let healthStore = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    private let motionManager = CMMotionManager()
    private let locationTracker = LocationTracker()
    private let bumpDetector = BumpDetector()

    private var currentRide: RideRecord?
    /// Ride-long average/max heart rate, refreshed from HealthKit's own
    /// running statistics every time a new heart rate sample is collected
    /// (see updateHeartRate(from:)). HealthKit computes these directly from
    /// every sample it has collected for the workout, so there's no need to
    /// separately track a running sum/count here.
    private var rideAverageHeartRateBPM: Double?
    private var rideMaxHeartRateBPM: Double?
    private var rideStartDate: Date?
    private var timer: Timer?
    private var lastSaveDate: Date = .distantPast
    /// When the current pause began, if any. Used by resumeRide() to shift
    /// rideStartDate forward by the pause's length -- see resumeRide().
    private var pauseStartDate: Date?

    override init() {
        super.init()
        locationTracker.onAuthorizationDenied = { [weak self] in
            Task { @MainActor in
                self?.lastError = "Location access denied — bumps won't be located. Enable it in the Watch's Settings app."
            }
        }
    }

    // MARK: - Public controls

    func requestPermissions() {
        locationTracker.requestAuthorization()

        guard HKHealthStore.isHealthDataAvailable() else { return }
        let share: Set = [HKObjectType.workoutType()]
        var read: Set<HKObjectType> = [HKObjectType.workoutType()]
        // Heart rate is read-only here -- we never write samples ourselves,
        // just read what HealthKit collects automatically during the
        // workout session (see HKLiveWorkoutDataSource in beginRide()).
        if let heartRateType = HKObjectType.quantityType(forIdentifier: .heartRate) {
            read.insert(heartRateType)
        }
        healthStore.requestAuthorization(toShare: share, read: read) { [weak self] success, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.lastError = "HealthKit authorization failed: \(error.localizedDescription)"
                    return
                }
                // `success` here only means the request round-trip
                // completed -- HealthKit does NOT treat the user tapping
                // "Don't Allow" as an error, so a straight denial produces
                // success == true, error == nil, and (without this check)
                // zero feedback. Left alone, the first sign of trouble
                // would be a cryptic HKWorkoutSession failure the moment
                // they tap Start -- exactly the failure mode this whole
                // debugging session traced back to a Workouts permission
                // that was silently off. Check the real decision explicitly
                // so that's visible up front instead.
                self.refreshWorkoutAuthorizationStatus()
            }
        }
    }

    /// Surfaces a clear, actionable message the moment Workouts sharing is
    /// denied, rather than waiting for it to manifest as an opaque
    /// HealthKit error during startRide(). Runs every time requestAuthorization's
    /// completion fires -- including on ordinary relaunches, where the
    /// request itself is a no-op -- so this also picks up a user who denied
    /// once, later flipped it on in the Health app, then reopened BumpWatch.
    private func refreshWorkoutAuthorizationStatus() {
        guard healthStore.authorizationStatus(for: HKObjectType.workoutType()) == .sharingDenied else { return }
        lastError = "Workouts permission is off for BumpWatch. In the Health app on your iPhone: profile icon → Apps → BumpWatch → turn on Workouts."
    }

    /// Measured on-device: constructing the very first `HKWorkoutSession` in
    /// this process takes ~1.3s (a one-time handshake with the workout
    /// daemon) -- every subsequent construction is sub-millisecond.
    /// `HKWorkoutSession(...)` init is a synchronous call, so eating that
    /// cost inline would freeze the *entire* UI for that whole span, not
    /// just the button. Constructing off the main actor here means SwiftUI
    /// can still render `isStarting`'s "Starting…" state and the watch
    /// stays responsive throughout, even though actual recording still
    /// doesn't begin until this resolves.
    func startRide() {
        guard !isRecording, !isStarting else { return }
        isStarting = true
        lastError = nil

        let config = HKWorkoutConfiguration()
        config.activityType = .cycling
        config.locationType = .outdoor
        let store = healthStore

        Task {
            let result = await Task.detached(priority: .userInitiated) {
                Result { try HKWorkoutSession(healthStore: store, configuration: config) }
            }.value

            switch result {
            case .success(let session):
                self.beginRide(with: session, config: config)
            case .failure(let error):
                self.isStarting = false
                // The session may have thrown after already being left
                // dangling by an earlier failed attempt -- discard whatever
                // we're holding so the *next* tap gets a clean
                // HKWorkoutSession instead of colliding with a wedged one.
                self.discardFailedSession(reason: "Couldn't start ride: \(error.localizedDescription)")
            }
        }
    }

    /// The fast half of starting a ride -- everything that follows a
    /// successfully-constructed HKWorkoutSession. Runs on the main actor;
    /// none of this is what was slow (see startRide()).
    private func beginRide(with session: HKWorkoutSession, config: HKWorkoutConfiguration) {
        let builder = session.associatedWorkoutBuilder()
        builder.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: config)
        session.delegate = self
        builder.delegate = self

        self.session = session
        self.builder = builder

        let start = Date()
        rideStartDate = start
        currentRide = RideRecord(startTime: start)

        session.startActivity(with: start)
        builder.beginCollection(withStart: start) { [weak self] _, error in
            if let error {
                Task { @MainActor in
                    self?.discardFailedSession(
                        reason: "Couldn't start workout: \(error.localizedDescription)"
                    )
                }
            }
        }

        bumpDetector.reset()
        locationTracker.start()
        startMotionUpdates()
        startTimer()

        isStarting = false
        isRecording = true
        isPaused = false
        pauseStartDate = nil
        bumpCount = 0
        lastBumpMagnitudeG = nil
        currentHeartRateBPM = nil
        rideAverageHeartRateBPM = nil
        rideMaxHeartRateBPM = nil
        lastError = nil
    }

    /// Pauses an in-progress ride: stops bump detection and the elapsed-time
    /// clock without ending the HealthKit workout session or discarding
    /// anything recorded so far. Location tracking is deliberately left
    /// running so a fresh GPS fix is ready the moment the ride resumes,
    /// rather than needing to reacquire a signal.
    func pauseRide() {
        guard isRecording, !isPaused else { return }
        isPaused = true
        pauseStartDate = Date()

        stopMotionUpdates()
        timer?.invalidate()
        timer = nil
        session?.pause()
    }

    /// Resumes a paused ride. Shifts rideStartDate forward by however long
    /// the pause lasted, so both the displayed elapsed time and every
    /// subsequent bump's `rideElapsedSeconds` continue to exclude paused
    /// time -- no separate "paused duration" accumulator needed, and bumps
    /// already recorded before the pause are untouched.
    func resumeRide() {
        guard isRecording, isPaused else { return }
        if let pauseStart = pauseStartDate, let start = rideStartDate {
            rideStartDate = start.addingTimeInterval(Date().timeIntervalSince(pauseStart))
        }
        pauseStartDate = nil
        isPaused = false

        startMotionUpdates()
        startTimer()
        session?.resume()
    }

    /// Tears down a HealthKit workout session/builder that failed, rather
    /// than leaving them assigned. HealthKit's workout state machine is
    /// one-at-a-time per process -- if a failed session lingers in
    /// `self.session`/`self.builder`, the *next* `HKWorkoutSession(...)`
    /// attempt can collide with its stuck state and fail too (surfaces as
    /// "Unable to transition to the desired state from the Error(N) state
    /// ... Allowed transitions ... {}" in the console). Explicitly ending
    /// the dead session and clearing our references gives the next attempt
    /// a clean slate. Motion/GPS tracking (and the ride's own recording)
    /// are untouched here -- they don't depend on the workout session, only
    /// HealthKit's background-execution guarantee does.
    private func discardFailedSession(reason: String) {
        lastError = reason
        isStarting = false // safety net -- the startRide() failure path already clears this itself
        session?.end()
        session = nil
        builder = nil
    }

    func stopRide() {
        // Deliberately gated on `isRecording` alone, *not* on session/builder
        // being present. A workout session can fail and get discarded by
        // discardFailedSession() mid-ride (nilling session/builder) while
        // the ride itself keeps recording motion/GPS -- Stop has to be able
        // to end that ride too, or it becomes unstoppable.
        guard isRecording else { return }

        stopMotionUpdates()
        locationTracker.stop()
        timer?.invalidate()
        timer = nil

        let end = Date()
        isRecording = false
        isPaused = false
        pauseStartDate = nil

        if let session, let builder {
            session.end()
            builder.endCollection(withEnd: end) { [weak self] _, error in
                builder.finishWorkout { _, _ in
                    // We don't need the saved HKWorkout object itself -- the
                    // Watch's Fitness app picks it up automatically. Our own
                    // record (with bump data) is what we finalize below.
                }
                Task { @MainActor in
                    self?.finalizeRide(endedAt: end)
                }
            }
            self.session = nil
            self.builder = nil
        } else {
            // No live HealthKit workout session to close out -- it already
            // failed and was discarded earlier in this ride. Still finalize
            // and upload the ride data we collected locally; that path never
            // depended on the workout session succeeding.
            finalizeRide(endedAt: end)
        }
    }

    // MARK: - Motion

    private func startMotionUpdates() {
        guard motionManager.isDeviceMotionAvailable else {
            lastError = "Motion sensors unavailable on this device."
            return
        }
        motionManager.deviceMotionUpdateInterval = 1.0 / 50.0
        motionManager.startDeviceMotionUpdates(to: .main) { [weak self] motion, error in
            guard let self, let motion else { return }
            self.handleMotion(motion)
        }
    }

    private func stopMotionUpdates() {
        motionManager.stopDeviceMotionUpdates()
    }

    private func handleMotion(_ motion: CMDeviceMotion) {
        let now = Date()
        guard let peakG = bumpDetector.ingest(userAcceleration: motion.userAcceleration, at: now) else { return }
        recordBump(magnitudeG: peakG, at: now)
    }

    private func recordBump(magnitudeG: Double, at timestamp: Date) {
        guard var ride = currentRide, let start = rideStartDate else { return }

        let location = locationTracker.lastLocation
        let bump = BumpEvent(
            rideElapsedSeconds: timestamp.timeIntervalSince(start),
            magnitudeG: magnitudeG,
            latitude: location?.coordinate.latitude ?? 0,
            longitude: location?.coordinate.longitude ?? 0,
            horizontalAccuracyMeters: location?.horizontalAccuracy ?? -1,
            speedMetersPerSecond: location?.speed ?? -1,
            heartRateBPM: currentHeartRateBPM
        )
        ride.bumps.append(bump)
        currentRide = ride
        bumpCount = ride.bumps.count
        lastBumpMagnitudeG = magnitudeG

        // Left in deliberately: while thresholdG is still being tuned from
        // real rides, this is the fastest way to see the actual magnitude
        // of everything currently crossing the line. Watch the Xcode
        // console during a ride -- a flood of low numbers close to
        // thresholdG means the threshold is still sitting in the noise
        // floor; occasional bumps well above it are the real signal.
        print(String(format: "🚧 bump #%d: %.2fg", bumpCount, magnitudeG))

        // Throttle disk writes -- persist at most every few seconds, plus
        // always on the very first bump so a short ride isn't lost.
        if bumpCount == 1 || timestamp.timeIntervalSince(lastSaveDate) > 3 {
            RideStore.shared.save(ride)
            lastSaveDate = timestamp
        }
    }

    // MARK: - Timer (UI elapsed time)

    private func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, let start = self.rideStartDate else { return }
            Task { @MainActor in
                self.elapsedSeconds = Date().timeIntervalSince(start)
            }
        }
    }

    // MARK: - Heart rate

    private static let heartRateUnit = HKUnit.count().unitDivided(by: .minute())

    /// Pulls the latest live/average/max heart rate out of HealthKit's own
    /// running statistics for the workout -- HealthKit aggregates these
    /// from every sample it has collected so far, so there's nothing to
    /// accumulate manually here.
    private func updateHeartRate(from statistics: HKStatistics) {
        if let mostRecent = statistics.mostRecentQuantity()?.doubleValue(for: Self.heartRateUnit) {
            currentHeartRateBPM = mostRecent
        }
        if let average = statistics.averageQuantity()?.doubleValue(for: Self.heartRateUnit) {
            rideAverageHeartRateBPM = average
        }
        if let max = statistics.maximumQuantity()?.doubleValue(for: Self.heartRateUnit) {
            rideMaxHeartRateBPM = max
        }
    }

    // MARK: - Finish

    private func finalizeRide(endedAt: Date) {
        guard var ride = currentRide else { return }
        ride.endTime = endedAt
        ride.averageHeartRateBPM = rideAverageHeartRateBPM
        ride.maxHeartRateBPM = rideMaxHeartRateBPM
        currentRide = nil
        rideStartDate = nil

        RideStore.shared.save(ride)

        UploadService.shared.upload(ride) { result in
            switch result {
            case .success:
                var uploaded = ride
                uploaded.uploaded = true
                RideStore.shared.save(uploaded)
            case .failure(let error):
                print("Upload failed, will retry later: \(error)")
                // Left on disk with uploaded == false; UploadService.retryPendingUploads()
                // will pick it up on next launch or manual sync.
            }
        }
    }
}

// MARK: - HKWorkoutSessionDelegate

extension RideManager: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {}

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            self.discardFailedSession(reason: "Workout session error: \(error.localizedDescription)")
        }
    }
}

// MARK: - HKLiveWorkoutBuilderDelegate

extension RideManager: HKLiveWorkoutBuilderDelegate {
    /// Fires whenever the workout builder has new samples for one or more
    /// types. `HKLiveWorkoutDataSource` collects heart rate automatically
    /// once a workout session is active -- no `enableCollection(for:)` call
    /// is needed for it, unlike sample types outside the default set for
    /// the configured activity type.
    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard let heartRateType = HKObjectType.quantityType(forIdentifier: .heartRate),
              collectedTypes.contains(heartRateType),
              let statistics = workoutBuilder.statistics(for: heartRateType) else { return }

        Task { @MainActor in
            self.updateHeartRate(from: statistics)
        }
    }

    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
}
