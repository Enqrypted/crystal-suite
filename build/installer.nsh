; Crystal Suite downloads its apps into %LOCALAPPDATA%\Crystal Suite and adds shortcuts for them.
; Remove those too when Crystal Suite itself is uninstalled (but not when it is being updated).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\Photon.lnk"
    Delete "$SMPROGRAMS\Photon.lnk"
    Delete "$DESKTOP\Prism.lnk"
    Delete "$SMPROGRAMS\Prism.lnk"
    ; Prism's registration as a web browser (Settings > Default apps)
    DeleteRegValue HKCU "Software\RegisteredApplications" "Prism"
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Prism"
    DeleteRegKey HKCU "Software\Classes\PrismURL"
    DeleteRegKey HKCU "Software\Classes\PrismHTML"
    RMDir /r "$LOCALAPPDATA\Crystal Suite\Apps"
    Delete "$LOCALAPPDATA\Crystal Suite\installed.json"
    Delete "$LOCALAPPDATA\Crystal Suite\settings.json"
    Delete "$LOCALAPPDATA\Crystal Suite\catalog-cache.json"
    RMDir "$LOCALAPPDATA\Crystal Suite"
  ${endIf}
!macroend
