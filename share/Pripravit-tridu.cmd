@echo off
setlocal
title czek-ai - slozka pro tridu
echo.
echo  Pripravi slozku czek-ai-cache vedle czek-ai.exe: vse, co si czek-ai
echo  pri prvnim startu stahuje (Node.js, Git, OpenCode, OmniRoute), asi 3 GB.
echo  Studenti, kteri spusti czek-ai.exe vedle teto slozky (i ze sdileneho disku
echo  nebo z flashky), pak nic nestahuji z internetu.
echo.
echo  Trva asi 15 minut. Prubeh je v okne czek-ai, na konci se ukaze zprava.
echo  Pokud czek-ai prave bezi, nejdriv ji zavri.
echo.
pause
if not exist "%~dp0czek-ai.exe" (
  echo  Vedle tohoto skriptu chybi czek-ai.exe.
  pause
  exit /b 1
)
start "" "%~dp0czek-ai.exe" --priprav-tridu
