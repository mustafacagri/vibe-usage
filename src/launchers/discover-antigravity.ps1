# Internal transport only. Stdout includes a CSRF capability and must be consumed
# in memory by the main process. Do not invoke this script in a visible console.
# Windows PowerShell 5 compatible; no application or network request is started.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = [ordered]@{ outcome = 'app_closed'; servers = @() }

try {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $currentIdentity.User.Value
    if ([string]::IsNullOrWhiteSpace($currentSid)) { throw 'identity-unavailable' }
    $programs = Join-Path $env:LOCALAPPDATA 'Programs'
    $appServer = Join-Path $programs 'Antigravity\resources\bin\language_server.exe'
    $ideRoot = (Join-Path $programs 'Antigravity IDE\resources\app\extensions\antigravity\bin') + '\'
    $processes = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%' OR Name LIKE 'language-server%'")
    $servers = New-Object System.Collections.Generic.List[object]
    $candidateFound = $false
    foreach ($entry in $processes) {
        if ($servers.Count -ge 4) { break }
        $executable = [string]$entry.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($executable)) { continue }
        $isApp = [string]::Equals($executable, $appServer, [StringComparison]::OrdinalIgnoreCase)
        $isIDE = $executable.StartsWith($ideRoot, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($executable) -match '^language[-_]server(?:[-_][a-zA-Z0-9]+)*\.exe$'
        if (-not $isApp -and -not $isIDE) { continue }
        # A matching installation path alone does not establish ownership.
        # Never inspect another Windows user's CSRF capability or sockets.
        $owner = Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or
            -not [string]::Equals([string]$owner.Sid, $currentSid, [StringComparison]::Ordinal)) { continue }
        $candidateFound = $true
        $match = [regex]::Match([string]$entry.CommandLine, '(?:^|\s)--csrf_token(?:=|\s+)(?:"([^"\r\n]+)"|([^\s]+))')
        if (-not $match.Success) { continue }
        $csrfToken = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        if ($csrfToken.Length -gt 512 -or $csrfToken -match '[\x00-\x20\x7f]') { continue }
        $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $entry.ProcessId -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0') } |
            Select-Object -ExpandProperty LocalPort -Unique | Sort-Object | Select-Object -First 4)
        if ($ports.Count -eq 0) { continue }
        # Recheck identity after querying sockets so a recycled PID cannot inherit
        # this server's capability. Only this exact process's listening ports pass.
        $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$entry.ProcessId)
        if ($null -eq $current -or $current.CreationDate -ne $entry.CreationDate -or
            -not [string]::Equals([string]$current.ExecutablePath, $executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $servers.Add([pscustomobject]@{ pid = [int]$entry.ProcessId; csrfToken = $csrfToken; ports = @($ports) })
    }
    $result.servers = @($servers.ToArray())
    if ($servers.Count -gt 0) { $result.outcome = 'success' }
    elseif ($candidateFound) { $result.outcome = 'local_service_unavailable' }
} catch {
    $result.outcome = 'local_service_unavailable'
    $result.servers = @()
} finally {
    $csrfToken = $null
    $match = $null
    $entry = $null
    $current = $null
    $processes = $null
    $owner = $null
    $currentSid = $null
    if ($null -ne $currentIdentity) { $currentIdentity.Dispose() }
    $currentIdentity = $null
}
[Console]::WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
