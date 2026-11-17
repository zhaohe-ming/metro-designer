param([switch]$DebugApk)
$ErrorActionPreference = 'Stop'
$androidRoot = $PSScriptRoot
$toolPaths = Join-Path $androidRoot '.cache/paths.json'
if (Test-Path -LiteralPath $toolPaths) {
    $metroTools = Get-Content -LiteralPath $toolPaths -Raw | ConvertFrom-Json
    $env:JAVA_HOME = $metroTools.java
    $gradle = Join-Path $metroTools.gradle 'bin/gradle.bat'
} else {
    $gradle = (Get-Command gradle -ErrorAction Stop).Source
}
$env:GRADLE_USER_HOME = Join-Path $androidRoot '.cache/gradle-user'
$env:ANDROID_USER_HOME = Join-Path $androidRoot '.cache/android-user17'
$env:JAVA_TOOL_OPTIONS = '-Djava.net.useSystemProxies=true -Djava.net.preferIPv4Stack=true'
# On this Windows host AF_UNIX connects fail; an absent socket directory makes the JDK use its TCP fallback.
$tcpFallback = Join-Path $androidRoot '.cache/uds-tcp-fallback'
if (-not (Test-Path -LiteralPath $tcpFallback)) {
    $env:JAVA_TOOL_OPTIONS += ' "-Djdk.net.unixdomain.tmpdir=' + $tcpFallback + '"'
}
$env:PATH = $env:JAVA_HOME + '\bin;' + $env:PATH
$tasks = if ($DebugApk) { @('lintDebug', 'testDebugUnitTest', 'assembleDebug') } else { @('lintRelease', 'testReleaseUnitTest', 'assembleRelease') }
& $gradle -p $androidRoot --no-daemon --console=plain @tasks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
