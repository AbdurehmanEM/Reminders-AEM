@echo off
title Install Reminders - by Abdurehman E Mohammed
echo Installing Reminders (by Abdurehman E Mohammed)...
if not exist "C:\wamp64\www" (
  echo WAMP was not found at C:\wamp64. Install or start WAMP first.
  pause
  exit /b 1
)
robocopy "%~dp0." "C:\wamp64\www\Reminder" /E /NFL /NDL /NJH /NJS /XF INSTALL.bat _headers .nojekyll >nul
echo Files copied to C:\wamp64\www\Reminder
echo.
echo Make sure WAMP is running (green icon), then click Install in Edges address bar.
start "" msedge "http://localhost/Reminder/?v=24"
pause
