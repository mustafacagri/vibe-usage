# Runs one command-line tool in this (new, visible) console window.
# Arguments arrive as base64-encoded, NUL-separated UTF-8 so that no shell ever re-parses
# them (NUL cannot occur inside a process argument). The environment is prepared by the
# caller. Windows PowerShell 5 compatible.
param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$Title,
    [string]$ArgumentsBase64
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $WorkingDirectory
if ($Title) {
    $Host.UI.RawUI.WindowTitle = $Title
    Write-Host $Title
}
[string[]]$arguments = @()
if ($ArgumentsBase64) {
    $arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)).Split([char]0)
}
& $Executable @arguments
