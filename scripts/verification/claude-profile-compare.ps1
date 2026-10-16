[CmdletBinding()]
param()

# Compares the two user-authorized local configs. No identities or tokens are output.
# One GET per config, exact HTTPS host, redirects off, no inference/login/refresh.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$defaultConfig = Join-Path $env:USERPROFILE '.claude'
$secondaryConfig = Join-Path $env:USERPROFILE '.claude-secondary'
$defaultCredential = Join-Path $defaultConfig '.credentials.json'
$secondaryCredential = Join-Path $secondaryConfig '.credentials.json'
$result = [ordered]@{
    observedAtUtc = [DateTime]::UtcNow.ToString('o')
    defaultHttpStatus = $null
    secondaryHttpStatus = $null
    userIdentityComparisonAvailable = $false
    distinctUserAccounts = $false
    organizationComparisonAvailable = $false
    distinctOrganizations = $false
    defaultCredentialUnchanged = $null
    secondaryCredentialUnchanged = $null
    outcome = 'not_started'
}

function Get-ProfileInMemory {
    param([string]$CredentialPath)
    $credentialText = $null
    $credentialData = $null
    $accessToken = $null
    $responseText = $null
    $handler = $null
    $client = $null
    $response = $null
    try {
        $credentialText = [IO.File]::ReadAllText($CredentialPath)
        $credentialData = $credentialText | ConvertFrom-Json
        $accessToken = $credentialData.claudeAiOauth.accessToken
        if ([string]::IsNullOrWhiteSpace($accessToken)) { return @{status=$null;profile=$null} }
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(15)
        $client.MaxResponseContentBufferSize = 1048576
        $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $accessToken)
        [void]$client.DefaultRequestHeaders.TryAddWithoutValidation('anthropic-beta', 'oauth-2025-04-20')
        [void]$client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'vibe-widget-verification/0.1')
        $response = $client.GetAsync('https://api.anthropic.com/api/oauth/profile').GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { return @{status=[int]$response.StatusCode;profile=$null} }
        $responseText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return @{status=[int]$response.StatusCode;profile=($responseText | ConvertFrom-Json)}
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
        elseif ($null -ne $handler) { $handler.Dispose() }
        Remove-Variable credentialText,credentialData,accessToken,responseText -ErrorAction SilentlyContinue
    }
}

$defaultHashBefore = $null
$secondaryHashBefore = $null
$defaultProfile = $null
$secondaryProfile = $null
try {
    $defaultHashBefore = (Get-FileHash -LiteralPath $defaultCredential -Algorithm SHA256).Hash
    $secondaryHashBefore = (Get-FileHash -LiteralPath $secondaryCredential -Algorithm SHA256).Hash
    $defaultProfile = Get-ProfileInMemory $defaultCredential
    $result.defaultHttpStatus = $defaultProfile.status
    $secondaryProfile = Get-ProfileInMemory $secondaryCredential
    $result.secondaryHttpStatus = $secondaryProfile.status
    if ($null -ne $defaultProfile.profile -and $null -ne $secondaryProfile.profile) {
        $defaultAccountId = [string]$defaultProfile.profile.account.uuid
        $secondaryAccountId = [string]$secondaryProfile.profile.account.uuid
        $defaultEmail = [string]$defaultProfile.profile.account.email
        $secondaryEmail = [string]$secondaryProfile.profile.account.email
        $accountIdsPresent = -not [string]::IsNullOrWhiteSpace($defaultAccountId) -and -not [string]::IsNullOrWhiteSpace($secondaryAccountId)
        $emailsPresent = -not [string]::IsNullOrWhiteSpace($defaultEmail) -and -not [string]::IsNullOrWhiteSpace($secondaryEmail)
        $result.userIdentityComparisonAvailable = $accountIdsPresent -or $emailsPresent
        if ($accountIdsPresent) {
            $result.distinctUserAccounts = -not [string]::Equals($defaultAccountId,$secondaryAccountId,[StringComparison]::Ordinal)
        } elseif ($emailsPresent) {
            $result.distinctUserAccounts = -not [string]::Equals($defaultEmail.Trim(),$secondaryEmail.Trim(),[StringComparison]::OrdinalIgnoreCase)
        }
        $defaultOrganizationId = [string]$defaultProfile.profile.organization.uuid
        $secondaryOrganizationId = [string]$secondaryProfile.profile.organization.uuid
        $result.organizationComparisonAvailable = -not [string]::IsNullOrWhiteSpace($defaultOrganizationId) -and -not [string]::IsNullOrWhiteSpace($secondaryOrganizationId)
        if ($result.organizationComparisonAvailable) {
            $result.distinctOrganizations = -not [string]::Equals($defaultOrganizationId,$secondaryOrganizationId,[StringComparison]::Ordinal)
        }
        $result.outcome = 'profile_comparison_completed'
    } else {
        $result.outcome = 'profile_request_incomplete'
    }
} catch {
    $result.outcome = 'local_or_transport_error'
    $errorChain = @()
    $currentException = $_.Exception
    for ($depth=0; $null -ne $currentException -and $depth -lt 8; $depth++) {
        $safeError = [ordered]@{type=$currentException.GetType().FullName}
        if ($currentException -is [System.Net.Sockets.SocketException]) {
            $safeError.socketError = $currentException.SocketErrorCode.ToString()
        }
        $errorChain += $safeError
        $currentException = $currentException.InnerException
    }
    $result.errorChain = $errorChain
} finally {
    if ($null -ne $defaultHashBefore) {
        $result.defaultCredentialUnchanged = $defaultHashBefore -eq (Get-FileHash -LiteralPath $defaultCredential -Algorithm SHA256).Hash
    }
    if ($null -ne $secondaryHashBefore) {
        $result.secondaryCredentialUnchanged = $secondaryHashBefore -eq (Get-FileHash -LiteralPath $secondaryCredential -Algorithm SHA256).Hash
    }
    Remove-Variable defaultHashBefore,secondaryHashBefore,defaultProfile,secondaryProfile,defaultAccountId,secondaryAccountId,defaultEmail,secondaryEmail,defaultOrganizationId,secondaryOrganizationId -ErrorAction SilentlyContinue
}
$result | ConvertTo-Json -Depth 5 -Compress
