<#
.SYNOPSIS
  WorkBuddy Skins - replace Windows launch entry points with the skinned launcher.
.DESCRIPTION
  Redirects the two user-level launch entry points to scripts\launch-hidden.vbs
  (which runs apply.ps1 silently), so clicking the normal WorkBuddy icon or
  boot auto-start both yield a CDP-enabled, skinned WorkBuddy. No app files
  are touched; everything is reversible with -Uninstall.

  Covered:
    1. Start Menu shortcut  %APPDATA%\Microsoft\Windows\Start Menu\Programs\WorkBuddy.lnk
    2. Logon auto-start     HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\WorkBuddy.WorkBuddy

  Originals are backed up next to themselves (*.wb-skins-bak / registry value
  WorkBuddy.WorkBuddy.orig) on first run. Idempotent: safe to re-run, e.g.
  after a WorkBuddy upgrade restores the original shortcut.

  Note: taskbar pins are per-user copies; if you pinned WorkBuddy before,
  unpin and re-pin from the Start Menu after running this script.
.EXAMPLE
  .\install-launcher.ps1
  .\install-launcher.ps1 -Uninstall
#>
[CmdletBinding()]
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

. (Join-Path $PSScriptRoot 'common.ps1')

$lnkPath   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WorkBuddy.lnk'
$lnkBackup = "$lnkPath.wb-skins-bak"
$runKey    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName   = 'WorkBuddy.WorkBuddy'
$runBackup = 'WorkBuddy.WorkBuddy.orig'
$vbs       = Join-Path $PSScriptRoot 'launch-hidden.vbs'
$wscript   = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path -LiteralPath $vbs)) { Write-Error "缺少 $vbs"; exit 1 }

if ($Uninstall) {
  if (Test-Path -LiteralPath $lnkBackup) {
    Copy-Item -LiteralPath $lnkBackup -Destination $lnkPath -Force
    Remove-Item -LiteralPath $lnkBackup -Force
    Write-Host "已还原开始菜单快捷方式: $lnkPath"
  } else {
    Write-Host "无快捷方式备份，跳过: $lnkPath"
  }
  $bak = (Get-ItemProperty -Path $runKey -Name $runBackup -ErrorAction SilentlyContinue).$runBackup
  if ($bak) {
    Set-ItemProperty -Path $runKey -Name $runName -Value $bak
    Remove-ItemProperty -Path $runKey -Name $runBackup
    Write-Host "已还原开机启动项: $runName = $bak"
  } else {
    Write-Host "无启动项备份，跳过: $runName"
  }
  exit 0
}

$exe = Find-WorkBuddyExe
if (-not $exe) { Write-Error "未找到 WorkBuddy.exe"; exit 1 }

# --- 1. Start Menu shortcut ------------------------------------------------
if ((Test-Path -LiteralPath $lnkPath) -and -not (Test-Path -LiteralPath $lnkBackup)) {
  Copy-Item -LiteralPath $lnkPath -Destination $lnkBackup
  Write-Host "已备份原快捷方式 -> $lnkBackup"
}
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath = $wscript
$lnk.Arguments = '"' + $vbs + '"'
$lnk.WorkingDirectory = $Root
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'WorkBuddy (skinned launcher)'
$lnk.Save()
Write-Host "开始菜单快捷方式已指向皮肤启动器: $lnkPath"

# --- 2. Logon auto-start ----------------------------------------------------
$cur = (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue).$runName
$bakExists = $null -ne (Get-ItemProperty -Path $runKey -Name $runBackup -ErrorAction SilentlyContinue)
if ($cur -and -not $bakExists -and $cur -notlike '*launch-hidden.vbs*') {
  Set-ItemProperty -Path $runKey -Name $runBackup -Value $cur
  Write-Host "已备份原启动项 -> $runBackup = $cur"
}
Set-ItemProperty -Path $runKey -Name $runName -Value ('"' + $wscript + '" "' + $vbs + '"')
Write-Host "开机启动项已指向皮肤启动器: $runName"

Write-Host ""
Write-Host "完成。点击开始菜单的 WorkBuddy 图标即等同运行 Start.bat（无窗口闪烁）。"
Write-Host "若任务栏固定过旧图标，请取消固定后从开始菜单重新固定。"
Write-Host "WorkBuddy 升级若还原了入口，重跑本脚本即可。还原: .\install-launcher.ps1 -Uninstall"
