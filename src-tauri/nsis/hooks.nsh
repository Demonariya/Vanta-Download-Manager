; VANTA dark installer theme. Tauri's bundled NSIS template expands page macros
; after loading installer hooks, so these definitions theme the stock installer UI.
!define MUI_BGCOLOR "171A21"
!define MUI_TEXTCOLOR "E7ECF4"
!define MUI_DIRECTORYPAGE_BGCOLOR "202631"
; Avoid MUI_STARTMENUPAGE_BGCOLOR: upstream NSIS MUI2 references a misspelled
; control variable (mui.StartMenuMenu.FolderList), which triggers warning 6000.
!define MUI_INSTALLCOLORS "42B8E8 171A21"
!define MUI_INSTFILESPAGE_COLORS "DCE6F2 171A21"
!define MUI_WELCOMEPAGE_TITLE "Welcome to VANTA"
!define MUI_WELCOMEPAGE_TEXT "A focused download workspace for video and music. Install VANTA to manage downloads with smart resume, batch queues, media metadata and browser capture."
!define MUI_FINISHPAGE_TITLE "VANTA is ready"
!define MUI_FINISHPAGE_TEXT "Installation completed successfully. Launch VANTA Download Manager and start managing your video and music downloads."

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