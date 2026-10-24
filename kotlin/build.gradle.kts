plugins {
    id("com.android.library") version "8.11.0" apply false
    id("com.android.application") version "8.11.0" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false
}

// Publishing (the library modules apply `maven-publish` and say their artifactId). Nothing secret lives here:
//   ./gradlew publishToMavenLocal                         → ~/.m2, unsigned unless a key is given
//   ./gradlew publishReleasePublicationToStagingRepository → build/staging-repo, signed, ready for the Central Portal
// Signing reads ORG_GRADLE_PROJECT_signingKey (ASCII-armored private key) and ORG_GRADLE_PROJECT_signingPassword
// from the environment. Upload: ../../scripts/release-sdks.md.
subprojects {
    plugins.withId("maven-publish") {
        apply(plugin = "signing")
        group = providers.gradleProperty("GROUP").get()
        version = providers.gradleProperty("VERSION_NAME").get()
        // Each module's own gradle.properties names it (project properties, so findProperty, not providers).
        fun prop(key: String): String? = (findProperty(key) as String?)?.takeIf { it.isNotBlank() }
        afterEvaluate {
            extensions.configure<PublishingExtension> {
                publications {
                    create<MavenPublication>("release") {
                        from(components["release"])
                        artifactId = prop("POM_ARTIFACT_ID") ?: project.name
                        pom {
                            name.set(prop("POM_NAME") ?: project.name)
                            description.set(prop("POM_DESCRIPTION") ?: "")
                            url.set("https://apparent.fyi/docs/sdk/kotlin")
                            licenses {
                                license {
                                    name.set("MIT License")
                                    url.set("https://opensource.org/licenses/MIT")
                                }
                            }
                            developers {
                                developer {
                                    id.set("apparent")
                                    name.set("Ahmed Ashour")
                                    email.set("hello@apparent.fyi")
                                }
                            }
                            scm {
                                val scm = prop("POM_SCM_URL") ?: "https://github.com/AhmedAshour/apparent-sdks"
                                url.set(scm)
                                connection.set("scm:git:$scm.git")
                            }
                        }
                    }
                }
                repositories {
                    maven {
                        name = "staging"
                        url = uri(rootProject.layout.buildDirectory.dir("staging-repo"))
                    }
                }
            }
            extensions.configure<SigningExtension> {
                val key = prop("signingKey")
                if (key != null) {
                    useInMemoryPgpKeys(key, prop("signingPassword"))
                    sign(extensions.getByType<PublishingExtension>().publications)
                }
            }
        }
    }
}

// The staging repo must hold one version at a time, so the zip for the Central Portal has nothing stale in it.
tasks.register<Delete>("cleanStaging") { delete(layout.buildDirectory.dir("staging-repo")) }
