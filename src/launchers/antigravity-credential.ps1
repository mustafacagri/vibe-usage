# Internal transport only. Never logs, prints or exposes credential bytes.
# Windows PowerShell 5.1 compatible.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'switch', 'restore')]
    [string]$Action,

    [string]$TokenFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$ACTIVE_TARGET = 'gemini:antigravity'
$ACTIVE_USER = 'antigravity'
$BACKUP_TARGET = 'vibe-usage:antigravity-backup'
$BACKUP_USER = 'vibe-usage'
$MAX_BLOB_BYTES = 2560

$credCode = @'
using System;
using System.Runtime.InteropServices;

public static class VibeCredManager {
    private const uint CRED_TYPE_GENERIC = 1;
    private const uint CRED_PERSIST_LOCAL_MACHINE = 2;
    private const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    public static bool Exists(string target) {
        IntPtr ptr;
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {
            return false;
        }
        CredFree(ptr);
        return true;
    }

    public static byte[] ReadBytes(string target, out int errorCode) {
        IntPtr ptr;
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {
            errorCode = Marshal.GetLastWin32Error();
            return null;
        }
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            errorCode = 0;
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) {
                return new byte[0];
            }
            byte[] data = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, data, 0, (int)cred.CredentialBlobSize);
            return data;
        } finally {
            CredFree(ptr);
        }
    }

    public static bool WriteBytes(string target, string userName, byte[] data, out int errorCode) {
        IntPtr blob = Marshal.AllocHGlobal(data.Length);
        try {
            if (data.Length > 0) {
                Marshal.Copy(data, 0, blob, data.Length);
            }
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = CRED_TYPE_GENERIC;
            cred.TargetName = target;
            cred.UserName = userName;
            cred.CredentialBlobSize = (uint)data.Length;
            cred.CredentialBlob = blob;
            cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
            bool ok = CredWrite(ref cred, 0);
            errorCode = ok ? 0 : Marshal.GetLastWin32Error();
            return ok;
        } finally {
            if (data.Length > 0) {
                byte[] zeros = new byte[data.Length];
                Marshal.Copy(zeros, 0, blob, data.Length);
            }
            Marshal.FreeHGlobal(blob);
        }
    }
}
'@

function Write-Result {
    param([hashtable]$Payload)
    [Console]::WriteLine(($Payload | ConvertTo-Json -Depth 4 -Compress))
}

function Ensure-CredType {
    if (-not ('VibeCredManager' -as [type])) {
        Add-Type -TypeDefinition $credCode -Language CSharp
    }
}

function Read-NormalizedTokenBytes {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'token_missing'
    }
    $rawText = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    $doc = $rawText | ConvertFrom-Json
    $rawText = $null
    if ($null -eq $doc -or $null -eq $doc.token) {
        throw 'invalid_token'
    }
    $hasAccess = -not [string]::IsNullOrWhiteSpace([string]$doc.token.access_token)
    $hasRefresh = -not [string]::IsNullOrWhiteSpace([string]$doc.token.refresh_token)
    if (-not $hasAccess -and -not $hasRefresh) {
        throw 'invalid_token'
    }
    # Promote nested token.id_token to top level and remove the duplicate so the
    # credential blob stays under Windows Credential Manager's 2560-byte limit.
    if ($doc.token.PSObject.Properties['id_token']) {
        if (-not $doc.PSObject.Properties['id_token'] -or [string]::IsNullOrWhiteSpace([string]$doc.id_token)) {
            $doc | Add-Member -NotePropertyName 'id_token' -NotePropertyValue $doc.token.id_token -Force
        }
        $doc.token.PSObject.Properties.Remove('id_token')
    }
    $compact = $doc | ConvertTo-Json -Depth 10 -Compress
    $doc = $null
    $bytes = [Text.Encoding]::UTF8.GetBytes($compact)
    $compact = $null
    if ($bytes.Length -gt $MAX_BLOB_BYTES) {
        [Array]::Clear($bytes, 0, $bytes.Length)
        throw 'payload_too_large'
    }
    return ,$bytes
}

