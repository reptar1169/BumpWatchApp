// Versions below were current as of Aug 2026 (checked against
// developer.android.com / mvnrepository.com while writing this) -- Android
// Studio's Gradle sync will flag anything that's since moved; take its
// suggested bumps, this file was never compiled to confirm these are
// exactly right.
//
// No org.jetbrains.kotlin.android plugin here -- AGP 9.0+ has Kotlin
// support built in, and explicitly applying kotlin-android on top of that
// is now a hard error ("no longer required for Kotlin support since AGP
// 9.0"). The Kotlin subplugins below (compose/serialization) are still
// needed and still versioned explicitly, same as before.
plugins {
    id("com.android.application") version "9.3.3" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.10" apply false
    id("com.google.gms.google-services") version "4.5.0" apply false
}
