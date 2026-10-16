param([Parameter(Mandatory=$true)][string]$ConfigDirectory,[Parameter(Mandatory=$true)][string]$ProjectDirectory,[Parameter(Mandatory=$true)][string]$ClaudeBinary,[switch]$DefaultProfile)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $ProjectDirectory
if ($DefaultProfile) { [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR',$null,'Process') } else { $env:CLAUDE_CONFIG_DIR=$ConfigDirectory }
foreach ($credentialOverride in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_PROFILE','CLAUDE_SECURESTORAGE_CONFIG_DIR','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY')) { [Environment]::SetEnvironmentVariable($credentialOverride,$null,'Process') }
Write-Host 'Vibe Usage: yeni Claude Code oturumu. Devam eden işler değiştirilmedi.'
& $ClaudeBinary
