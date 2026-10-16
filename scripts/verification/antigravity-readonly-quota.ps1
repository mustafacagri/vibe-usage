# Optional, explicitly authorized diagnostic desktop startup. No prompts, login,
# model calls, credential writes, or raw arguments/responses are emitted.
# Only the fixed installed app and its verified process-owned loopback service
# are eligible. Only processes created under our owned root are cleaned up.
[CmdletBinding()]
param([switch]$LaunchApp)

$ErrorActionPreference = 'Stop'
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity'
$appPath = Join-Path $installRoot 'Antigravity.exe'
$serverPath = Join-Path $installRoot 'resources\bin\language_server.exe'
$result = [ordered]@{
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    rawOutputSuppressed = $true
    diagnosticCredentialWrites = $false
    launched = $false
}
$owned = @{}
$rootId = $null
$launchTime = $null
$stage = 'discover-processes'
$attempts = [System.Collections.Generic.List[object]]::new()

function Get-AppProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe' OR Name = 'language_server.exe'" |
        Where-Object { $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) })
}

function Remember-OwnedProcesses($processes) {
    if ($null -eq $rootId) { return }
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $processes) {
            $processKey = [string]$process.ProcessId
            if (-not $owned.ContainsKey($processKey) -and
                $process.CreationDate -ge $launchTime -and
                ($process.ProcessId -eq $rootId -or $owned.ContainsKey([string]$process.ParentProcessId))) {
                $owned[$processKey] = [pscustomobject]@{
                    id = [int]$process.ProcessId
                    created = $process.CreationDate
                    path = $process.ExecutablePath
                }
                $changed = $true
            }
        }
    }
}

function Get-SafeQuotaFields($json) {
    $rows = [System.Collections.Generic.List[object]]::new()
    # Schema names and numeric quota values only. Account identity is skipped.
    $models = $json.userStatus.cascadeModelConfigData.clientModelConfigs
    if ($null -eq $models) { $models = $json.clientModelConfigs }
    foreach ($model in @($models)) {
        if ($null -eq $model) { continue }
        $quota = $model.quotaInfo
        if ($null -ne $quota) {
            $row = [ordered]@{ scope = 'model'; remainingFractionPresent = ($null -ne $quota.remainingFraction) }
            if ($null -ne $quota.remainingFraction -and $quota.remainingFraction -is [ValueType]) {
                $row.remainingFraction = $quota.remainingFraction
            }
            if ($null -ne $quota.resetTime) { $row.resetTimePresent = $true }
            $rows.Add([pscustomobject]$row)
        }
    }
    $groups = $json.response.groups
    if ($null -eq $groups) { $groups = $json.summary.groups }
    if ($null -eq $groups) { $groups = $json.groups }
    foreach ($group in @($groups)) {
        if ($null -eq $group) { continue }
        foreach ($bucket in @($group.buckets)) {
            if ($null -eq $bucket) { continue }
            $remainingFraction = $bucket.remainingFraction
            $fractionPath = 'remainingFraction'
            if ($null -eq $remainingFraction) {
                $remainingFraction = $bucket.remaining.remainingFraction
                $fractionPath = 'remaining.remainingFraction'
            }
            if ($null -eq $remainingFraction -and $bucket.remaining.case -eq 'remainingFraction') {
                $remainingFraction = $bucket.remaining.value
                $fractionPath = 'remaining.value(case=remainingFraction)'
            }
            $row = [ordered]@{ scope = 'group-bucket'; remainingFractionPresent = ($null -ne $remainingFraction) }
            if ($null -ne $remainingFraction -and $remainingFraction -is [ValueType]) {
                $row.remainingFraction = $remainingFraction
                $row.fractionPath = $fractionPath
            }
            if ($bucket.bucketId -is [string] -and $bucket.bucketId -match '^(gemini|claude|gpt|weekly|session)[a-z0-9_-]*$') {
                $row.bucketId = $bucket.bucketId
            }
            if ($group.displayName -in @('Gemini Models', 'Claude and GPT models', 'Gemini', 'Claude + GPT')) {
                $row.group = $group.displayName
            }
            if ($bucket.window -is [string] -and $bucket.window -match '^[A-Z_0-9 -]{1,30}$') { $row.window = $bucket.window }
            if ($bucket.resetTime -is [DateTime] -or $bucket.resetTime -is [DateTimeOffset]) {
                $row.resetTime = $bucket.resetTime.ToUniversalTime().ToString('o')
            } elseif ($bucket.resetTime -is [string] -and $bucket.resetTime -match '^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$') {
                $row.resetTime = $bucket.resetTime
            }
            if ($null -ne $bucket.disabled -and $bucket.disabled -is [bool]) { $row.disabled = $bucket.disabled }
            $rows.Add([pscustomobject]$row)
        }
    }
    return @($rows.ToArray())
}

