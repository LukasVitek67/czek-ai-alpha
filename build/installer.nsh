; Instalátor (npm run dist:setup) si zapamatuje svou složku: czek-ai pak najde složku pro třídu czek-ai-cache
; vedle czek-ai-X.Y.Z-setup.exe (sdílený disk, flashka), i když sama běží z %LOCALAPPDATA%\Programs\czek-ai.
; UTF-16LE s BOM, ať projdou i cesty s diakritikou (src/main.js setupClassDir).
!macro customInstall
  FileOpen $0 "$INSTDIR\setup-dir.txt" w
  FileWriteWord $0 0xFEFF
  FileWriteUTF16LE $0 "$EXEDIR"
  FileClose $0
!macroend
