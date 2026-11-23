<#
  Checks the Windows installer the way she will use it, on a throwaway CI runner
  (.github/workflows/release.yml, windows-2025). Never run it on a computer someone uses:
  it moves that user's Documents and Desktop, changes their languages, installs and
  uninstalls the app, and writes into their home folder.

  One step per call, in this order:
    onedrive   Moves Documents and Desktop into %USERPROFILE%\OneDrive, as OneDrive's
               folder backup (Known Folder Move) does, through the same Windows call.
    install    Installs with the installer given (-Installer), silently, as the current
               user. Checks: no administrator rights asked, installed under
               %LOCALAPPDATA%\Programs, the uninstall entry in the user's registry only, the
               Start menu and Desktop shortcuts, nothing signed. Gives the tests the
               installed executable (ABA_PACKAGED_EXECUTABLE, through GITHUB_ENV).
    spanish    Puts Spanish first in Windows' languages, as on a Spanish Windows.
    reinstall  The update path: adds a file of hers to the cases folder and to the app's
               data folder, records every file in both, then runs the installer (-Installer)
               again over the installed app, which first runs the installed app's own
               uninstaller as every update does. Checks that uninstaller ran (a file put in
               the install folder is gone), the app and its shortcuts are back, and every
               one of her files is still there, unchanged.
    uninstall  Records every file in both folders again, uninstalls silently, and checks
               that the app, its shortcuts and its uninstall entry are gone while every one
               of her files is still there, unchanged.
  Windows PowerShell 5.1; ASCII only, so it reads the same in any code page.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("onedrive", "install", "spanish", "reinstall", "uninstall")][string]$Step,
  [string]$Installer
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProductName = "ABA Workbench"
$UninstallRoot = "Software\Microsoft\Windows\CurrentVersion\Uninstall"

function Fail([string]$message) {
  Write-Host "::error::$message"
  exit 1
}

function Pass([string]$message) {
  Write-Host "ok - $message"
}

# Where Windows lists installed apps: the user's, and the machine's in its 64-bit and 32-bit views.
$UserUninstall = "HKCU:\$UninstallRoot"
$MachineUninstall = @("HKLM:\$UninstallRoot", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall")

# The app's uninstall entry under one registry key, or null. A key the uninstaller removes
# while this reads it, or one with no values, is skipped rather than failing the check.
function Find-UninstallEntry([string]$root) {
  if (-not (Test-Path $root)) { return $null }
  foreach ($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
    $entry = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $entry) { continue }
    if (($entry.PSObject.Properties.Name -contains "DisplayName") -and ($entry.DisplayName -like "$ProductName*")) { return $entry }
  }
  return $null
}

function Find-MachineUninstallEntry {
  foreach ($root in $MachineUninstall) {
    $entry = Find-UninstallEntry $root
    if ($null -ne $entry) { return $entry }
  }
  return $null
}

# The executable named in the entry's DisplayIcon ("C:\...\ABA Workbench.exe,0").
function Get-InstalledExecutable($entry) {
  return ($entry.DisplayIcon -replace ',\d+$', '').Trim('"')
}

function Get-StartMenuShortcut { Join-Path ([Environment]::GetFolderPath("Programs")) "$ProductName.lnk" }
function Get-DesktopShortcut { Join-Path ([Environment]::GetFolderPath("DesktopDirectory")) "$ProductName.lnk" }

# Every file under the folders, by full path, with its SHA-256.
function Get-Snapshot([string[]]$folders) {
  $files = @{}
  foreach ($folder in $folders) {
    foreach ($file in Get-ChildItem -LiteralPath $folder -Recurse -File -Force) {
      $files[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
  }
  return $files
}

function Wait-Until([scriptblock]$condition, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $condition)) {
    if ((Get-Date) -gt $deadline) { Fail "Timed out after $seconds s waiting for: $what" }
    Start-Sleep -Milliseconds 500
  }
}

# Her cases folder and the app's data folder: what neither an update nor uninstalling may touch.
function Get-HerFolders {
  return @((Join-Path $env:USERPROFILE "ABA Workbench"), (Join-Path $env:APPDATA "ABA Workbench"))
}

