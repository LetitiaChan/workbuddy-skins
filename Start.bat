@echo off
REM WorkBuddy Skins - Windows double-click entry (recommended)
REM Thin wrapper around scripts\apply.ps1 so behavior stays identical:
REM restart WorkBuddy with CDP port 9223 (skip if already debuggable),
REM then inject the skin. PowerShell is invoked with -ExecutionPolicy Bypass,
REM so no Set-ExecutionPolicy setup is needed for double-click use.
REM
REM Usage:
REM   Start.bat                restore last-used skin (default theme: miku-light)
REM   Start.bat mice-cat       apply a specific theme id
REM   Start.bat install        hijack Start Menu icon + logon autostart so they
REM                            launch the silent skinned launcher instead
REM                            (scripts\install-launcher.ps1; originals backed up)
REM   Start.bat uninstall      restore the original launch entry points
setlocal
set "ROOT=%~dp0"
set "ARG=%~1"

if /i "%ARG%"=="install" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\install-launcher.ps1"
  goto :check
)
if /i "%ARG%"=="uninstall" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\install-launcher.ps1" -Uninstall
  goto :check
)

if defined ARG (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\apply.ps1" -Theme "%ARG%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\apply.ps1"
)

:check
if errorlevel 1 (
  echo.
  echo [workbuddy-skins] command failed. See messages above.
  pause
)
endlocal
