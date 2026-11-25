!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT_NAME "MintPy"
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "6.0.0"
!endif
!define PRODUCT_PUBLISHER "Dasert"
!define PRODUCT_WEB_SITE "https://github.com/dasert45t15/MintPy"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\MintPy-Native.exe"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

; General Settings
Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "..\releases\MintPy-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\MintPy"
InstallDirRegKey HKCU "${PRODUCT_DIR_REGKEY}" ""
ShowInstDetails show
ShowUnInstDetails show
RequestExecutionLevel user

; Modern UI Appearance
!define MUI_ICON "..\assets\app-icon.ico"
!define MUI_UNICON "..\assets\app-icon.ico"
!define MUI_ABORTWARNING

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\MintPy-Native.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить MintPy"
!insertmacro MUI_PAGE_FINISH

; Uninstaller Pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Languages
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite try

  ; Close running MintPy instance before installing
  nsExec::Exec 'taskkill /F /IM MintPy-Native.exe /T'

  ; Core Binaries & Metadata
  File "..\releases\MintPy-Native.exe"
  File "..\releases\WebView2Loader.dll"
  File "..\package.json"
  File "..\LICENSE"
  File "..\README.md"

  ; Shared JS Modules
  SetOutPath "$INSTDIR\shared"
  File /r "..\shared\*.*"

  ; Desktop Assets (exclude mobile-only portrait wallpapers to keep desktop install compact)
  SetOutPath "$INSTDIR\assets"
  File /r /x "mobile" "..\assets\*.*"

  ; Desktop Web UI (HTML, modular CSS, JS)
  SetOutPath "$INSTDIR\src"
  File /r "..\src\*.*"

  ; Shortcuts
  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\MintPy"
  CreateShortcut "$SMPROGRAMS\MintPy\MintPy.lnk" "$INSTDIR\MintPy-Native.exe" "" "$INSTDIR\assets\app-icon.ico" 0
  CreateShortcut "$SMPROGRAMS\MintPy\Удалить MintPy.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\MintPy.lnk" "$INSTDIR\MintPy-Native.exe" "" "$INSTDIR\assets\app-icon.ico" 0

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Registry for App Paths
  WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "" "$INSTDIR\MintPy-Native.exe"

  ; Registry for Add/Remove Programs
  WriteRegStr HKCU "${PRODUCT_UNINST_KEY}" "DisplayName" "MintPy Zen Audio Player"
  WriteRegStr HKCU "${PRODUCT_UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${PRODUCT_UNINST_KEY}" "DisplayIcon" "$INSTDIR\MintPy-Native.exe,0"
  WriteRegStr HKCU "${PRODUCT_UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${PRODUCT_UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr HKCU "${PRODUCT_UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${PRODUCT_UNINST_KEY}" "InstallLocation" "$INSTDIR"
SectionEnd

Section Uninstall
  nsExec::Exec 'taskkill /F /IM MintPy-Native.exe /T'

  Delete "$DESKTOP\MintPy.lnk"
  Delete "$SMPROGRAMS\MintPy\MintPy.lnk"
  Delete "$SMPROGRAMS\MintPy\Удалить MintPy.lnk"
  RMDir "$SMPROGRAMS\MintPy"

  RMDir /r "$INSTDIR\shared"
  RMDir /r "$INSTDIR\assets"
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\src_mobile"
  Delete "$INSTDIR\MintPy-Native.exe"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${PRODUCT_UNINST_KEY}"
  DeleteRegKey HKCU "${PRODUCT_DIR_REGKEY}"
SectionEnd