# Checks what e2e/windows-installed.e2e.ts left (her first case, her credentials file),
# adds a file of her own to each folder, which no part of the app wrote, and records every
# file in both.
function Get-HerFilesBefore([string]$what) {
  $cases, $appData = Get-HerFolders
  foreach ($expected in @((Join-Path $cases "Invented installer check\aba-case.json"), (Join-Path $appData "credentials.json"))) {
    if (-not (Test-Path -LiteralPath $expected)) { Fail "Missing before $($what): $expected (did the installed-app check run?)" }
  }
  Set-Content -LiteralPath (Join-Path $cases "Invented installer check\her own notes.txt") -Value "Invented notes, written by hand." -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $appData "her own file.txt") -Value "Invented file, written by hand." -Encoding ASCII
  $before = Get-Snapshot (Get-HerFolders)
  Pass "recorded $($before.Count) files in the cases folder and the app's data folder"
  return $before
}

function Assert-HerFilesKept($before, [string]$what) {
  $after = Get-Snapshot (Get-HerFolders)
  foreach ($file in $before.Keys) {
    if (-not $after.ContainsKey($file)) { Fail "$what deleted $file" }
    if ($after[$file] -ne $before[$file]) { Fail "$what changed $file" }
  }
  Pass "after $($what.ToLower()), every one of the $($before.Count) files in the cases folder and the app's data folder is still there, unchanged"
}

