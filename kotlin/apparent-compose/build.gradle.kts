plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "fyi.apparent.compose"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8)
}

dependencies {
    api(project(":apparent"))
    // Only the runtime; the app's own Compose version wins.
    compileOnly("androidx.compose.runtime:runtime:1.7.0")
}
