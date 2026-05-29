# BookRAG

BookRAG - браузерное расширение Manifest V3 для локального анализа длинных
художественных произведений. Расширение извлекает текст главы со страницы
читалки, запускает дообученную локальную модель, проверяет JSON-ответ и ведет
справочник произведения в IndexedDB.

Основная идея проекта: помочь читателю не терять контекст в длинном тексте,
который публикуется по главам. BookRAG сохраняет карточки персонажей, локаций,
артефактов, резюме глав и спорные совпадения, не отправляя текст произведения во
внешние API.

## Что умеет

- Распознает главы на Author.Today, Ficbook и Royal Road.
- Показывает popup для запуска анализа и состояния очереди.
- Загружает и активирует локальные профили модели через страницу менеджера
  моделей.
- Запускает анализ через WebGPU/WebLLM в браузере.
- Делит главу на фрагменты, передает модели компактный `light-KB` контекст и
  получает структурированный JSON.
- Проверяет ответ по JSON Schema, выполняет repair-попытки и не применяет
  невалидный результат к базе данных.
- Выполняет Pass 2 сверку новых сущностей со справочником.
- Хранит справочник в IndexedDB: произведения, главы, запуски анализа,
  персонажей, локации, артефакты, резюме глав, evidence и очередь ручной
  проверки.
- Дает боковую панель для просмотра и редактирования справочника.
- Экспортирует и импортирует справочник в JSON.

## Модели

В пакет расширения входят только код и интерфейс. Веса моделей загружаются после
установки и кэшируются браузером или локальным companion-демоном.

| Профиль | Назначение | model_id | Размер | VRAM |
| --- | --- | --- | --- | --- |
| Легкий | Qwen3.5 2B FTv5 для слабых устройств и проверки сценариев | `bookrag-qwen2b-ftv5-merged-q4f16_1` | ~1.3 ГБ | ~2.2 ГБ |
| Сбалансированный | Qwen3.5 4B FTv6, основной профиль проекта | `bookrag-qwen4b-ftv6-merged-q4f16_1` | ~2.5 ГБ | ~3.9 ГБ |

4B FTv6 используется как основной профиль: он лучше подходит для извлечения
сущностей, создания резюме главы и Pass 2 сверки. 2B FTv5 оставлен как более
легкий вариант.

## Требования

- Chromium-браузер 121+ с поддержкой Manifest V3.
- WebGPU для браузерного инференса. Проверить можно на `chrome://gpu`.
- Node.js для сборки расширения.
- Достаточно свободного места для кэша моделей.

## Быстрый запуск расширения

```bash
cd bookrag
npm install
npm run build
```

После сборки:

1. Открыть `chrome://extensions`.
2. Включить режим разработчика.
3. Нажать "Загрузить распакованное расширение".
4. Выбрать каталог `bookrag/dist`.
5. Открыть страницу поддерживаемого произведения.
6. В popup BookRAG открыть "Менеджер моделей".
7. Запустить диагностику WebGPU, загрузить профиль и сделать его активным.
8. Вернуться на страницу главы и нажать "Анализировать главу".

## Как пользоваться

1. Пользователь открывает главу на поддерживаемом сайте.
2. Content script извлекает название произведения, номер главы, заголовок и
   текст.
3. Popup отправляет задачу в очередь анализа.
4. ChapterAnalyzer делит текст на фрагменты и запускает Pass 1.
5. JsonSchemaValidator проверяет ответ и при необходимости запускает repair.
6. KbReconciler выполняет Pass 2 сверку с уже известными карточками.
7. KnowledgeBase применяет подтвержденные операции к IndexedDB.
8. Side panel показывает персонажей, локации, артефакты, резюме глав и спорные
   совпадения.

## Поддерживаемые сайты

| Сайт | Пример URL |
| --- | --- |
| Author.Today | `https://author.today/reader/...` |
| Ficbook | `https://ficbook.net/readfic/...` |
| Royal Road | `https://www.royalroad.com/fiction/.../chapter/...` |

Парсерная архитектура поддерживает fallback через Readability, но штатный
content script сейчас подключается только к сайтам из `manifest.json`.

## Архитектура

```text
Browser tab
  |
  | content/parse
  v
Content script + PageParser
  |
  | chapters/analyze
  v
Background service worker
  |-- AnalysisQueue
  |-- ChapterAnalyzer
  |-- KbReconciler
  |-- KnowledgeBase -> IndexedDB
  |
  | resolveBackend()
  |-- CompanionBackend -> http://127.0.0.1:8731
  |-- OffscreenBackend -> WebGPU/WebLLM
  |
  v
UI pages: popup, sidepanel, models, options
```

Ключевые ограничения:

- Модель не пишет в IndexedDB напрямую.
- Невалидный JSON не применяется к справочнику.
- Pass 1 использует компактный `light-KB`, чтобы не перегружать контекст.
- Pass 2 отдельно решает, является ли новая сущность новой карточкой или
  совпадением с существующей.
- События и связи как отдельные сущности в FTv6 удалены; вместо них хранится
  `ChapterSummary`, а связи частично отражаются через роль, статус и текст
  резюме.

## Данные

IndexedDB база называется `bookrag`, текущая версия схемы - `4`.

Основные хранилища:

- `works` - произведения;
- `chapters` - главы;
- `analysis_runs` - запуски анализа;
- `characters` - карточки персонажей;
- `locations` - локации;
- `artifacts` - предметы и значимые объекты;
- `chapter_summaries` - резюме глав;
- `evidences` - подтверждающие фрагменты текста;
- `review_items` - очередь ручной проверки коллизий.

Настройки расширения лежат в `chrome.storage.local`, веса WebLLM - в кэше
браузера.

## Разработка

```bash
cd bookrag
npm install
npm run dev
npm test
npm run build
```

Полезные команды:

- `npm run precompile-schema` - сгенерировать standalone JSON Schema validator
  для MV3 service worker;
- `npm run lint` - проверить TypeScript/React код ESLint;
- `npm run test:watch` - запустить Vitest в watch-режиме;

`predev`, `pretest` и `prebuild` автоматически вызывают
`scripts/precompile-schema.mjs`.

## Структура проекта

```text
bookrag/
  manifest.json
  package.json
  schemas/
    analysis-response.schema.json
  scripts/
    precompile-schema.mjs
  src/
    analysis/      # ChapterAnalyzer, prompts, repair, Pass 1/Pass 2 helpers
    background/    # service worker, handlers, queue, offscreen client
    content/       # content script and analyze button
    kb/            # IndexedDB KnowledgeBase, operations, models
    lib/           # id, hash, normalize, levenshtein
    llm/           # profiles, WebLLM, companion/openai-eval backends
    messaging/     # typed chrome.runtime contracts
    offscreen/     # WebGPU/WebLLM host
    parsers/       # PageParser and site adapters
    ui/            # popup, sidepanel, models, options
  tests/
    unit/
  companion/       # optional native daemon
```

## Тесты

В `tests/unit` сейчас 24 файла unit-тестов. Они покрывают:

- парсеры страниц;
- очередь анализа;
- contracts/messaging;
- ChapterAnalyzer и repair-логику;
- JSON Schema validator;
- KbReconciler и prompt-сборку;
- KnowledgeBase;
- CollisionResolver;

Запуск:

```bash
npm test
```

## Безопасность и приватность

- Текст главы анализируется локально.
- Внешний сетевой доступ нужен только для загрузки модельных файлов и
  development/eval-сценариев.
- Companion слушает loopback-адрес `127.0.0.1`.
- Любое изменение справочника проходит через валидацию и KnowledgeBase.
