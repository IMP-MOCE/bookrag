; Inno Setup script для BookRAG Companion (Windows).
;
; Сборка: ISCC.exe bookrag-companion.iss /DAppVersion=1.0.0
; (или передать переменную через CI: -DAppVersion=$Env:GITHUB_REF_NAME).
;
; Параметры, прокидываемые снаружи:
;   /DAppVersion=<x.y.z>   — версия в Add/Remove Programs и в имени файла.
;   /DSourceBinary=<path>  — путь к bookrag-companion.exe (по умолчанию
;                            ..\..\bookrag-companion.exe).
;   /DOutputDir=<path>     — куда положить .exe-инсталлер (по умолчанию
;                            ..\..\dist\windows).
;
; Подпись — отдельный шаг после сборки .exe инсталлера (см. README.md).

#ifndef AppVersion
  #define AppVersion "0.0.1-dev"
#endif

#ifndef SourceBinary
  #define SourceBinary "..\..\bookrag-companion.exe"
#endif

#ifndef OutputDir
  #define OutputDir "..\..\dist\windows"
#endif

#define AppName       "BookRAG Companion"
#define AppPublisher  "BookRAG"
#define AppId         "{{B5C9D8E0-2F47-4A1B-9C5E-7D3A8F0E4B12}"
; AppId — стабильный GUID, идентифицирует приложение для Add/Remove Programs
; и для апгрейда поверх установленной версии. Менять нельзя.

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={userappdata}\{#AppName}
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=bookrag-companion-{#AppVersion}-setup
SetupIconFile=..\..\assets\icon.ico
UninstallDisplayIcon={app}\bookrag-companion.exe,0
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "autostart"; Description: "Запускать BookRAG Companion при входе в систему"; \
  GroupDescription: "Дополнительно:"; Flags: unchecked

[Files]
Source: "{#SourceBinary}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\assets\icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\assets\icon.png"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\bookrag-companion.exe"; \
  IconFilename: "{app}\icon.ico"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
; После установки даём опцию запустить демон (без --no-tray, чтобы трей
; появился сразу). Чек-бокс по умолчанию включён.
Filename: "{app}\bookrag-companion.exe"; Description: "Запустить {#AppName}"; \
  Flags: nowait postinstall skipifsilent

; Если пользователь поставил галку "Запускать при входе" — регистрируем
; автозапуск через сам бинарь (он пишет нужный ключ в HKCU\…\Run).
Filename: "{app}\bookrag-companion.exe"; Parameters: "--autostart-enable"; \
  Tasks: autostart; Flags: runhidden waituntilterminated

[UninstallRun]
; Перед удалением — снимаем автозапуск и останавливаем компаньон. signalexit
; шлёт CTRL_C_EVENT в консольное приложение; для трей-приложения
; используем taskkill /F как fallback в [UninstallDelete] нельзя — оставляем
; чистый --autostart-disable + ручной taskkill, чтобы файл не был занят при
; удалении.
Filename: "{app}\bookrag-companion.exe"; Parameters: "--autostart-disable"; \
  Flags: runhidden waituntilterminated; RunOnceId: "disableAutostart"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM bookrag-companion.exe"; \
  Flags: runhidden; RunOnceId: "killCompanion"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
