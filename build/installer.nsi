; Installatore di ideax (NSIS). Lo crea "npm run build:exe".
; - Installa per l'utente corrente, senza permessi di amministratore
; - Icone nel menu Start e sul desktop, voce in "App installate" con disinstallazione
; - /S /UPDATE: modalità silenziosa usata dagli aggiornamenti automatici, alla fine riapre ideax
; I dati dell'utente (modelli, creazioni, motore) stanno in un'altra cartella e non vengono toccati.

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef SRC
  !define SRC "..\dist\ideax"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\dist\ideax-setup.exe"
!endif

!define APP "ideax"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ideax"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\ideax"
InstallDirRegKey HKCU "Software\ideax" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "ideax ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "ideax"
VIAddVersionKey "FileDescription" "Installazione di ideax"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "ideax"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Installa ideax ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "ideax è il tuo studio creativo AI: fa girare sul tuo PC i modelli di immagini, video e animazioni.$\r$\n$\r$\nIl programma si installa per il tuo utente, senza permessi di amministratore. I tuoi modelli e le tue creazioni stanno in una cartella separata e non vengono toccati dagli aggiornamenti.$\r$\n$\r$\nPremi Avanti per continuare."
!define MUI_FINISHPAGE_RUN "$INSTDIR\ideax.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Avvia ideax"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Italian"

; Chiude ideax (e il worker Python, che è un suo processo figlio) prima di sostituire i file
!macro CloseIdeax
  nsExec::Exec 'taskkill /F /T /IM ideax.exe'
  Pop $0
  Sleep 1500
!macroend

Section "ideax" SecMain
  SetShellVarContext current
  !insertmacro CloseIdeax
  SetOutPath "$INSTDIR"

  ; Via i file della versione precedente, così non restano file vecchi
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\worker"
  RMDir /r "$INSTDIR\clients"

  ; Se ideax.exe è ancora in uso riproviamo per qualche secondo
  StrCpy $1 0
  retry:
    ClearErrors
    File "${SRC}\ideax.exe"
    IfErrors 0 copied
    IntOp $1 $1 + 1
    IntCmp $1 10 0 0 copied
    Sleep 1000
    Goto retry
  copied:

  File /r "${SRC}\public"
  File /r "${SRC}\worker"
  File /r "${SRC}\clients"
  File "${SRC}\README.md"
  File "${SRC}\LEGGIMI.txt"

  ; Segnala a ideax che è installato: i dati vanno nella cartella dell'utente, non qui
  FileOpen $0 "$INSTDIR\ideax-installato.txt" w
  FileWrite $0 "ideax ${VERSION}$\r$\n"
  FileClose $0

  WriteUninstaller "$INSTDIR\Disinstalla ideax.exe"
  CreateShortcut "$SMPROGRAMS\ideax.lnk" "$INSTDIR\ideax.exe" "" "$INSTDIR\ideax.exe" 0
  ${IfNot} ${FileExists} "$DESKTOP\ideax.lnk"
    ${GetParameters} $2
    ClearErrors
    ${GetOptions} $2 "/UPDATE" $3
    ; Durante un aggiornamento non ricreiamo l'icona sul desktop se l'utente l'ha cancellata
    IfErrors 0 +2
      CreateShortcut "$DESKTOP\ideax.lnk" "$INSTDIR\ideax.exe" "" "$INSTDIR\ideax.exe" 0
  ${EndIf}

  WriteRegStr HKCU "Software\ideax" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "ideax"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "ideax"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\ideax.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Disinstalla ideax.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Disinstalla ideax.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/ideaeventimessina/ideax"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  ; Aggiornamento automatico (/S /UPDATE): finito, riapriamo ideax
  ${GetParameters} $2
  ClearErrors
  ${GetOptions} $2 "/UPDATE" $3
  IfErrors +2 0
    Exec '"$INSTDIR\ideax.exe"'
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro CloseIdeax

  Delete "$SMPROGRAMS\ideax.lnk"
  Delete "$DESKTOP\ideax.lnk"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\worker"
  RMDir /r "$INSTDIR\clients"
  Delete "$INSTDIR\ideax.exe"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\LEGGIMI.txt"
  Delete "$INSTDIR\ideax-installato.txt"
  Delete "$INSTDIR\Disinstalla ideax.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\ideax"

  ; La cartella dei dati: quella indicata in AppData\ideax\home.txt oppure C:\Users\<tu>\ideax
  StrCpy $4 "$PROFILE\ideax"
  IfFileExists "$APPDATA\ideax\home.txt" 0 askdata
    FileOpen $0 "$APPDATA\ideax\home.txt" r
    FileRead $0 $4
    FileClose $0
  askdata:
  ; Per sicurezza cancelliamo solo una cartella che sia davvero di ideax (con dentro "data")
  IfFileExists "$4\data\*.*" 0 done
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Vuoi eliminare anche i tuoi dati?$\r$\n$\r$\n$4$\r$\n$\r$\nContiene i modelli, le creazioni, le impostazioni e il motore Python. Scegli No per tenerli (potrai reinstallare ideax e ritrovarli)." IDNO done
    RMDir /r "$4"
    RMDir /r "$APPDATA\ideax"
  done:
SectionEnd