# The installed app, its writing rules, and both shortcuts opening it; returns its executable.
function Assert-Installed {
  Wait-Until { $null -ne (Find-UninstallEntry $UserUninstall) } 120 "the uninstall entry in HKEY_CURRENT_USER"
  if ($null -ne (Find-MachineUninstallEntry)) { Fail "An uninstall entry is in HKEY_LOCAL_MACHINE: the install was not per-user." }
  $entry = Find-UninstallEntry $UserUninstall
  Pass "uninstall entry in the user's registry only: '$($entry.DisplayName)', version $($entry.DisplayVersion)"

  $executable = Get-InstalledExecutable $entry
  Wait-Until { Test-Path -LiteralPath $executable } 60 "the installed executable"
  $programs = Join-Path $env:LOCALAPPDATA "Programs"
  if (-not $executable.StartsWith($programs + "\", [StringComparison]::OrdinalIgnoreCase)) { Fail "Installed at $executable, not under $programs." }
  if ((Split-Path -Leaf $executable) -ne "$ProductName.exe") { Fail "The executable is $executable." }
  Pass "installed per user: $executable"
  if ((Get-AuthenticodeSignature -LiteralPath $executable).Status -ne "NotSigned") { Fail "The installed app is signed; it should not be." }
  $rules = Join-Path (Split-Path -Parent $executable) "resources\rules\assessment.md"
  if (-not (Test-Path -LiteralPath $rules)) { Fail "The writing rules are not at $rules." }
  Pass "the writing rules are in the install folder's resources"

  $shell = New-Object -ComObject WScript.Shell
  foreach ($link in @((Get-StartMenuShortcut), (Get-DesktopShortcut))) {
    Wait-Until { Test-Path -LiteralPath $link } 30 "the shortcut $link"
    $target = $shell.CreateShortcut($link).TargetPath
    if ($target -ne $executable) { Fail "The shortcut $link opens $target, not $executable." }
    Pass "shortcut $link opens the app"
  }
  if (Get-Process -Name $ProductName -ErrorAction SilentlyContinue) { Fail "A silent install must not start the app." }
  return $executable
}

# Every process of the app has ended. Electron's crash reporter runs as the same
# executable and can outlive the window by a moment after a test closes the app.
function Wait-AppEnded {
  Wait-Until { -not (Get-Process -Name $ProductName -ErrorAction SilentlyContinue) } 60 "every ABA Workbench process to end"
}

# Runs the installer silently; a per-user install asks for no administrator rights (the
# runner would show no prompt, and the install would fail if it did).
function Invoke-Installer([string]$installer) {
  if (-not $installer -or -not (Test-Path -LiteralPath $installer)) { Fail "No installer at '$installer'." }
  $installer = (Resolve-Path -LiteralPath $installer).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($signature.Status -ne "NotSigned") { Fail "The installer's signature status is $($signature.Status); it should be unsigned (owner's decision)." }
  Pass "the installer is unsigned, as decided"
  Wait-AppEnded
  # The process ends when the install has (an update first runs the installed app's uninstaller and waits for it).
  $process = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru -Wait
  if ($process.ExitCode -ne 0) { Fail "The installer ended with exit code $($process.ExitCode)." }
}

# Run in a new process: a process keeps the folder paths it has already looked up.
function Get-FreshFolderPath([string]$name) {
  return (& powershell.exe -NoProfile -NonInteractive -Command "[Environment]::GetFolderPath('$name')").Trim()
}

switch ($Step) {
  "onedrive" {
    Add-Type -Namespace AbaCheck -Name KnownFolders -MemberDefinition @'
[DllImport("shell32.dll")]
public static extern int SHSetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, [MarshalAs(UnmanagedType.LPWStr)] string pszPath);
'@
    $oneDrive = Join-Path $env:USERPROFILE "OneDrive"
    $folders = @(
      @{ Name = "Documents"; Id = [Guid]"FDD39AD0-238F-46AF-ADB4-6C85480369C7"; Check = "MyDocuments" },
      @{ Name = "Desktop"; Id = [Guid]"B4BFCC3A-DB2C-424C-B029-7FE99A87C641"; Check = "DesktopDirectory" }
    )
    foreach ($folder in $folders) {
      $target = Join-Path $oneDrive $folder.Name
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      $id = $folder.Id
      $result = [AbaCheck.KnownFolders]::SHSetKnownFolderPath([ref]$id, 0, [IntPtr]::Zero, $target)
      if ($result -ne 0) { Fail ("SHSetKnownFolderPath failed for {0}: 0x{1:X8}" -f $folder.Name, $result) }
      $now = Get-FreshFolderPath $folder.Check
      if ($now -ne $target) { Fail "$($folder.Name) is $now, not $target" }
      Pass "$($folder.Name) is now in OneDrive: $now"
    }
  }

  "install" {
    if ($null -ne (Find-UninstallEntry $UserUninstall)) { Fail "The app is already installed." }
    Invoke-Installer $Installer
    $executable = Assert-Installed
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::AppendAllText($env:GITHUB_ENV, "ABA_PACKAGED_EXECUTABLE=$executable`n", $utf8)
  }

  "spanish" {
    Set-WinUserLanguageList -LanguageList (New-WinUserLanguageList "es-ES") -Force
    $first = (Get-WinUserLanguageList)[0].LanguageTag
    if ($first -ne "es-ES") { Fail "Windows' first language is $first, not es-ES." }
    Pass "Windows' first language is $first"
  }

  "reinstall" {
    $entry = Find-UninstallEntry $UserUninstall
    if ($null -eq $entry) { Fail "The app is not installed." }
    $executableBefore = Get-InstalledExecutable $entry
    $before = Get-HerFilesBefore "updating"
    # A file in the install folder, outside her folders: the installed app's uninstaller
    # removes the install folder whole, so it is gone only if that uninstaller ran first.
    $marker = Join-Path (Split-Path -Parent $executableBefore) "update-check.txt"
    Set-Content -LiteralPath $marker -Value "Removed by the installed app's uninstaller." -Encoding ASCII
    Invoke-Installer $Installer
    $executable = Assert-Installed
    if ($executable -ne $executableBefore) { Fail "The update moved the app from $executableBefore to $executable." }
    if (Test-Path -LiteralPath $marker) { Fail "The installer did not run the installed app's uninstaller first: $marker is still there." }
    Pass "the installed app's uninstaller ran first (the install folder was replaced)"
    Assert-HerFilesKept $before "Updating"
  }

  "uninstall" {
    $entry = Find-UninstallEntry $UserUninstall
    if ($null -eq $entry) { Fail "The app is not installed." }
    $executable = Get-InstalledExecutable $entry
    $installFolder = Split-Path -Parent $executable
    $before = Get-HerFilesBefore "uninstalling"

    Wait-AppEnded
    # The uninstaller copies itself elsewhere and starts again from there, so its first
    # process ends at once: wait for what it removes instead.
    $quiet = $entry.QuietUninstallString
    if (-not $quiet) { Fail "The uninstall entry has no QuietUninstallString." }
    $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /s /c `"$quiet`"" -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { Fail "The uninstaller ended with exit code $($process.ExitCode)." }
    Wait-Until { ($null -eq (Find-UninstallEntry $UserUninstall)) -and -not (Test-Path -LiteralPath $executable) } 120 "the uninstaller to finish"

    if (Test-Path -LiteralPath $installFolder) { Fail "The install folder is still there: $installFolder" }
    Pass "the install folder is gone"
    foreach ($link in @((Get-StartMenuShortcut), (Get-DesktopShortcut))) {
      if (Test-Path -LiteralPath $link) { Fail "The shortcut is still there: $link" }
    }
    Pass "the Start menu and Desktop shortcuts are gone"
    Assert-HerFilesKept $before "Uninstalling"
  }
}