function Restart-AgyHub {
    $currentIdentity = $null
    try {
        $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $currentSid = $currentIdentity.User.Value
        if ([string]::IsNullOrWhiteSpace($currentSid)) { return $false }
        $agyServer = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'
        if (-not (Test-Path -LiteralPath $agyServer -PathType Leaf)) { return $false }
        $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'agy.exe'" -ErrorAction SilentlyContinue)
        $stopped = 0
        foreach ($entry in $processes) {
            $executable = [string]$entry.ExecutablePath
            if (-not [string]::Equals($executable, $agyServer, [StringComparison]::OrdinalIgnoreCase)) { continue }
            if ([string]$entry.CommandLine -notmatch '(?:^|\s)--hub(?:=|\s|$)') { continue }
            $owner = Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid -ErrorAction SilentlyContinue
            if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or
                -not [string]::Equals([string]$owner.Sid, $currentSid, [StringComparison]::Ordinal)) { continue }
            Stop-Process -Id ([int]$entry.ProcessId) -Force -ErrorAction SilentlyContinue
            $stopped++
        }
        if ($stopped -gt 0) {
            Start-Sleep -Milliseconds 300
        }
        Start-Process -FilePath $agyServer -ArgumentList '--hub' -WindowStyle Hidden | Out-Null
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $currentIdentity) { $currentIdentity.Dispose() }
    }
}

$previousBytes = $null
$newBytes = $null
$backupBytes = $null

try {
    Ensure-CredType

    if ($Action -eq 'status') {
        $hasBackup = [VibeCredManager]::Exists($BACKUP_TARGET)
        Write-Result ([ordered]@{ ok = $true; hasBackup = [bool]$hasBackup })
        exit 0
    }

    if ($Action -eq 'switch') {
        $newBytes = Read-NormalizedTokenBytes -Path $TokenFile
        $readErr = 0
        $previousBytes = [VibeCredManager]::ReadBytes($ACTIVE_TARGET, [ref]$readErr)
        $backedUp = $false
        if ($null -ne $previousBytes -and $previousBytes.Length -gt 0) {
            $backupErr = 0
            if (-not [VibeCredManager]::WriteBytes($BACKUP_TARGET, $BACKUP_USER, $previousBytes, [ref]$backupErr)) {
                throw 'backup_failed'
            }
            $backedUp = $true
        } elseif ($readErr -ne 0 -and $readErr -ne 1168) {
            throw 'backup_failed'
        }
        $writeErr = 0
        if (-not [VibeCredManager]::WriteBytes($ACTIVE_TARGET, $ACTIVE_USER, $newBytes, [ref]$writeErr)) {
            throw 'write_failed'
        }
        $hubRestarted = Restart-AgyHub
        Write-Result ([ordered]@{ ok = $true; backedUp = $backedUp; hubRestarted = [bool]$hubRestarted })
        exit 0
    }

    if ($Action -eq 'restore') {
        $readErr = 0
        $backupBytes = [VibeCredManager]::ReadBytes($BACKUP_TARGET, [ref]$readErr)
        if ($null -eq $backupBytes -or $backupBytes.Length -eq 0) {
            if ($readErr -eq 1168) {
                throw 'no_backup'
            }
            throw 'read_failed'
        }
        $writeErr = 0
        if (-not [VibeCredManager]::WriteBytes($ACTIVE_TARGET, $ACTIVE_USER, $backupBytes, [ref]$writeErr)) {
            throw 'write_failed'
        }
        $hubRestarted = Restart-AgyHub
        Write-Result ([ordered]@{ ok = $true; hubRestarted = [bool]$hubRestarted })
        exit 0
    }
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notin @('token_missing', 'invalid_token', 'payload_too_large', 'backup_failed', 'write_failed', 'no_backup', 'read_failed')) {
        $code = 'switch_failed'
    }
    Write-Result ([ordered]@{ ok = $false; error = $code })
    exit 0
} finally {
    if ($null -ne $previousBytes) { [Array]::Clear($previousBytes, 0, $previousBytes.Length); $previousBytes = $null }
    if ($null -ne $newBytes) { [Array]::Clear($newBytes, 0, $newBytes.Length); $newBytes = $null }
    if ($null -ne $backupBytes) { [Array]::Clear($backupBytes, 0, $backupBytes.Length); $backupBytes = $null }
}
