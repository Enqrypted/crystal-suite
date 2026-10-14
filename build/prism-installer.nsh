; Prism.exe can register itself as a web browser (Settings > Make default). Remove that registration
; when Prism is uninstalled (but not when it is being updated).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\RegisteredApplications" "Prism"
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Prism"
    DeleteRegKey HKCU "Software\Classes\PrismURL"
    DeleteRegKey HKCU "Software\Classes\PrismHTML"
  ${endIf}
!macroend
