# Linux installer (AppImage)

`build-appimage.sh` собирает самодостаточный `.AppImage`, который
работает на любом дистрибутиве с современным glibc и не требует root.

## Локальная сборка

```bash
cd bookrag/companion
./installer/linux/build-appimage.sh 1.0.0
# → dist/linux/BookRAG_Companion-1.0.0-x86_64.AppImage
```

Скрипт сам скачает `appimagetool` (один раз, в
`$XDG_CACHE_HOME/bookrag-companion`).

Запуск:

```bash
chmod +x BookRAG_Companion-1.0.0-x86_64.AppImage
./BookRAG_Companion-1.0.0-x86_64.AppImage
# или с флагами:
./BookRAG_Companion-1.0.0-x86_64.AppImage --no-tray --addr 127.0.0.1:8731
```

Регистрация в desktop-меню — отдельным шагом через `AppImageLauncher`
(если установлен) или вручную: положить `.AppImage` куда удобно,
скопировать иконку и .desktop из AppDir в `~/.local/share/applications/`.

## Подпись

В v1 не подписываем. AppImage поддерживает GPG-подпись через
`appimagetool --sign --sign-key <KEY-ID>`; добавим, когда появится
проектный GPG-ключ. Без подписи AppImage всё равно запускается — это
не Authenticode, ОС не блокирует.

## Содержимое AppDir/

- `AppRun` — shell-обёртка, точка входа AppImage.
- `bookrag-companion.desktop` — стандартный .desktop файл (не путать
  с XDG autostart entry — этот для desktop-меню/launcher'ов).
- `bookrag-companion.png` — копия `assets/icon.png` (имя без
  расширения совпадает с `Icon=` в .desktop).
- `usr/bin/bookrag-companion` — собранный бинарь.

## Что AppImage НЕ делает

- Не регистрирует автозапуск (запускается вручную или через
  AppImageLauncher). Если нужен autostart, после первого запуска
  выполнить:
  ```bash
  ./BookRAG_Companion-*.AppImage --autostart-enable
  ```
  (бинарь сам положит .desktop в `~/.config/autostart/`,
  указывающий на текущий путь AppImage).
- Не использует CUDA внутри: компаньон спавнит `llama-server` как
  sidecar; CUDA нужна именно ему, не AppImage'у. AppImage самого
  компаньона работает на любом GPU/без GPU (`llama-server` —
  отдельная зависимость, см. README верхнего уровня).
