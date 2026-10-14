@echo off
rem Runs Photon straight from this source checkout (development build, no install needed).
rem You can also drag image or PSD files onto this file.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" call npm install
if not exist "dist\photon\index.html" call npm run build
start "" "node_modules\electron\dist\electron.exe" . --photon %*
