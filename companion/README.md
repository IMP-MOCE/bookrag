# BookRAG Companion

Локальный демон-ускоритель для расширения BookRAG. Запускает дообученную
модель нативно (llama.cpp, CUDA) и отдаёт инференс расширению по loopback
HTTP — скорость уровня LM Studio вместо ~3.5x-медленного in-browser WebGPU.
Если компаньона нет, расширение прозрачно работает на встроенном WebLLM.

Архитектура и план — в плане проекта (`fluffy-weaving-biscuit.md`).

## Статус

**M1** — скелет демона: loopback HTTP, `GET /health`, middleware
(loopback + Origin allowlist), graceful shutdown.

**M2** — sidecar llama-server: менеджер дочернего процесса (ленивый
spawn, ожидание готовности, idle-авто-выгрузка из VRAM, Stop),
`POST /load` / `POST /unload`, состояние в `/health`, резолвер URL
официального CUDA-релиза (запинен `ReleaseTag`). Runner/clock
инъектируемы — логика тестируется без бинаря, GPU и сети.

**M3** — `POST /generate`: прокси в OpenAI-совместимый
`/v1/chat/completions` дочернего llama-server. JSON-по-схеме —
нативным `response_format: json_schema` (llama.cpp сам строит
GBNF). SSE-стрим проксируется сквозь. Маппинг контракта BookRAG с
паритетом дефолтов WebLLM-пути (temp 0.1, top_p 0.9, freq 0.4,
presence 0.3, max_tokens 2048, thinking off). Плюс `GET /model/status`
и warmup-хук менеджера (1-токенный прогон после готовности).

**M4** — загрузчик GGUF с Hugging Face: `resolve`-URL, возобновляемое
скачивание (HTTP Range), проверка sha256, идемпотентный `EnsureLocal`
(готовый файл не перекачивается, `.part` докачивается). Прогресс —
в `GET /model/status` (`download: {phase,done,total}`). Перед стартом
llama модель гарантированно скачивается (декоратор контроллера).

**M5** — системный трей (fyne.io/systray) и регистрация автозапуска.
Трей показывает статус компаньона в подсказке (idle/downloading/loading/
ready/error), пункт меню "Quit" корректно останавливает демон. По
умолчанию трей включён, если есть графическая сессия ($DISPLAY /
$WAYLAND_DISPLAY на Linux); флаг `--no-tray` принудительно headless.
Автозапуск: `--autostart-enable` / `--autostart-disable` /
`--autostart-status`. Windows — per-user `HKCU\…\Run`; Linux — XDG
autostart `.desktop` в `$XDG_CONFIG_HOME/autostart/`.

**M6** — extension-side `CompanionBackend` (HTTP-клиент `LlmBackend`),
ветка в `resolveBackend()` с health-probe → companion / fallback offscreen,
ключи настроек `bookrag.inferenceBackend` (`auto`|`browser`) и
`bookrag.companionEndpoint`, `manifest.json` host_permissions += loopback.

**M7** — установщики и иконка-ассет. Иконка генерируется детерминированно
(`cmd/gen-icon` → `assets/icon.png` + `assets/icon.ico` multi-res),
эмбедится в бинарь (`assets/embed.go`) и используется одной и той же
в трее, Inno-инсталлере и AppImage. Установщики:
[installer/windows](installer/windows/README.md) — Inno Setup .exe
(per-user, опц. автозапуск через checkbox, signtool-placeholder);
[installer/linux](installer/linux/README.md) — AppImage
(`build-appimage.sh`, без root). CI:
`.github/workflows/companion-release.yml` собирает оба артефакта по
тегу `companion-v*` и выкладывает в GitHub Release (draft). Authenticode
подпись пропускается, пока не задан секрет `WINDOWS_SIGN_PFX`.

Запуск с готовым локальным GGUF:
`go run ./cmd/bookrag-companion --llama-bin <path> --model <gguf> --idle 5m`

Запуск со скачиванием с HF при первом старте:
`go run ./cmd/bookrag-companion --llama-bin <path> \
  --hf-repo org/bookrag-4b-gguf --hf-file bookrag-4b-q4_k_m.gguf \
  --model-sha256 <hex> --data-dir data`

Без `--llama-bin` и без модели — режим M1 (`/load`,`/unload` → 503).

Headless (без трея):
`go run ./cmd/bookrag-companion --no-tray --addr 127.0.0.1:8731`

Регистрация автозапуска (после сборки релизного бинаря):
`bookrag-companion --autostart-enable`
`bookrag-companion --autostart-status`
`bookrag-companion --autostart-disable`

## Сборка и тесты

Требуется Go (см. `go.mod`).

```sh
cd companion
go build ./...
go test ./...
go run ./cmd/bookrag-companion --addr 127.0.0.1:8731
```

Версия в релизе:
`go build -ldflags "-X github.com/bookrag/companion/internal/buildinfo.Version=v0.1.0" ./cmd/bookrag-companion`

## Безопасность

- Сервер биндится строго на `127.0.0.1` (+ middleware-проверка loopback).
- `--allowed-origins` — список `chrome-extension://<id>`. Пустой = dev-режим
  без проверки Origin (логируется предупреждение). В проде обязателен.
