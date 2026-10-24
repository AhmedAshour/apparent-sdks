plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
}

android {
    namespace = "fyi.apparent"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
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
    testOptions.unitTests.isReturnDefaultValues = true
}

kotlin {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8)
}

dependencies {
    // Optional: when the app has it, the Play install referrer becomes an `install_source` event on first open.
    compileOnly("com.android.installreferrer:installreferrer:2.2")
    testImplementation("junit:junit:4.13.2")
}

// `./gradlew :apparent:testDebugUnitTest -PapparentConformance=http://127.0.0.1:4299` also runs the conformance
// scenario against a running sdk/conformance intake (see ../conformance.sh). Without it that test is skipped.
val conformanceUrl = (project.findProperty("apparentConformance") as String?).orEmpty()
tasks.withType<Test>().configureEach {
    systemProperty("apparent.conformance", conformanceUrl)
    if (conformanceUrl.isNotEmpty()) outputs.upToDateWhen { false }
}
