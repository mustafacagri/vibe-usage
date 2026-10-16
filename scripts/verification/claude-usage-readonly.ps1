[CmdletBinding()]
param()

# One GET, no inference, login, refresh, retries, or credential writes.
# Never print response bodies, credential values, identities, or exception messages.
$ErrorActionPreference = 'Stop'
$result = [ordered]@{
    observedAtUtc = [DateTime]::UtcNow.ToString('o')
    endpoint = 'https://api.anthropic.com/api/oauth/usage'
    credentialSource = 'Claude Code credentials file'
    credentialPresent = $false
    httpStatus = $null
    outcome = 'not_started'
}
$client = $null
$handler = $null
$response = $null
$credentialJson = $null
$credentialData = $null
$accessToken = $null
$responseText = $null
$usage = $null

try {
    $configDirectory = $env:CLAUDE_CONFIG_DIR
    if ([string]::IsNullOrWhiteSpace($configDirectory)) {
        $configDirectory = Join-Path $env:USERPROFILE '.claude'
    }
    $credentialPath = Join-Path $configDirectory '.credentials.json'
    if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        $result.outcome = 'credentials_file_absent'
    } else {
        $credentialJson = [IO.File]::ReadAllText($credentialPath)
        $credentialData = $credentialJson | ConvertFrom-Json
        $accessToken = $credentialData.claudeAiOauth.accessToken
        $result.credentialPresent = -not [string]::IsNullOrWhiteSpace($accessToken)
        if (-not $result.credentialPresent) {
            $result.outcome = 'claude_ai_access_token_absent'
        } else {
            Add-Type -AssemblyName System.Net.Http
            $handler = [System.Net.Http.HttpClientHandler]::new()
            $handler.AllowAutoRedirect = $false
            $client = [System.Net.Http.HttpClient]::new($handler)
            $client.Timeout = [TimeSpan]::FromSeconds(15)
            $client.MaxResponseContentBufferSize = 1048576
            $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $accessToken)
            [void]$client.DefaultRequestHeaders.TryAddWithoutValidation('anthropic-beta', 'oauth-2025-04-20')
            [void]$client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'vibe-widget-verification/0.1')
            $response = $client.GetAsync($result.endpoint).GetAwaiter().GetResult()
            $result.httpStatus = [int]$response.StatusCode
            if (-not $response.IsSuccessStatusCode) {
                $result.outcome = 'http_rejected'
            } else {
                $responseText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                $usage = $responseText | ConvertFrom-Json
                $result.outcome = 'quota_read_succeeded'
                $result.topLevelKeys = @($usage.PSObject.Properties.Name | Sort-Object)
                $result.standardWindows = @(
                    foreach ($windowName in @('five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet')) {
                        $window = $usage.$windowName
                        if ($null -ne $window) {
                            [ordered]@{
                                name = $windowName
                                utilization = $window.utilization
                                resetsAt = $window.resets_at
                            }
                        }
                    }
                )
                $limits = @($usage.limits | Where-Object { $null -ne $_ })
                $result.limitCount = $limits.Count
                $result.limitKindCounts = @($limits | Group-Object kind | ForEach-Object {
                    [ordered]@{kind=$_.Name;count=$_.Count}
                })
                $fableLimits = @($limits | Where-Object {
                    $_.kind -eq 'weekly_scoped' -and $_.scope.model.display_name -match 'Fable'
                })
                $result.fableScopedLimitPresent = $fableLimits.Count -gt 0
                $result.fableScopedLimits = @($fableLimits | ForEach-Object {
                    [ordered]@{percent=$_.percent;resetsAt=$_.resets_at;isActive=$_.is_active}
                })
                $result.extraUsagePresent = $null -ne $usage.extra_usage
            }
        }
    }
} catch {
    $result.outcome = 'local_or_transport_error'
    $errorChain = @()
    $currentException = $_.Exception
    for ($depth = 0; $null -ne $currentException -and $depth -lt 8; $depth++) {
        $safeError = [ordered]@{type=$currentException.GetType().FullName}
        if ($currentException -is [System.Net.WebException]) {
            $safeError.webStatus = $currentException.Status.ToString()
        }
        if ($currentException -is [System.Net.Sockets.SocketException]) {
            $safeError.socketError = $currentException.SocketErrorCode.ToString()
        }
        $errorChain += $safeError
        $currentException = $currentException.InnerException
    }
    $result.errorChain = $errorChain
} finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $client) { $client.Dispose() }
    elseif ($null -ne $handler) { $handler.Dispose() }
    Remove-Variable credentialJson,credentialData,accessToken,responseText,usage -ErrorAction SilentlyContinue
}

$result | ConvertTo-Json -Depth 7 -Compress
