$adb = "D:\devtools\android-sdk\platform-tools\adb.exe"
$emulator = "D:\devtools\android-sdk\emulator\emulator.exe"

$devices = & $adb devices
$connected = $devices | Select-String "\tdevice$"

if (-not $connected) {
    Write-Host "No device/emulator connected -- starting recepti_test..."
    # -no-snapshot-load forces a full boot instead of resuming the emulator's saved RAM
    # snapshot. Resuming a stale snapshot has caused INSTALL_FAILED_UPDATE_INCOMPATIBLE
    # (signature mismatch) against a freshly built APK; a full boot avoids that. This
    # only skips the RAM snapshot -- the disk/userdata partition (app installs, the
    # SQLite file) is untouched.
    Start-Process -FilePath $emulator -ArgumentList @("-avd", "recepti_test", "-no-snapshot-load") -WindowStyle Minimized
} else {
    Write-Host "Device/emulator already connected, skipping emulator start."
}

Write-Host "Waiting for a device to appear..."
& $adb wait-for-device

Write-Host "Waiting for boot to complete..."
$attempts = 0
$maxAttempts = 150
while ($attempts -lt $maxAttempts) {
    $prop = & $adb shell getprop sys.boot_completed 2>$null
    if ($prop) { $prop = $prop.Trim() }
    if ($prop -eq "1") {
        Write-Host "Boot completed."
        exit 0
    }
    Start-Sleep -Seconds 2
    $attempts++
}

Write-Host "Timed out waiting for the emulator to finish booting."
exit 1