function Get-SafeQuotaSchema($json, [string]$path = '$', [int]$depth = 0) {
    if ($depth -gt 9 -or $null -eq $json) { return }
    $knownNames = @('response', 'summary', 'groups', 'buckets', 'bucketId', 'id', 'displayName', 'name',
        'description', 'disabled', 'remaining', 'remainingFraction', 'case', 'value', 'resetTime', 'window',
        'userStatus', 'cascadeModelConfigData', 'clientModelConfigs', 'quotaInfo', 'planStatus', 'planInfo',
        'planName', 'planDisplayName', 'userTier', 'email', 'code', 'message')
    if ($json -is [Array]) {
        for ($i = 0; $i -lt [Math]::Min($json.Count, 8); $i++) { Get-SafeQuotaSchema $json[$i] "$path[$i]" ($depth + 1) }
    } elseif ($json -is [pscustomobject]) {
        foreach ($property in $json.PSObject.Properties) {
            if ($property.Name -notin $knownNames) { continue }
            $childPath = $path + '.' + $property.Name
            $child = $property.Value
            $type = if ($null -eq $child) { 'null' } elseif ($child -is [Array]) { 'array' } elseif ($child -is [pscustomobject]) { 'object' }
                elseif ($child -is [bool]) { 'boolean' } elseif ($child -is [DateTime]) { 'string:date-time' }
                elseif ($child -is [ValueType]) { 'number' } else { 'string' }
            [pscustomobject]@{ path = $childPath; type = $type }
            Get-SafeQuotaSchema $child $childPath ($depth + 1)
        }
    }
}

