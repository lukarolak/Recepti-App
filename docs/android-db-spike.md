# Phase 0 spike results: nodejs-mobile + local SQLite

## Outcome

**Decision: use `node-sqlite3-wasm` for the phone's local database.**

Validated end-to-end on a real Android emulator (API 34, x86_64):
- nodejs-mobile v18.20.4 runs Node.js inside an Android app (via the `nodejs-mobile-samples/android/native-gradle-node-folder` sample, modernized to current Gradle/AGP).
- `node-sqlite3-wasm` installs with a plain `npm install` (no native compilation, no NDK/WSL2 needed for the DB layer itself), instantiates its WASM module fine under nodejs-mobile's bundled V8/Node 18, and persists data to a real file via its custom `fs`-backed VFS.
- Confirmed persistence across a real app restart on-device: inserted a row, force-stopped the app, relaunched, and the row was still there (hit count 1 → 2 across restarts, both rows present).

The `better-sqlite3` native-compile path (WSL2 + `prebuild-for-nodejs-mobile`) was intentionally **not** spiked — `node-sqlite3-wasm` already met the bar and avoids the Windows-only WSL2/NDK cross-compile toolchain entirely. Revisit only if `node-sqlite3-wasm`'s performance or WASM overhead becomes a real problem (unlikely at this app's scale — a family's recipes/ingredients/week plan, dozens of rows).

## What was needed to get here (environment notes)

- Node.js LTS, Android SDK command-line tools, an x86_64 emulator image, and JDK 17 (pinned via `org.gradle.java.home` in `gradle.properties` — the machine's default JDK is 25, too new for current AGP) all had to be installed; none were present beforehand.
- The nodejs-mobile-android sample repo is from ~2017 (AGP 2.3.3, Gradle 3.3, `jcenter()`, Android support library) and needed modernizing to build at all: AGP → 8.5.0, Gradle wrapper → 8.7, repos → `google()`/`mavenCentral()`, deps → AndroidX equivalents, `compileSdk`/`targetSdk` → 34, explicit `android:exported="true"` on the launcher activity (required since API 31), and dropping the `x86` (32-bit) ABI since the current nodejs-mobile release only ships `armeabi-v7a`/`arm64-v8a`/`x86_64` binaries.
- **Disk space**: the SDK + NDK + Gradle caches are large (~7-8GB) and the dev machine's C: drive only had a few GB free, which caused a mid-build disk-full crash and a corrupted NDK install on the first attempt. Everything (SDK, AVD home, Gradle user home) was relocated to `D:\devtools\` (`android-sdk`, `android-home`, `gradle-home`) via the `ANDROID_HOME`/`ANDROID_SDK_ROOT`/`ANDROID_SDK_HOME`/`ANDROID_AVD_HOME`/`GRADLE_USER_HOME` environment variables (User scope). **Any future Android build work on this machine should keep using those D: locations** rather than letting tooling default back to C:.
- The nodejs-mobile Android library binaries (`libnode.so` per ABI) come from a separate release zip (`https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip`), not from npm.

## Where the spike lives

`D:\Programiranje\recepti-android-spike\` — a disposable clone of `nodejs-mobile-samples`, not part of the `recepti` repo. It's a throwaway proof-of-concept, not a starting point to build the real Android app on top of (Phase 2 should start from a clean copy of the same upstream sample rather than this modified/spiked one, or reuse the Gradle modernization steps documented above).
