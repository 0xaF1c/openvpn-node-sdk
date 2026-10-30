#Requires -Version 5.1
<#
.SYNOPSIS
    Build a branded launcher for the SDK's UAC elevation helper.

.DESCRIPTION
    The Windows UAC consent dialog shows the icon, program name
    (FileDescription) and Authenticode publisher of the executable that is
    being elevated. The SDK normally elevates node.exe, which shows "Node.js"
    and the Node icon. This script compiles a tiny launcher with your own
    icon/title/product metadata; point `elevateLauncher` (or
    ElevatedBroker({ launcherPath })) at the result.

    The launcher is a generic "run this command elevated" wrapper:
        launcher.exe <nodePath> <helperPath> --port <port> --token <token>
    and forwards everything after <nodePath> to Node.js.

    Build result is unsigned unless -SignTool/-Certificate are supplied.
    Unsigned launchers show "Unknown publisher" in the UAC prompt; sign the
    executable for a verified publisher (signtool sign /fd SHA256 /a /tr ...).

.EXAMPLE
    .\scripts\build-elevate-launcher.ps1 -Title 'Acme VPN' -Product 'Acme VPN' `
        -Company 'Acme Inc.' -Icon .\assets\acme.ico -OutFile .\build\AcmeElevate.exe

.EXAMPLE
    .\scripts\build-elevate-launcher.ps1 -Title 'Acme VPN' -Icon .\acme.ico `
        -OutFile .\build\AcmeElevate.exe `
        -SignTool 'C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe' `
        -Certificate .\certs\acme.pfx
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Title,

    [string]$Product = '',
    [string]$Company = '',
    [string]$Description = '',

    [string]$Icon = '',
    [string]$OutFile = '',

    [string]$SignTool = '',
    [string]$Certificate = '',
    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Product)) { $Product = $Title }
if ([string]::IsNullOrWhiteSpace($Description)) { $Description = $Title }
if ([string]::IsNullOrWhiteSpace($Company)) { $Company = $Product }
if ([string]::IsNullOrWhiteSpace($OutFile)) { $OutFile = Join-Path (Get-Location) 'elevate-launcher.exe' }

$OutFile = [System.IO.Path]::GetFullPath($OutFile)
$outputDirectory = Split-Path -Parent $OutFile
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$csc = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw 'csc.exe (.NET Framework 4.x) was not found; install .NET Framework 4.8 or build the launcher with another toolchain.'
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('ovpn-elevate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

function ConvertTo-CSharpLiteral([string]$value) {
    return $value.Replace('\', '\\').Replace('"', '\"')
}

try {
    $sourceFile = Join-Path $work 'ElevateLauncher.cs'
    $assemblyFile = Join-Path $work 'AssemblyInfo.cs'

    @'
using System;
using System.Diagnostics;
using System.Text;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // args: <nodePath> <helperPath> [helper args...]
        if (args.Length < 2) return 2;

        var commandLine = new StringBuilder();
        for (var i = 1; i < args.Length; i++)
        {
            if (i > 1) commandLine.Append(' ');
            commandLine.Append(Quote(args[i]));
        }

        var start = new ProcessStartInfo(args[0])
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            Arguments = commandLine.ToString()
        };

        using (var child = Process.Start(start))
        {
            if (child == null) return 3;
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // Same quoting rules as CommandLineToArgvW (the SDK pre-quotes its own
    // arguments, so this mostly round-trips them unchanged).
    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '\r', '"' }) < 0) return value;

        var sb = new StringBuilder();
        sb.Append('"');
        var backslashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\') { backslashes++; continue; }
            if (ch == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            sb.Append('\\', backslashes);
            sb.Append(ch);
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
'@ | Set-Content -LiteralPath $sourceFile -Encoding utf8

    @"
using System.Reflection;

[assembly: AssemblyTitle("$(ConvertTo-CSharpLiteral $Title)")]
[assembly: AssemblyDescription("$(ConvertTo-CSharpLiteral $Description)")]
[assembly: AssemblyProduct("$(ConvertTo-CSharpLiteral $Product)")]
[assembly: AssemblyCompany("$(ConvertTo-CSharpLiteral $Company)")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("$(ConvertTo-CSharpLiteral $Product)")]
"@ | Set-Content -LiteralPath $assemblyFile -Encoding utf8

    $compilerArguments = @('/nologo', '/target:winexe', '/optimize+', "/out:$OutFile")
    if (-not [string]::IsNullOrWhiteSpace($Icon)) {
        $iconPath = [System.IO.Path]::GetFullPath($Icon)
        if (-not (Test-Path -LiteralPath $iconPath)) {
            throw "Icon not found: $iconPath"
        }
        $compilerArguments += "/win32icon:$iconPath"
    }
    $compilerArguments += $sourceFile, $assemblyFile

    & $csc @compilerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "csc.exe failed with exit code $LASTEXITCODE"
    }

    $version = (Get-Item -LiteralPath $OutFile).VersionInfo
    Write-Host "built : $OutFile"
    Write-Host "UAC   : program name '$($version.FileDescription)', product '$($version.ProductName)'"

    if (-not [string]::IsNullOrWhiteSpace($SignTool) -and -not [string]::IsNullOrWhiteSpace($Certificate)) {
        & $SignTool sign /fd SHA256 /f $Certificate /tr $TimestampUrl /td SHA256 $OutFile
        if ($LASTEXITCODE -ne 0) {
            throw "signtool failed with exit code $LASTEXITCODE"
        }
        Write-Host 'signed: UAC should show the certificate subject as the publisher'
    } else {
        Write-Warning 'unsigned launcher: UAC will show "Unknown publisher". Sign it with signtool for a verified publisher.'
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
