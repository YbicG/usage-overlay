@echo off
cd /d "%~dp0"
if not exist node_modules (call npm install)
start "" /b "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
