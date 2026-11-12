; Start at sign-in. The installer sets this rather than the app, so a build run by hand never adds itself,
; the uninstaller removes it, and Windows' Startup apps setting can turn it off. The app's own setting flips that
; same switch, which installing and uninstalling leave alone.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Grove Companion" '"$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Grove Companion"
!macroend
