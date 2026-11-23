@echo off
setlocal
title czek-ai - instalace soucasti
echo.
echo  czek-ai potrebuje tri veci: Node.js, OpenCode a OmniRoute.
echo  Tento skript je nainstaluje (asi 3 GB na disku, 5-15 minut). Nic jineho nemeni.
echo.
pause

where node >nul 2>nul
if errorlevel 1 (
  echo [1/4] Instaluji Node.js LTS pres winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo  Node.js se nepodarilo nainstalovat automaticky.
    echo  Stahni ho z https://nodejs.org ^(verze 24 LTS^), nainstaluj a spust tento skript znovu.
    pause
    exit /b 1
  )
  echo.
  echo  Node.js je nainstalovany. ZAVRI toto okno a spust Instalace.cmd ZNOVU,
  echo  aby se nacetla nova cesta k programu node.
  pause
  exit /b 0
) else (
  echo [1/4] Node.js uz je nainstalovany:
  node --version
)

where git >nul 2>nul
if errorlevel 1 (
  echo [2/4] Instaluji Git ^(agent pouziva Git Bash pro prikazy^)...
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
) else (
  echo [2/4] Git uz je nainstalovany.
)

echo [3/4] Instaluji OpenCode ^(agent; czek-ai.exe si ho jinak stahne sama^)...
call npm install -g opencode-ai@1.19.5
if errorlevel 1 goto :fail

echo [4/4] Instaluji OmniRoute ^(smerovani modelu, asi 2,6 GB na disku^)...
call npm install -g omniroute@3.8.53
if errorlevel 1 goto :fail

echo.
echo  Hotovo. Ted spust czek-ai.exe.
echo  Prvni start trva asi minutu ^(nabiha OmniRoute^).
echo  Klice k modelum pridas v aplikaci: tlacitko "Klice" nebo Ctrl+carka.
echo.
pause
exit /b 0

:fail
echo.
echo  Instalace selhala. Zkontroluj pripojeni k internetu a spust skript znovu.
pause
exit /b 1
