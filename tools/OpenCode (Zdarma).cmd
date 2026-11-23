@echo off
rem Spusti czek-ai proxy (pokud jeste nebezi) a potom OpenCode.
rem Bez argumentu otevre OpenCode ve slozce "Documents\Claude code", jinak v zadane slozce.
setlocal
set PORT=4545
set APP=%~dp0czek-ai.exe
if not exist "%APP%" set APP=%~dp0Zdarma.exe

curl -s -m 2 http://127.0.0.1:%PORT%/health >nul 2>&1
if not errorlevel 1 goto ready

if not exist "%APP%" (
  echo Nenasel jsem "%~dp0czek-ai.exe". Dej tenhle soubor vedle czek-ai.exe.
  pause
  exit /b 1
)
echo Startuji czek-ai proxy...
start "" "%APP%" --proxy --port=%PORT%
for /l %%i in (1,1,40) do (
  curl -s -m 1 http://127.0.0.1:%PORT%/health >nul 2>&1 && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo czek-ai proxy se nespustila na portu %PORT%.
pause
exit /b 1

:ready
if "%~1"=="" (
  cd /d "%USERPROFILE%\Documents\Claude code"
  opencode
) else (
  opencode %*
)
