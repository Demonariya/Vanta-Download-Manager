!macro NSIS_HOOK_POSTINSTALL
  ; Install the unpacked browser extension beside the application uninstaller.
  CreateDirectory "$INSTDIR\Extension"
  IfFileExists "$INSTDIR\resources\extension\manifest.json" 0 +4
    CopyFiles /SILENT "$INSTDIR\resources\extension\*.*" "$INSTDIR\Extension"
    CreateDirectory "$INSTDIR\Extension\icons"
    CopyFiles /SILENT "$INSTDIR\resources\extension\icons\*.*" "$INSTDIR\Extension\icons"

  ; Ensure managed Engine directory layout exists under C:\Program Files\VANTA Download Manager\Engine
  CreateDirectory "$INSTDIR\Engine"
  CreateDirectory "$INSTDIR\Engine\yt-dlp"
  CreateDirectory "$INSTDIR\Engine\spotdl"
  CreateDirectory "$INSTDIR\Engine\ffmpeg"
  CreateDirectory "$INSTDIR\Engine\ffmpeg\bin"

  ; Migrate any side-by-side binaries placed next to vanta.exe by portable/legacy drops into Engine\
  IfFileExists "$INSTDIR\bin\yt-dlp.exe" 0 +2
    CopyFiles /SILENT "$INSTDIR\bin\yt-dlp.exe" "$INSTDIR\Engine\yt-dlp\yt-dlp.exe"
  IfFileExists "$INSTDIR\bin\ffmpeg.exe" 0 +2
    CopyFiles /SILENT "$INSTDIR\bin\ffmpeg.exe" "$INSTDIR\Engine\ffmpeg\bin\ffmpeg.exe"
  IfFileExists "$INSTDIR\bin\ffprobe.exe" 0 +2
    CopyFiles /SILENT "$INSTDIR\bin\ffprobe.exe" "$INSTDIR\Engine\ffmpeg\bin\ffprobe.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove the browser extension shipped with this installation.
  IfFileExists "$INSTDIR\Extension\*.*" 0 +2
    RMDir /r "$INSTDIR\Extension"

  ; Cleanly remove app-managed engines installed under $INSTDIR\Engine
  ; Never remove per-user %APPDATA%\VANTA Download Manager history/settings or external Python installations.
  IfFileExists "$INSTDIR\Engine\*.*" 0 +2
    RMDir /r "$INSTDIR\Engine"
!macroend
