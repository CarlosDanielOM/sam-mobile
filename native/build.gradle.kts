plugins {
    id("com.android.library") version "8.11.1"
    id("org.jetbrains.kotlin.android") version "2.1.21"
}

android {
    namespace = "com.sam.embeddings"
    compileSdk = 35
    ndkVersion = "28.2.13676358"
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild {
            cmake { arguments += listOf("-DANDROID_STL=c++_static"); targets += "sam-embeddings" }
        }
    }
    externalNativeBuild {
        cmake { path = file("CMakeLists.txt"); version = "3.31.6" }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildTypes { release { isMinifyEnabled = false } }
    testOptions { unitTests.isReturnDefaultValues = false }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

val nativeNotices by tasks.registering(Sync::class) {
    from("vendor/llama.cpp/LICENSE") { rename { "llama-ggml-LICENSE.txt" } }
    from("vendor/llama.cpp/licenses/LICENSE-jsonhpp") { rename { "nlohmann-json-LICENSE.txt" } }
    from("licenses/llamafile-LICENSE.txt")
    from(androidComponents.sdkComponents.ndkDirectory.map { it.file("NOTICE") }) { rename { "ndk-NOTICE.txt" } }
    from(androidComponents.sdkComponents.ndkDirectory.map { it.file("NOTICE.toolchain") }) { rename { "ndk-toolchain-NOTICE.txt" } }
    into(layout.buildDirectory.dir("generated/nativeNotices/assets/sam-embeddings"))
}
android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/nativeNotices/assets"))
tasks.named("preBuild") { dependsOn(nativeNotices) }

tasks.register<Copy>("exportAar") {
    dependsOn("assembleRelease")
    from(layout.buildDirectory.file("outputs/aar/sam-embeddings-release.aar"))
    into(layout.buildDirectory.dir("outputs/aar"))
    rename { "sam-embeddings.aar" }
}
