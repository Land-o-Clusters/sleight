@echo off
setlocal DisableDelayedExpansion
rem Query account-based Program Files roots first, then absolute PATH entries.
rem The fixed script rejects project-local Node before executing any candidate.
set "SLEIGHT_BIN=%~dp0"
set "SLEIGHT_NODE="
set "NODE_OPTIONS="
set "NODE_PATH="
for /f "delims=" %%N in ('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -Command "([scriptblock]::Create([IO.File]::ReadAllText($env:SLEIGHT_BIN + '..\lib\windows-node.ps1'))).Invoke()"') do set "SLEIGHT_NODE=%%N"
if not defined SLEIGHT_NODE (
  echo sleight: Install Node 24 or later in Program Files or on PATH, outside a project folder. 1>&2
  exit /b 1
)
"%SLEIGHT_NODE%" "%~dp0..\lib\launch.mjs" %*
exit /b %errorlevel%
