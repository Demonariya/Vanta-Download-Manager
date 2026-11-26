!macro NSIS_HOOK_POSTINSTALL
  ; Keep managed engines under the application install directory.
  CreateDirectory "$INSTDIR\Engine"
  CreateDirectory "$INSTDIR\Engine\yt-dlp"
  CreateDirectory "$INSTDIR\Engine\spotdl"
  CreateDirectory "$INSTDIR\Engine\ffmpeg"
  CreateDirectory "$INSTDIR\Engine\ffmpeg\bin"

  IfFileExists "$INSTDIR\bin\yt-dlp.exe" 0 +2
    CopyFiles /SILENT "$INSTDIR\bin\yt-dlp.exe" "$INSTDIR\Engine\yt-dlp\yt-dlp.exe"
  IfFileExists "$INSTDIR\bin\ffmpeg.exe" 0 +2
    CopyFiles /SILENT "$INSTDIR\bin\ffmpeg.exe" "$INSTDIR\Engine\ffmpeg\bin\ffmpeg.exe"
  IfFileExists "$INSTDIR\bin\ffprobe.exe" 0 +2
    CopyFiles /SILENT "$INSTDIR\bin\ffprobe.exe" "$INSTDIR\Engine\ffmpeg\bin\ffprobe.exe"

  ; Install the browser extension beside the application and uninstaller.
  IfFileExists "$INSTDIR\resources\extension\manifest.json" 0 extension_files_done
    CreateDirectory "$INSTDIR\Extension"
    CopyFiles /SILENT "$INSTDIR\resources\extension\*.*" "$INSTDIR\Extension"
    CreateDirectory "$INSTDIR\Extension\icons"
    IfFileExists "$INSTDIR\resources\extension\icons\icon.png" 0 extension_files_done
      CopyFiles /SILENT "$INSTDIR\resources\extension\icons\icon.png" "$INSTDIR\Extension\icons\icon.png"
  extension_files_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  IfFileExists "$INSTDIR\Engine\*.*" 0 +2
    RMDir /r "$INSTDIR\Engine"
  IfFileExists "$INSTDIR\Extension\*.*" 0 +2
    RMDir /r "$INSTDIR\Extension"
!macroend