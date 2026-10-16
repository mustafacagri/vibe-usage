# Reads the existing Cursor Agent login without changing or refreshing it.
# Sends one bounded GET to Cursor's own usage summary endpoint. No raw response,
# credentials, account identity, cookies, or exception messages reach stdout.
# Protocol evidence: CodexBar CursorAppAuth.swift and CursorStatusProbe.swift;
# Windows auth path evidence: installed Cursor Agent 2026.10.14 index.js.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$result = [ordered]@{
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    endpoint = 'https://cursor.com/api/usage-summary'
    credentialSource = 'existing-cursor-agent-login'
    credentialsPersisted = $false
    rawOutputSuppressed = $true
}
$stage = 'read-existing-auth'
$handler = $null
$client = $null
$request = $null
$response = $null

try {
    $authPath = Join-Path $env:APPDATA 'Cursor\auth.json'
    if (-not (Test-Path -LiteralPath $authPath -PathType Leaf)) {
        throw [InvalidOperationException]::new('missing-auth-file')
    }
    $auth = Get-Content -Raw -LiteralPath $authPath | ConvertFrom-Json
    $accessToken = $auth.accessToken
    if ($accessToken -isnot [string] -or [string]::IsNullOrWhiteSpace($accessToken)) {
        throw [InvalidOperationException]::new('missing-access-token')
    }

    $stage = 'validate-existing-token'
    $tokenParts = $accessToken.Split('.')
    if ($tokenParts.Length -ne 3) {
        throw [InvalidOperationException]::new('invalid-jwt')
    }
    $payloadBase64 = $tokenParts[1].Replace('-', '+').Replace('_', '/')
    $payloadBase64 = $payloadBase64.PadRight($payloadBase64.Length + ((4 - $payloadBase64.Length % 4) % 4), '=')
    $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadBase64)) | ConvertFrom-Json
    $subject = [string]$claims.sub
    $userId = $subject.Split('|')[-1]
    if ($userId -notmatch '^[A-Za-z0-9._-]+$' -or
        $null -eq $claims.exp -or
        [double]$claims.exp -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 60) {
        throw [InvalidOperationException]::new('unusable-existing-token')
    }
    $result.tokenUsable = $true

    $stage = 'read-only-https-request'
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $client.MaxResponseContentBufferSize = 1048576
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $result.endpoint)
    [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json')
    [void]$request.Headers.TryAddWithoutValidation('Cookie', "WorkosCursorSessionToken=$userId%3A%3A$accessToken")
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $result.httpStatus = [int]$response.StatusCode
    if ([int]$response.StatusCode -ne 200) {
        $result.outcome = 'http-non-success-body-suppressed'
    } else {
        $stage = 'parse-response'
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $summary = $body | ConvertFrom-Json
        $stage = 'emit-allowlisted-fields'
        $allowedPaths = @(
            'billingCycleStart', 'billingCycleEnd', 'membershipType', 'limitType', 'isUnlimited',
            'individualUsage.plan.enabled', 'individualUsage.plan.used', 'individualUsage.plan.limit',
            'individualUsage.plan.remaining', 'individualUsage.plan.autoPercentUsed',
            'individualUsage.plan.apiPercentUsed', 'individualUsage.plan.totalPercentUsed',
            'individualUsage.plan.breakdown.included', 'individualUsage.plan.breakdown.bonus',
            'individualUsage.plan.breakdown.total', 'individualUsage.onDemand.enabled',
            'individualUsage.onDemand.used', 'individualUsage.onDemand.limit',
            'individualUsage.onDemand.remaining', 'individualUsage.overall.enabled',
            'individualUsage.overall.used', 'individualUsage.overall.limit',
            'individualUsage.overall.remaining', 'teamUsage.onDemand.enabled',
            'teamUsage.onDemand.used', 'teamUsage.onDemand.limit', 'teamUsage.onDemand.remaining',
            'teamUsage.pooled.enabled', 'teamUsage.pooled.used', 'teamUsage.pooled.limit',
            'teamUsage.pooled.remaining'
        )
        $safeFields = [System.Collections.Generic.List[object]]::new()
        foreach ($fieldPath in $allowedPaths) {
            $value = $summary
            $present = $true
            foreach ($part in $fieldPath.Split('.')) {
                if ($null -eq $value -or $null -eq $value.PSObject.Properties[$part]) {
                    $present = $false
                    break
                }
                $value = $value.PSObject.Properties[$part].Value
            }
            if (-not $present) { continue }
            $row = [ordered]@{ path = $fieldPath }
            if ($null -eq $value) {
                $row.type = 'null'
            } elseif ($value -is [bool]) {
                $row.type = 'boolean'
                $row.value = $value
            } elseif (($value -is [DateTime] -or $value -is [DateTimeOffset]) -and
                $fieldPath -match '^billingCycle(Start|End)$') {
                $row.type = 'string:date-time'
                $row.value = $value.ToUniversalTime().ToString('o')
            } elseif ($value -is [ValueType] -and $value -isnot [DateTime]) {
                $row.type = 'number'
                $row.value = $value
            } elseif ($value -is [string]) {
                $row.type = 'string'
                if (($fieldPath -eq 'membershipType' -or $fieldPath -eq 'limitType') -and
                    $value -match '^[A-Za-z][A-Za-z0-9_ -]{0,40}$') {
                    $row.value = $value
                } elseif ($fieldPath -match '^billingCycle(Start|End)$' -and
                    $value -match '^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$') {
                    $row.value = $value
                }
            } else {
                $row.type = 'unexpected-value-suppressed'
            }
            $safeFields.Add([pscustomobject]$row)
        }
        $result.fields = @($safeFields.ToArray())
        $result.outcome = 'success'
    }
} catch {
    $result.outcome = 'failed'
    $result.failureStage = $stage
    $result.errorType = $_.Exception.GetType().Name
    $innerTypes = [System.Collections.Generic.List[string]]::new()
    $safeError = $_.Exception.InnerException
    for ($depth = 0; $null -ne $safeError -and $depth -lt 5; $depth++) {
        $innerTypes.Add($safeError.GetType().Name)
        if ($safeError -is [Net.Http.HttpRequestException]) {
            $result.httpErrorCategory = [string]$safeError.HttpRequestError
        }
        if ($safeError -is [Net.Sockets.SocketException]) {
            $result.socketErrorCategory = [string]$safeError.SocketErrorCode
        }
        $safeError = $safeError.InnerException
    }
    $result.innerErrorTypes = @($innerTypes.ToArray())
} finally {
    if ($response) { $response.Dispose() }
    if ($request) { $request.Dispose() }
    if ($client) { $client.Dispose() }
    if ($handler) { $handler.Dispose() }
    $accessToken = $null
    $auth = $null
    $claims = $null
    $subject = $null
    $userId = $null
    $tokenParts = $null
    $payloadBase64 = $null
    $body = $null
    $summary = $null
}
[pscustomobject]$result | ConvertTo-Json -Depth 8
