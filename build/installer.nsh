; Crystal Suite downloads its apps into %LOCALAPPDATA%\Crystal Suite and adds shortcuts for them.
; Remove those too when Crystal Suite itself is uninstalled (but not when it is being updated).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\Photon.lnk"
    Delete "$SMPROGRAMS\Photon.lnk"
    Delete "$DESKTOP\Prism.lnk"
    Delete "$SMPROGRAMS\Prism.lnk"
    Delete "$DESKTOP\Cut.lnk"
    Delete "$SMPROGRAMS\Cut.lnk"
    Delete "$DESKTOP\Facet.lnk"
    Delete "$SMPROGRAMS\Facet.lnk"
    ; Facet: starting with Windows, and the Windows desktop icons if Facet hid them
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CrystalSuite.Facet"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CrystalSuite.Facet"
    ${If} ${FileExists} "$APPDATA\Crystal Suite\Facet\icons-hidden"
      FindFirst $0 $1 "$LOCALAPPDATA\Crystal Suite\Apps\facet\*"
      ${DoWhile} $1 != ""
        ${If} ${FileExists} "$LOCALAPPDATA\Crystal Suite\Apps\facet\$1\FacetHelper.exe"
          ExecWait '"$LOCALAPPDATA\Crystal Suite\Apps\facet\$1\FacetHelper.exe" show-icons'
        ${EndIf}
        FindNext $0 $1
      ${Loop}
      FindClose $0
      Delete "$APPDATA\Crystal Suite\Facet\icons-hidden"
    ${EndIf}
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
