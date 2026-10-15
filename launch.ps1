# Patches the installed T3 Code (the editor-discovery timeout and the mods in
# this folder), then starts it. -PatchOnly patches without starting T3. Run it
# with T3 closed; restart-and-apply.ps1 closes and reopens T3 around it.
param(
    [switch]$PatchOnly,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$T3Arguments
)

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\t3code'
$serverArchive = Join-Path $installDir 'resources\server.asar'
# "T3 Code.exe" for stable builds, "T3 Code (Nightly).exe" for nightlies.
$t3Exe = Get-ChildItem -LiteralPath $installDir -Filter 'T3 Code*.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $t3Exe) {
    throw "T3 Code was not found in $installDir"
}

# Some T3 builds probe supported editors one at a time, but abort all
# discovery after five seconds. On Windows, a long PATH can exhaust that limit
# before it reaches the editor you use. This same-length patch preserves ASAR
# offsets and gives discovery one minute. Builds without that code report
# "not-applicable" and are left alone.
if (Test-Path -LiteralPath $serverArchive -PathType Leaf) {
    if (-not ('T3EditorDiscoveryPatch' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;

public static class T3EditorDiscoveryPatch
{
    private static int Find(byte[] data, byte[] pattern, out int matchOffset)
    {
        int count = 0;
        matchOffset = -1;

        for (int i = 0; i <= data.Length - pattern.Length; i++)
        {
            if (data[i] != pattern[0]) continue;

            int j = 1;
            while (j < pattern.Length && data[i + j] == pattern[j]) j++;
            if (j != pattern.Length) continue;

            count++;
            matchOffset = i;
            i += pattern.Length - 1;
        }

        return count;
    }

    // Returns "patched", "already-patched", or "not-applicable".
    public static string Apply(string archivePath)
    {
        byte[] oldValue = Encoding.ASCII.GetBytes(
            "const CONFIG_DISCOVERY_TIMEOUT = seconds(5);");
        byte[] newValue = Encoding.ASCII.GetBytes(
            "const CONFIG_DISCOVERY_TIMEOUT = minutes(1);");

        if (oldValue.Length != newValue.Length)
            throw new InvalidOperationException("Patch values must have equal lengths.");

        byte[] archive = File.ReadAllBytes(archivePath);
        int oldOffset;
        int newOffset;
        int oldCount = Find(archive, oldValue, out oldOffset);
        int newCount = Find(archive, newValue, out newOffset);

        if (newCount == 1 && oldCount == 0) return "already-patched";
        if (newCount == 0 && oldCount == 0) return "not-applicable";
        if (oldCount != 1 || newCount != 0)
            throw new InvalidOperationException(
                "Refusing to patch an unexpected server.asar layout.");

        string hash;
        using (SHA256 sha = SHA256.Create())
            hash = BitConverter.ToString(sha.ComputeHash(archive)).Replace("-", "").ToLowerInvariant();
        string backupDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".t3", "repair-backups", hash);
        Directory.CreateDirectory(backupDirectory);
        string backupPath = Path.Combine(backupDirectory, "server.asar");
        if (!File.Exists(backupPath)) File.WriteAllBytes(backupPath, archive);

        using (FileStream stream = new FileStream(
            archivePath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
        {
            stream.Position = oldOffset;
            stream.Write(newValue, 0, newValue.Length);
            stream.Flush(true);
        }

        return "patched";
    }
}
'@
    }

    # A layout change must not block the mods below or the launch.
    try {
        $patchResult = [T3EditorDiscoveryPatch]::Apply($serverArchive)
    } catch {
        $patchResult = 'failed'
        Write-Warning "Editor timeout workaround failed: $($_.Exception.Message)"
    }
    if ($PatchOnly) { Write-Output $patchResult }
    if ($patchResult -eq 'not-applicable') {
        Write-Warning 'The installed T3 bundle has changed; the editor timeout workaround was not applied.'
    }
}

# The UI mods in this folder. apply.mjs is a no-op when the installed bundle
# already carries the current mods. A failure here must not block launching T3.
$modsApply = Join-Path $PSScriptRoot 'apply.mjs'
$node = Get-Command node -ErrorAction SilentlyContinue
if ((Test-Path -LiteralPath $modsApply -PathType Leaf) -and $node) {
    & $node.Source $modsApply --asar $serverArchive --quiet
    if ($LASTEXITCODE -ne 0) { Write-Warning "T3 mods were not applied; run node `"$modsApply`" to see why." }
}

if (-not $PatchOnly) {
    $launchOptions = @{
        FilePath = $t3Exe
        WorkingDirectory = Split-Path -Parent $t3Exe
        WindowStyle = 'Hidden'
    }

    if ($T3Arguments.Count -gt 0) {
        $launchOptions.ArgumentList = $T3Arguments
    }

    Start-Process @launchOptions
}
