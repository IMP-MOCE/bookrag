# Windows installer (Inno Setup)

Скрипт `bookrag-companion.iss` собирает per-user .exe-инсталлер компаньона.

## Локальная сборка

1. Поставить Inno Setup 6.x: <https://jrsoftware.org/isdl.php>.
2. Собрать релизный бинарь:
   ```powershell
   cd ..\..
   go build -ldflags "-X github.com/bookrag/companion/internal/buildinfo.Version=1.0.0" `
     -o bookrag-companion.exe ./cmd/bookrag-companion
   ```
3. Скомпилировать инсталлер:
   ```powershell
   & "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" `
     installer\windows\bookrag-companion.iss /DAppVersion=1.0.0
   ```
   Результат: `dist\windows\bookrag-companion-1.0.0-setup.exe`.

## Подпись (Authenticode)

**Сертификата пока нет** — инсталлер собирается без подписи, Windows
SmartScreen покажет «Не удалось проверить издателя». После получения
сертификата:

```powershell
& "$Env:WindowsSdkDir\bin\10.0.22621.0\x64\signtool.exe" sign `
  /f path\to\cert.pfx /p "password" `
  /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /d "BookRAG Companion" `
  dist\windows\bookrag-companion-1.0.0-setup.exe
```

Подписывать **оба** файла: сначала сам `bookrag-companion.exe` (до того
как Inno его запакует), затем готовый `setup.exe`. Если подписан только
setup.exe, SmartScreen ругнётся уже после распаковки.

CI-pipeline (`.github/workflows/companion-release.yml`) подхватывает
секрет `WINDOWS_SIGN_PFX` (base64) и `WINDOWS_SIGN_PFX_PASSWORD`
из repository secrets; если они не заданы, шаг подписи пропускается.

## Что инсталлер делает

- Ставит в `%APPDATA%\BookRAG Companion\` (per-user, без UAC).
- Кладёт `bookrag-companion.exe`, `icon.ico`, `icon.png`.
- Создаёт ярлык в Start Menu.
- Опционально (чек-бокс) включает автозапуск через
  `--autostart-enable` (пишет `HKCU\…\Run`).
- При деинсталляции снимает автозапуск (`--autostart-disable`) и
  убивает запущенный процесс (`taskkill /F /IM bookrag-companion.exe`).

## Известные ограничения v1

- Нет авто-апдейтера (на v1 — обновление переустановкой поверх).
- Без подписи SmartScreen блокирует первый запуск с предупреждением
  (пользователь должен нажать «Подробнее → Выполнить в любом случае»).
- 64-bit only (`ArchitecturesAllowed=x64compatible`). Под ARM64 пока
  не собираем.
