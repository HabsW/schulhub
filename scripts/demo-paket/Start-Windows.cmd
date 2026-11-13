@echo off
rem SchulHub-Demo starten (Windows 10/11). Doppelklick genuegt.
rem Startet den lokalen Testmodus und oeffnet den Browser, sobald alles bereit ist.
cd /d "%~dp0"
title SchulHub-Demo
where node >nul 2>nul
if errorlevel 1 goto nonode
echo.
echo   SchulHub-Demo startet ... der Browser oeffnet sich gleich von selbst.
echo   Falls nicht: im Browser http://localhost:3000 eingeben.
echo.
echo   Zum Beenden: dieses Fenster schliessen.
echo.
node src\server.js --dev --open
echo.
pause
exit /b

:nonode
echo.
echo   Node.js ist auf diesem PC nicht installiert (oder der PC wurde nach der
echo   Installation noch nicht neu gestartet).
echo   Bitte die LTS-Version von https://nodejs.org installieren
echo   und danach diese Datei noch einmal doppelt anklicken.
echo.
pause
exit /b 1
