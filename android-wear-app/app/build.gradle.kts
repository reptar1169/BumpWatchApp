import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    // No org.jetbrains.kotlin.android -- see build.gradle.kts's comment;
    // AGP 9's built-in Kotlin support replaces it.
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.gms.google-services")
}

android {
    namespace = "com.jeffschoello.bumpwatch.wear"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.jeffschoello.bumpwatch.wear"
        // Wear OS 3+ (API 30) is the floor Health Services' ExerciseClient
        // supports -- see https://developer.android.com/health-and-fitness/health-services
        minSdk = 30
        targetSdk = 36
        versionCode = 7
        versionName = "7.0"
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// AGP 9's built-in Kotlin support replaced the old android.kotlinOptions {}
// block with this top-level Kotlin compiler-options DSL -- the
// android.kotlinOptions { jvmTarget = "17" } this project first shipped
// with fails as "Unresolved reference" without org.jetbrains.kotlin.android
// applied.
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // Firebase: real Auth SDK works directly on Wear OS (unlike watchOS,
    // which needed AuthService.swift's hand-rolled REST calls) -- see
    // auth/AuthService.kt's header comment.
    //
    // NOTE: as of BoM 34.0.0 (July 2025) Firebase stopped publishing the
    // -ktx suffixed artifacts (firebase-auth-ktx etc.) -- the Kotlin
    // extension APIs moved into the base artifact itself, no source changes
    // needed for code (like AuthService.kt) that just uses FirebaseAuth
    // directly. Use "firebase-auth", not "firebase-auth-ktx", or Gradle
    // fails with "Could not find com.google.firebase:firebase-auth-ktx:."
    // (empty version -- the BoM no longer declares one).
    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-auth")

    // Live heart rate / distance / calories during the ride, the Android
    // equivalent of HKWorkoutSession/HKLiveWorkoutDataSource.
    implementation("androidx.health:health-services-client:1.0.0")

    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    // Explicit pin, not a transitive pull -- without this, whatever older
    // Fragment version activity-compose/wear-compose bring in transitively
    // trips lint's InvalidFragmentVersionForActivityResult check on
    // registerForActivityResult() (MainActivity.kt), which is a hard error
    // on a release/signed-bundle lint pass (debug builds don't run lint by
    // default, which is why this didn't show up until now).
    implementation("androidx.fragment:fragment-ktx:1.9.0")
    implementation("androidx.wear.compose:compose-material3:1.5.0")
    implementation("androidx.wear.compose:compose-foundation:1.5.0")
    // OngoingActivity API -- surfaces RideForegroundService's notification
    // on the watch face itself, not just the notification shade. See
    // RideForegroundService's header comment.
    implementation("androidx.wear:wear-ongoing:1.1.0")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")
    // .await() for Firebase/GMS Task<T> (AuthService, LocationTracker).
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.1")
    // .await() for Health Services' ListenableFuture<T> (RideManager) --
    // separate library from the one above, both needed.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.10.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
