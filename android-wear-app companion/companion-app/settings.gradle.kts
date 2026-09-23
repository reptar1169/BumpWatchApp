pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

// Load project name from .env file if available
fun loadProjectName(): String {
    val envFile = file(".env")
    if (envFile.exists()) {
        envFile.readLines().forEach { line ->
            if (line.startsWith("APPLICATION_ID=")) {
                val appId = line.substringAfter("=").trim().removeSurrounding("\"")
                // Use the last part of the package name as project name (e.g., "com.example.myapp" -> "myapp")
                // Or use full package name with dots replaced (for uniqueness)
                return appId.replace(".", "_")
            }
        }
    }
    return "companion_app"
}

rootProject.name = loadProjectName()
include(":app")
 