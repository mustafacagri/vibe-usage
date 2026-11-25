# Internal transport only. Stdout includes a CSRF capability and must be consumed
# in memory by the main process. Do not invoke this script in a visible console.
# Windows PowerShell 5 compatible; no application or network request is started.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = [ordered]@{ outcome = 'app_closed'; servers = @() }

$nativeType = 'VibeUsage.AntigravityProcProbe'
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace VibeUsage {
    public sealed class ProcessInfoSnapshot {
        public string OwnerSid;
        public string ImagePath;
        public long CreationFileTime;
    }

    public static class AntigravityProcProbe {
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenUser = 1;
        private const int AF_INET = 2;
        private const int TCP_TABLE_OWNER_PID_LISTENER = 3;
        private const uint MIB_TCP_STATE_LISTEN = 2;
        private const uint ERROR_INSUFFICIENT_BUFFER = 122;

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_USER {
            public IntPtr Sid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MIB_TCPROW_OWNER_PID {
            public uint state;
            public uint localAddr;
            public uint localPort;
            public uint remoteAddr;
            public uint remotePort;
            public uint owningPid;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(
            IntPtr process,
            out FILETIME creation,
            out FILETIME exit,
            out FILETIME kernel,
            out FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(
            IntPtr process,
            uint flags,
            StringBuilder exeName,
            ref int size);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle,
            int tokenInformationClass,
            IntPtr tokenInformation,
            int tokenInformationLength,
            out int returnLength);

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(
            IntPtr tcpTable,
            ref int outBufLen,
            bool sort,
            int ipVersion,
            int tableClass,
            uint reserved);

        public static ProcessInfoSnapshot InspectProcess(int pid) {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            try {
                FILETIME created, exit, kernel, user;
                if (!GetProcessTimes(process, out created, out exit, out kernel, out user)) return null;
                long creationTime = (((long)created.HighDateTime) << 32) | created.LowDateTime;

                int capacity = 1024;
                StringBuilder pathBuf = new StringBuilder(capacity);
                if (!QueryFullProcessImageName(process, 0, pathBuf, ref capacity)) return null;

                IntPtr token = IntPtr.Zero;
                if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return null;
                try {
                    int needed = 0;
                    GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out needed);
                    if (needed <= 0) return null;
                    IntPtr buffer = Marshal.AllocHGlobal(needed);
                    try {
                        if (!GetTokenInformation(token, TokenUser, buffer, needed, out needed)) return null;
                        TOKEN_USER tokenUser = (TOKEN_USER)Marshal.PtrToStructure(buffer, typeof(TOKEN_USER));
                        string sid = new SecurityIdentifier(tokenUser.Sid).Value;
                        return new ProcessInfoSnapshot {
                            OwnerSid = sid,
                            ImagePath = pathBuf.ToString(),
                            CreationFileTime = creationTime
                        };
                    } finally {
                        Marshal.FreeHGlobal(buffer);
                    }
                } finally {
                    CloseHandle(token);
                }
            } finally {
                CloseHandle(process);
            }
        }

        public static int[] GetLoopbackPortsForPid(int targetPid) {
            var ports = new List<int>();
            int size = 0;
            uint ret = GetExtendedTcpTable(IntPtr.Zero, ref size, true, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
            if (ret != ERROR_INSUFFICIENT_BUFFER || size <= 0) return ports.ToArray();
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                ret = GetExtendedTcpTable(buffer, ref size, true, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
                if (ret != 0) return ports.ToArray();
                int count = Marshal.ReadInt32(buffer);
                int rowSize = Marshal.SizeOf(typeof(MIB_TCPROW_OWNER_PID));
                IntPtr rowPtr = IntPtr.Add(buffer, 4);
                for (int i = 0; i < count; i++) {
                    MIB_TCPROW_OWNER_PID row = (MIB_TCPROW_OWNER_PID)Marshal.PtrToStructure(rowPtr, typeof(MIB_TCPROW_OWNER_PID));
                    rowPtr = IntPtr.Add(rowPtr, rowSize);
                    if (row.state != MIB_TCP_STATE_LISTEN) continue;
                    if (unchecked((int)row.owningPid) != targetPid) continue;
                    string addr = new IPAddress((long)row.localAddr).ToString();
                    if (addr != "127.0.0.1" && addr != "0.0.0.0") continue;
                    int port = (int)(((row.localPort & 0xFF) << 8) | ((row.localPort >> 8) & 0xFF));
                    if (port > 0 && port <= 65535 && !ports.Contains(port)) ports.Add(port);
                }
                ports.Sort();
                return ports.ToArray();
            } finally {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}
'@

try {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $currentIdentity.User.Value
    if ([string]::IsNullOrWhiteSpace($currentSid)) { throw 'identity-unavailable' }

    $programs = Join-Path $env:LOCALAPPDATA 'Programs'
    $appServer = Join-Path $programs 'Antigravity\resources\bin\language_server.exe'
    $ideRoot = (Join-Path $programs 'Antigravity IDE\resources\app\extensions\antigravity\bin') + '\'
    # Current builds run the language server as `agy.exe --hub`, started by the IDE or the CLI.
    $agyServer = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'
    $hubDescriptorDir = Join-Path $env:USERPROFILE '.gemini\antigravity\daemon'

    # Query Win32_Process once for CommandLine; owner SID, sockets and PID-reuse checks use native Win32 APIs
    # to avoid multi-second per-process WMI/CIM round-trips.
    $processes = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%' OR Name LIKE 'language-server%' OR Name = 'agy.exe'")
    $servers = New-Object System.Collections.Generic.List[object]
    $candidateFound = $false

    if ($processes.Count -gt 0 -and -not ($nativeType -as [type])) {
        Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
    }

    foreach ($entry in $processes) {
        if ($servers.Count -ge 4) { break }
        $procPid = [int]$entry.ProcessId
        $executable = [string]$entry.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($executable)) { continue }
        $isApp = [string]::Equals($executable, $appServer, [StringComparison]::OrdinalIgnoreCase)
        $isIDE = $executable.StartsWith($ideRoot, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($executable) -match '^language[-_]server(?:[-_][a-zA-Z0-9]+)*\.exe$'
        # Only the hub process carries the quota service; one-shot `agy` runs have no --hub flag.
        $isAgy = [string]::Equals($executable, $agyServer, [StringComparison]::OrdinalIgnoreCase) -and
            [string]$entry.CommandLine -match '(?:^|\s)--hub(?:=|\s|$)'
        if (-not $isApp -and -not $isIDE -and -not $isAgy) { continue }
        # A matching installation path alone does not establish ownership.
        # Never inspect another Windows user's CSRF capability or sockets.
        $before = [VibeUsage.AntigravityProcProbe]::InspectProcess($procPid)
        if ($null -eq $before -or
            -not [string]::Equals($before.OwnerSid, $currentSid, [StringComparison]::Ordinal)) { continue }
        # agy's self-updater renames the running binary in-place (e.g. agy.exe.<ts>.old),
        # so the live kernel image path may have a renamed filename inside the same directory.
        $expectedDir = (Split-Path -Parent $executable) + '\'
        if (-not [string]::Equals($before.ImagePath, $executable, [StringComparison]::OrdinalIgnoreCase) -and
            -not $before.ImagePath.StartsWith($expectedDir, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $candidateFound = $true
        $match = [regex]::Match([string]$entry.CommandLine, '(?:^|\s)--csrf_token(?:=|\s+)(?:"([^"\r\n]+)"|([^\s]+))')
        $csrfToken = $null
        if ($match.Success) {
            $csrfToken = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        }
        # A hub that keeps its CSRF capability off the command line (agy 2.35+) writes it to its own descriptor.
        $needsDescriptor = $isAgy -and [string]::IsNullOrEmpty($csrfToken)
        if (-not $needsDescriptor -and ([string]::IsNullOrEmpty($csrfToken) -or $csrfToken.Length -gt 512 -or $csrfToken -match '[\x00-\x20\x7f]')) { continue }
        $ports = @([VibeUsage.AntigravityProcProbe]::GetLoopbackPortsForPid($procPid) | Select-Object -First 4)
        if ($ports.Count -eq 0) { continue }
        if ($needsDescriptor) {
            # Only a descriptor naming this exact PID and one of the ports this PID listens on is trusted.
            $csrfToken = $null
            foreach ($file in @(Get-ChildItem -LiteralPath $hubDescriptorDir -Filter 'hub_*.json' -File -ErrorAction SilentlyContinue | Select-Object -First 64)) {
                try {
                    if ($file.Length -gt 4096) { continue }
                    $descriptor = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
                    if ([int]$descriptor.pid -ne $procPid) { continue }
                    if ($ports -notcontains [int]$descriptor.httpPort -and $ports -notcontains [int]$descriptor.httpsPort) { continue }
                    $candidate = [string]$descriptor.csrfToken
                    if ($candidate.Length -gt 0 -and $candidate.Length -le 512 -and $candidate -notmatch '[\x00-\x20\x7f]') { $csrfToken = $candidate; break }
                } catch { continue }
            }
            $descriptor = $null
            if ([string]::IsNullOrEmpty($csrfToken)) { continue }
        }
        # Recheck identity after querying sockets so a recycled PID cannot inherit
        # this server's capability. Only this exact process's listening ports pass.
        $after = [VibeUsage.AntigravityProcProbe]::InspectProcess($procPid)
        if ($null -eq $after -or
            $after.CreationFileTime -ne $before.CreationFileTime -or
            -not [string]::Equals($after.OwnerSid, $currentSid, [StringComparison]::Ordinal) -or
            -not [string]::Equals($after.ImagePath, $before.ImagePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $servers.Add([pscustomobject]@{ pid = $procPid; csrfToken = $csrfToken; ports = @($ports) })
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
    $before = $null
    $after = $null
    $processes = $null
    $currentSid = $null
    if ($null -ne $currentIdentity) { $currentIdentity.Dispose() }
    $currentIdentity = $null
}
[Console]::WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
