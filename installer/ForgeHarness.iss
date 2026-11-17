; ============================================================
;  Forge Harness — Windows installer (native desktop app)
;  Build:  iscc ForgeHarness.iss   (from installer/)
;  Output: installer/Output/ForgeHarness-Setup-0.1.0.exe
;
;  Self-contained native app: Electron shell (branded
;  ForgeHarness.exe) + bundled engine + bundled Node runtime.
;  One window, one taskbar icon — no browser tab required.
;  Installs per-user (no admin required) into LOCALAPPDATA.
; ============================================================

#define AppName "Forge Harness"
#define AppVersion "0.2.0"
#define AppPublisher "Forge Harness"
#define AppId "{{7E3F2B1A-9C4D-4E8A-BF6E-5A1B8D2C6F03}}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\ForgeHarness
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=ForgeHarness-Setup-{#AppVersion}
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110
PrivilegesRequiredOverridesAllowed=dialog
DisableReadyPage=no
; Upgrade path: close a running Forge Harness instance before overwriting files
CloseApplications=force
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: checkedonce

[Files]
; Native desktop app (electron runtime + app payload + bundled engine)
Source: "staging-electron\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\ForgeHarness.exe"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "Your AI infrastructure. Your models. Your rules."
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"; IconFilename: "{app}\icon.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\ForgeHarness.exe"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\ForgeHarness.exe"; Description: "Launch Forge Harness"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

; User data (~/.forge-harness) is NEVER deleted on uninstall.

[Messages]
WelcomeLabel1=Welcome to {#AppName} Setup
WelcomeLabel2=Forge Harness is your own AI infrastructure: connect your own providers and models, create agents, and orchestrate them — with your keys, your data, your rules. Nothing is preloaded or phoned home.%n%nThis installs the native Forge Harness desktop app. Data is stored in your user profile (~/.forge-harness).%n%nClick Install to continue.