try {
    $processes = Get-AppProcesses
    $result.preexistingProcessCount = $processes.Count
    if ($processes.Count -eq 0 -and $LaunchApp) {
        $stage = 'launch-installed-app'
        if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw [InvalidOperationException]::new() }
        $launchTime = [DateTime]::Now
        $started = Start-Process -FilePath $appPath -WindowStyle Hidden -PassThru
        $rootId = $started.Id
        $result.launched = $true
        $result.ownedRootPid = $rootId
    }

    $stage = 'wait-for-owned-local-service'
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    $server = $null
    do {
        $processes = Get-AppProcesses
        Remember-OwnedProcesses $processes
        $server = $processes | Where-Object {
            $_.ExecutablePath -eq $serverPath -and ($null -eq $rootId -or $owned.ContainsKey([string]$_.ProcessId))
        } | Select-Object -First 1
        if ($server) { break }
        if (-not $LaunchApp) { break }
        Start-Sleep -Milliseconds 1000
    } while ([DateTime]::UtcNow -lt $deadline)

    $result.appProcessCount = $processes.Count
    $result.languageServerDetected = ($null -ne $server)
    if (-not $server) {
        $result.outcome = 'no-local-language-server'
    } else {
        $stage = 'discover-process-scoped-service'
        $csrfMatch = [regex]::Match($server.CommandLine, '(?:^|\s)--csrf_token(?:=|\s+)(?:"([^"\r\n]+)"|([^\s]+))')
        $result.csrfFlagPresent = $csrfMatch.Success
        $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $server.ProcessId -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty LocalPort -Unique)
        $result.listeningPortCount = $ports.Count
        if (-not $csrfMatch.Success -or $ports.Count -eq 0) {
            $result.outcome = 'local-service-prerequisite-missing'
        } else {
            $csrfToken = if ($csrfMatch.Groups[1].Success) { $csrfMatch.Groups[1].Value } else { $csrfMatch.Groups[2].Value }
            $handler = [Net.Http.HttpClientHandler]::new()
            $handler.AllowAutoRedirect = $false
            $handler.UseCookies = $false
            # These endpoints use self-signed local TLS. The destination is fixed
            # to 127.0.0.1 and ports owned by the verified language-server PID.
            $handler.ServerCertificateCustomValidationCallback = [Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
            $client = [Net.Http.HttpClient]::new($handler)
            $client.Timeout = [TimeSpan]::FromSeconds(3)
            $client.MaxResponseContentBufferSize = 1048576
            $stage = 'read-only-local-quota-request'
            $quotaFound = $false
            $requestDeadline = [DateTime]::UtcNow.AddSeconds(15)
            foreach ($port in $ports) {
                foreach ($method in @('RetrieveUserQuotaSummary', 'GetUserStatus')) {
                    if ([DateTime]::UtcNow -ge $requestDeadline) { break }
                    $request = $null
                    $response = $null
                    $attempt = [ordered]@{ method = $method; transport = 'https-loopback'; port = $port }
                    try {
                        $endpoint = "https://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/$method"
                        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $endpoint)
                        [void]$request.Headers.TryAddWithoutValidation('X-Codeium-Csrf-Token', $csrfToken)
                        [void]$request.Headers.TryAddWithoutValidation('Connect-Protocol-Version', '1')
                        $requestBody = if ($method -eq 'RetrieveUserQuotaSummary') { '{"forceRefresh":true}' } else {
                            '{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en","ideVersion":"unknown"}}'
                        }
                        $request.Content = [Net.Http.StringContent]::new($requestBody, [Text.Encoding]::UTF8, 'application/json')
                        $response = $client.SendAsync($request).GetAwaiter().GetResult()
                        $attempt.httpStatus = [int]$response.StatusCode
                        if ([int]$response.StatusCode -eq 200) {
                            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                            $json = $body | ConvertFrom-Json
                            $safeFields = @(Get-SafeQuotaFields $json)
                            $attempt.quotaRecordCount = $safeFields.Count
                            $attempt.measuredQuotaRecordCount = @($safeFields | Where-Object { $_.remainingFractionPresent }).Count
                            $attempt.schema = @(Get-SafeQuotaSchema $json)
                            $attempt.accountIdentityPresent = ($null -ne $json.userStatus.email)
                            if ($attempt.measuredQuotaRecordCount -gt 0) {
                                $attempt.quotaFields = $safeFields
                                $quotaFound = $true
                            }
                        }
                    } catch {
                        $attempt.errorType = $_.Exception.GetType().Name
                    } finally {
                        if ($response) { $response.Dispose() }
                        if ($request) { $request.Dispose() }
                        $body = $null
                        $json = $null
                    }
                    $attempts.Add([pscustomobject]$attempt)
                }
                if ($quotaFound) { break }
            }
            $result.outcome = if ($quotaFound) { 'quota-read-success' } else { 'local-quota-not-returned' }
        }
    }
} catch {
    $result.outcome = 'failed'
    $result.failureStage = $stage
    $result.errorType = $_.Exception.GetType().Name
} finally {
    if ($client) { $client.Dispose() }
    if ($handler) { $handler.Dispose() }
    if ($rootId) {
        try {
            $cleanupProcesses = Get-AppProcesses
            Remember-OwnedProcesses $cleanupProcesses
            $stoppedCount = 0
            foreach ($entry in @($owned.Values | Sort-Object { if ($_.id -eq $rootId) { 1 } else { 0 } })) {
                $current = $cleanupProcesses | Where-Object { $_.ProcessId -eq $entry.id } | Select-Object -First 1
                if ($current -and $current.CreationDate -eq $entry.created -and $current.ExecutablePath -eq $entry.path) {
                    Stop-Process -Id $entry.id -ErrorAction SilentlyContinue
                    $stoppedCount++
                }
            }
            $result.cleanedOwnedProcessCount = $stoppedCount
        } catch {
            $result.cleanupOutcome = 'identity-check-or-stop-failed'
        }
    }
    $csrfToken = $null
    $csrfMatch = $null
    $server = $null
    $processes = $null
    $cleanupProcesses = $null
    $result.attempts = @($attempts.ToArray())
}
[pscustomobject]$result | ConvertTo-Json -Depth 10
