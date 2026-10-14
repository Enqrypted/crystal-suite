; Crystal Suite downloads its apps into %LOCALAPPDATA%\Crystal Suite and adds shortcuts for them.
; Remove those too when Crystal Suite itself is uninstalled (but not when it is being updated).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\Photon.lnk"
    Delete "$SMPROGRAMS\Photon.lnk"
    RMDir /r "$LOCALAPPDATA\Crystal Suite\Apps"
    Delete "$LOCALAPPDATA\Crystal Suite\installed.json"
    Delete "$LOCALAPPDATA\Crystal Suite\settings.json"
    Delete "$LOCALAPPDATA\Crystal Suite\catalog-cache.json"
    RMDir "$LOCALAPPDATA\Crystal Suite"
  ${endIf}
!macroend
