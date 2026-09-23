import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.androidApplication)
}

// Load environment variables from .env file
fun loadEnvFile(): Properties {
    val properties = Properties()
    val envFile = rootProject.file(".env")
    if (envFile.exists()) {
        envFile.readLines().forEach { line ->
            if (line.isNotBlank() && !line.startsWith("#") && line.contains("=")) {
                val (key, value) = line.split("=", limit = 2)
                // Remove quotes from value if present
                val cleanValue = value.trim().removeSurrounding("\"")
                properties.setProperty(key.trim(), cleanValue)
            }
        }
    }
    return properties
}

val envProperties = loadEnvFile()

// Helper function to get env variable with fallback
fun getEnvOrDefault(key: String, defaultValue: String): String {
    return envProperties.getProperty(key)
        ?: System.getenv(key)
        ?: defaultValue
}

// Helper for signing values: check -P command-line property first, then
// environment variable. Returns null (not a default string) so we can tell
// whether a real signing config was actually supplied.
fun getSigningProp(propName: String, envName: String): String? {
    return (project.findProperty(propName) as String?)
        ?: System.getenv(envName)
}

// Configuration values from environment
val appName = getEnvOrDefault("APP_NAME", "Companion App")
val appId = getEnvOrDefault("APPLICATION_ID", "com.example.companionapp")
val policyUrl = getEnvOrDefault("PRIVACY_POLICY_URL", "")  // Empty = hidden in UI
val supportEmail = getEnvOrDefault("SUPPORT_EMAIL", "")    // Empty = hidden in UI
val moreAppsUrl = getEnvOrDefault("MORE_APPS_URL", "")     // Empty = hidden in UI
val versionCodeValue = getEnvOrDefault("VERSION_CODE", "1").toIntOrNull() ?: 1
val versionNameValue = getEnvOrDefault("VERSION_NAME", "1.0")
val primaryColor = getEnvOrDefault("PRIMARY_COLOR", "")

// Release signing: supplied via -P flags or env vars so the keystore
// password never has to live in a file. See BUILD_AND_SIGN.md for the
// exact command. If nothing is supplied, the release build type just
// falls back to no signingConfig (unsigned), same as before.
val releaseStoreFile = getSigningProp("android.injected.signing.store.file", "BUMPWATCH_KEYSTORE_FILE")
val releaseStorePassword = getSigningProp("android.injected.signing.store.password", "BUMPWATCH_KEYSTORE_PASSWORD")
val releaseKeyAlias = getSigningProp("android.injected.signing.key.alias", "BUMPWATCH_KEY_ALIAS")
val releaseKeyPassword = getSigningProp("android.injected.signing.key.password", "BUMPWATCH_KEY_PASSWORD")

android {
    namespace = "com.tccode.companionapp"  // Fixed namespace - matches Java package in source files
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        minSdk = 27
        targetSdk = 36
        versionCode = versionCodeValue
        versionName = versionNameValue

        // testInstrumentationRunner removed - no instrumented tests

        // Inject configuration values as BuildConfig fields
        buildConfigField("String", "APP_NAME", "\"$appName\"")
        buildConfigField("String", "PRIVACY_POLICY_URL", "\"$policyUrl\"")
        buildConfigField("String", "SUPPORT_EMAIL", "\"$supportEmail\"")
        buildConfigField("String", "MORE_APPS_URL", "\"$moreAppsUrl\"")
        buildConfigField("String", "PRIMARY_COLOR", "\"$primaryColor\"")

        // Inject as resource values (accessible in XML)
        resValue("string", "app_name", appName)
        resValue("string", "policy_url", policyUrl)
        resValue("string", "support_email", supportEmail)
        resValue("string", "more_apps_url", moreAppsUrl)
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (releaseStoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
        resValues = true
    }
}

dependencies {

    implementation(libs.appcompat)
    implementation(libs.material)
    implementation(libs.activity)
    implementation(libs.constraintlayout)
    implementation(libs.wearable)
    implementation(libs.play.services.wearable)
    implementation(libs.swiperefreshlayout)
    implementation(libs.material)
    // Test dependencies removed - no test source sets
}
