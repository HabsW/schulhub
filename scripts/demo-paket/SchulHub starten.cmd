@echo off
rem SchulHub-Demo starten (Windows 10/11, 64 Bit): Doppelklick genuegt.
rem Node.js liegt im Ordner "runtime" bei - nichts installieren, kein Internet noetig.
rem Startet den lokalen Testmodus und oeffnet den Browser. Laeuft die Demo schon, oeffnet
rem ein zweiter Doppelklick nur den Browser.
cd /d "%~dp0"
title SchulHub-Demo
if not exist "runtime\node.exe" goto incomplete
if not exist "src\server.js" goto incomplete
echo.
echo   SchulHub-Demo startet ... der Browser oeffnet sich gleich von selbst.
echo   Falls nicht: im Browser http://localhost:3000 eingeben.
echo.
echo   Dieses Fenster offen lassen, solange du die Demo benutzt.
echo   Zum Beenden: dieses Fenster schliessen.
echo.
"runtime\node.exe" src\server.js --dev --open
if errorlevel 1 (
  echo.
  pause
)
exit /b

:incomplete
echo.
echo   Hier fehlt etwas - die ZIP-Datei ist wohl nicht ganz entpackt.
echo   Bitte: Rechtsklick auf SchulHub-Demo-Windows.zip, "Alle extrahieren ...",
echo   dann im entpackten Ordner "SchulHub starten.cmd" doppelt anklicken.
echo.
pause
exit /b 1
