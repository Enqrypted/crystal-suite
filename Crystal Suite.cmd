@echo off
rem Starts the Crystal Suite launcher from source (installs dependencies the first time).
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" call npm install
start "" "node_modules\electron\dist\electron.exe" .
