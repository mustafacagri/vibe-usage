# Runs one command-line tool in this (new, visible) console window.
# Arguments arrive as base64-encoded, NUL-separated UTF-8 so that no shell ever re-parses
# them (NUL cannot occur inside a process argument). Pass environment changes as
# arguments too, since a terminal tab can start with its own environment.
# Windows PowerShell 5 compatible.
#
# With -Handoff, the tab stays with the session: when the tool exits and the app has written
# the next command to that file (the session moved to another account), it runs here too.
param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$Title,
    [string]$ArgumentsBase64,
    [string]$EnvironmentBase64,
    [string]$Handoff,
    [switch]$NewWindow
)
$ErrorActionPreference = 'Stop'
# Each argument quoted the way CommandLineToArgvW reads it back: backslashes doubled before a
# quote and at the end, the quote escaped. Windows PowerShell does not do this itself (it joins
# -ArgumentList with spaces, and runs `& tool @args` without escaping quotes inside an
# argument, which would let a prompt's quotes split it into options), so every command line
# this script starts is built here.
function ConvertTo-ArgumentList([string[]]$Values) {
    @($Values | ForEach-Object { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' })
}
# The app starts this hidden, without a console a tool could use; Start-Process opens this
# script again in a new, visible console window.
if ($NewWindow) {
    $relaunch = @('-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    foreach ($name in 'WorkingDirectory', 'Executable', 'Title', 'ArgumentsBase64', 'EnvironmentBase64', 'Handoff') {
        $value = Get-Variable -Name $name -ValueOnly
        if ($value) { $relaunch += "-$name", $value }
    }
    $quoted = ConvertTo-ArgumentList $relaunch
    $powershell = Join-Path $PSHOME 'powershell.exe'
    # With Windows Terminal, the tool opens as a tab of the window last used rather than as a
    # window of its own, so several sessions continued at once stay together. Windows Terminal
    # reads `;` as the end of a command, so it is escaped. Its `wt.exe` alias lives in the
    # WindowsApps folder, which is not always on PATH.
    $terminal = (Get-Command 'wt.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    $alias = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe' }
    if (-not $terminal -and $alias -and (Test-Path -LiteralPath $alias)) { $terminal = $alias }
    if ($terminal) {
        $tab = @('-w', '0', 'new-tab', ('"' + $powershell + '"')) + $quoted
        Start-Process -FilePath $terminal -ArgumentList (($tab | ForEach-Object { $_ -replace ';', '\;' }) -join ' ')
    } else {
        Start-Process -FilePath $powershell -ArgumentList ($quoted -join ' ')
    }
    exit
}
function Set-LaunchEnvironment($Changes) {
    foreach ($name in @($Changes.unset)) {
        if ($name) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    }
    if ($Changes.set) {
        foreach ($entry in $Changes.set.PSObject.Properties) {
            Set-Item -LiteralPath "Env:$($entry.Name)" -Value $entry.Value
        }
    }
}
if ($EnvironmentBase64) {
    $environmentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EnvironmentBase64))
    Set-LaunchEnvironment ($environmentJson | ConvertFrom-Json)
}
while ($true) {
    Set-Location -LiteralPath $WorkingDirectory
    if ($Title) {
        $Host.UI.RawUI.WindowTitle = $Title
        Write-Host $Title
    }
    [string[]]$arguments = @()
    if ($ArgumentsBase64) {
        $arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)).Split([char]0)
    }
    # Started with the command line built above, in this console, and waited for.
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = (ConvertTo-ArgumentList $arguments) -join ' '
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $tool = [System.Diagnostics.Process]::Start($start)
    $tool.WaitForExit()
    if (-not $Handoff -or -not (Test-Path -LiteralPath $Handoff)) { break }
    # The next command, taken once: the file is removed before it runs.
    $next = Get-Content -LiteralPath $Handoff -Raw -Encoding UTF8 | ConvertFrom-Json
    Remove-Item -LiteralPath $Handoff -Force
    Set-LaunchEnvironment $next
    $WorkingDirectory = $next.workingDirectory
    $Executable = $next.executable
    $Title = $next.title
    $ArgumentsBase64 = $next.argumentsBase64
}
