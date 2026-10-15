# PianoMotion Studio: дорожная карта разработки

Дата: 2026-10-13.

Статус на 2026-10-13: M0 baseline принят; код M1–M5 реализован, после независимого обзора выполняется стабилизация интеграции. Численный parity 13 fixtures подтверждён; новый review выявил и исправляет editor replan/ID/history, profile application, seek и durable recovery. M6 содержит отдельные добавленные модули. Полная приёмка player остаётся ограниченной: motion использует редкие диагностические samples, W020 и визуальные касания не подтверждены, weak-device/memory/audio latency неизвестны. Текущие результаты и handoff: `web/docs/evidence/stabilization-2026-10-13.md`, `web/docs/HANDOFF.md`; исторические milestone reports не заменяют новые проверки.

## 1. Цель и границы

Создать браузерную Hand-thesia, которая локально импортирует MIDI/PIG, рассчитывает аппликатуру и движение рук, воспроизводит результат, позволяет редактировать его и сохранять проекты. Затем перенести профили пианистов, скины, синхронизацию аудиозаписей, пользовательские SoundFont и экспорт видео.

Основной стек: React + TypeScript + Vite; Radix UI для DOM-интерфейса; PixiJS для сцены; Web Audio API для звука; Pyodide в module Web Worker для Python-ядра; IndexedDB и OPFS для данных; статический HTTPS-хостинг и PWA.

Предположения для планирования:

- Первый целевой пользователь — один человек за desktop-браузером, без аккаунта и обязательной загрузки файлов на сервер.
- Первая целевая среда — Chrome/Edge на Windows; Firefox и Safari входят в последующую браузерную приёмку. Телефонный редактор и live MIDI input не входят в первый MVP.
- MVP использует встроенный набор семплов и скелетный вид рук. Произвольные SF2/SF3, другие скины и видео входят в последующие этапы.
- Сохранение существующего поведения важнее полного переписывания алгоритмов на TypeScript.
- Публичный выпуск зависит от установления условий использования исходного кода и распространяемых ресурсов: общего LICENSE в проверенном checkout не найдено.
- Облачная синхронизация, аккаунты и совместное редактирование — отдельное расширение; их отсутствие не блокирует локальную версию.

При создании roadmap были подготовлены только план и `web/README.md`. Затем пользователь назначил основного агента оркестратором и поручил работу subagents GPT-6 Luna Extra High: начато выполнение M0 в отдельной папке `web/`. Commit, push и deployment не выполняются; desktop-ядро не изменяется.

## 2. Расположение нового проекта и защита исходников

Веб-проект размещается в самостоятельном репозитории `C:\Projects\pianomotion-studio`. Прежний каталог `C:\Projects\pygame-piano-animator` остаётся отдельным десктопным проектом с собственной `.venv`.

До подтверждения паритета корневые Python-модули, тесты, `version.py`, `CHANGELOG.md`, пользовательские `pianists/` и внешние MIDI/аудио остаются эталоном и не изменяются работами по веб-переносу. Изменения desktop требуют отдельной явно определённой задачи.

Структура проекта (M0 создал bootstrap, contracts, fixtures/tools и evidence; engine/Pyodide/audio/storage остаются следующими этапами):

```text
web/
  README.md
  package.json                    # npm workspaces; точные версии фиксируются при bootstrap
  package-lock.json
  apps/client/
    src/app/                      # React, экраны, команды пользователя
    src/workers/                  # Pyodide bridge, задачи, отмена
    src/render/                   # PixiJS, камера, hit testing
    src/audio/                    # транспорт, события, семплер
    src/storage/                  # IndexedDB, OPFS, import/export
    public/                       # выбранные лицензированные ресурсы
  packages/contracts/             # DTO, схемы, стабильные ID, ошибки
  packages/engine/                # чистая TS-логика транспорта/запросов по времени
  python-core/
    provenance.json               # source SHA, версии, список адаптированных модулей
    handthesia_core/              # вычислительный Python без desktop UI
  tests/fixtures/                 # собственные MIDI и ожидаемые результаты
  tests/unit/
  tests/browser/
  tools/                          # упаковка ядра и генерация эталонов
  docs/adr/                       # принятые архитектурные решения
  docs/evidence/                  # отчёты проверок без пользовательских медиа
```

На переходном этапе `python-core` — контролируемая адаптация desktop-ядра с provenance и сравнительными тестами. Изменение desktop-эталона требует проверки diff модулей и осознанного обновления эталонов. Окончательный выбор общего Python-пакета для desktop/web делается после стабилизации; постоянная ручная синхронизация двух расходящихся реализаций не является целевой архитектурой.

## 3. Архитектурные инварианты

1. Исходная музыка и фактическое исполнение различаются. Звук, подсветка и руки используют один `PerformancePlan`, включая поздние удары, ранние отпускания и разложенные аккорды.
2. AudioContext определяет время воспроизведения. PixiJS читает позицию транспорта; число кадров не определяет музыкальное время.
3. React управляет экранами и действиями, а графический движок обновляет сцену без React state на каждом кадре.
4. Планировщик работает вне UI-потока. Длительные операции имеют прогресс, отмену, лимиты и понятную ошибку.
5. Параметры пианиста передаются явно. Глобальные `fingering.W`, `MAX_SPEED`, `figures.PREFS` и активный профиль не должны смешивать независимые задания.
6. У каждой ноты стабильный `noteId`; `id(note)` не пересекает границу Python/JavaScript.
7. Исходные MIDI-байты сохраняются. Экспорт аппликатуры не должен молча удалять темповые/служебные события и метаданные.
8. Любой результат вычисления связан с ревизией проекта. Устаревшее задание не меняет более новую редакцию.
9. Размер кеша движения ограничен горизонтом воспроизведения. Весь фильм из поз не хранится в памяти заранее.
10. Браузерное хранилище дополняется экспортируемой резервной копией; оно не обещает бессрочного сохранения.

## 4. Контракты данных и выполнения

| Контракт | Содержимое и требования |
|---|---|
| `SongDocument` | `schemaVersion`, `projectId`, `revision`, ресурсы, треки, ноты, tempo map, педали и исходные маркеры. Единицы времени и порядок одинаковых timestamps определены явно. |
| `Note` | `noteId`, исходный track/channel/event mapping, pitch, velocity, start/end, hand, finger, glissando. ID не выводится только из pitch/time: совпадающие ноты допустимы. |
| `PianistProfile` | anatomy, behavior, model, weights, skin, schemaVersion; заполнение старых полей значениями по умолчанию. |
| `FingeringPlan` | привязки hand/finger по noteId, diagnostics, engineVersion, inputRevision и параметры расчёта. |
| `PerformancePlan` | фактические press/release и события педалей; ссылки на исходные ноты; сортировка событий и повторные удары. |
| `MotionPlan` | подготовленные эпизоды и/или ограниченные блоки числовых поз; единицы, направление осей, зеркалирование и порядок слоёв. |
| `ProjectPackage` | manifest, version, профили, edits, результаты с hash входа, оригинальные файлы/список внешних ресурсов. Проверка размера и версии при импорте. |
| `EngineRequest` | requestId, projectId, revision, type, payload, engineVersion; отмена по requestId. |
| `EngineResponse` | progress/result/error/cancelled, requestId, revision; типизированная ошибка и diagnostics. |

Идентификатор задачи и ревизия обязательны как для Worker, так и для возможного FastAPI. JSON подходит для документов и диагностики; крупные числовые блоки передаются как TypedArray/ArrayBuffer с контролируемым владением. SharedArrayBuffer не является обязательной зависимостью MVP.

При изменении аппликатуры или профиля редактор сохраняет новую ревизию, отменяет устаревшую задачу и перестраивает исполнение. Начальная реализация может пересчитывать весь проект; локальный пересчёт разрешается после доказательства корректности зависимостей и кешей.

## 5. Этапы и обязательные ворота

Исходный статус задач — «не начато»; фактический прогресс и приёмка фиксируются в `web/docs/ORCHESTRATION.md`. Завершение означает наличие результата и перечисленных свидетельств, а не только написанный код.

### M0 — baseline, контракты и рабочая структура

Зависимости: нет. Цель: получить проверяемый desktop-эталон и подготовить изолированную разработку.

| ID | Работа | Результат / проверка |
|---|---|---|
| W001 | Зафиксировать исходный SHA, версии Python/пакетов и состояние checkout | Воспроизводимый baseline manifest; отсутствие изменений пользовательских данных |
| W002 | Создать npm workspace, Vite/React/TS, lint/typecheck/build, Vitest и Playwright | Минимальный клиент собирается; выбранные версии записаны в lockfile |
| W003 | Определить контракты из раздела 4 и правила времени | ADR-001 и схемы; ошибки валидации покрыты тестами |
| W004 | Запустить desktop pytest в изолированном тестовом окружении | Точные passed/failed/skipped, ошибки и причины; результаты не считаются заранее зелёными |
| W005 | Создать набор собственных fixtures и desktop golden outputs | Ноты, педали, аппликатура, performance events, выбранные позы; provenance входов |
| W006 | Проверить условия распространения кода, семплов, шрифта и выбранных пакетов | Реестр источников/лицензий; unresolved items указаны явно |
| W007 | Зафиксировать целевые устройства, браузеры и размеры тестовых проектов | Performance profile; утверждённые лимиты вместо произвольных обещаний |

Состав fixtures: три tracked MIDI, синтетические гаммы/аккорды, повторные одинаковые ноты, tempo changes, overlapping notes, педали 64/66/67, ручная аппликатура, глиссандо, широкие аккорды, crossings, пустой/повреждённый MIDI, несовпадающие track labels. Большой stress MIDI генерируется из собственного материала. PIG и чужие коллекции не считаются доступными и не распространяются.

Gate G0: baseline сохранён, известные сбои записаны, контракты описаны, public-release licensing blockers установлены. Неизвестные падения эталона исследуются до генерации доверенных golden outputs.

### M1 — проверка Python-ядра в браузере

Зависимости: W003–W005. Цель: доказать основной архитектурный выбор до переноса большого UI.

| ID | Работа | Результат / проверка |
|---|---|---|
| W008 | Выделить вычислительные модули в `python-core`, записать provenance | Список source/adaptation diff; desktop не изменён |
| W009 | Заменить зависимость `_chord_fits` от pygame на числовую KeyboardGeometry | Паритет координат/достижимости для realistic/equal клавиш |
| W010 | Добавить явный контекст профиля и стабильные noteId | Последовательные задачи с разными профилями не влияют друг на друга |
| W011 | Реализовать module Worker, загрузку Pyodide/NumPy/pretty_midi/mido и виртуальную ФС | Импорт всех нужных пакетов проверен в реальном браузере; отсутствие native process/thread зависимости |
| W012 | Выполнить полный расчёт: import → split → fingering → performance → selected poses | Сравнение с golden fixtures, включая Python/JS сериализацию |
| W013 | Добавить progress, errors, revision filtering и cancel | Устаревший ответ отбрасывается; terminate/recreate Worker работает |
| W014 | Измерить cold/warm start, время расчёта, память и пакетный обмен позами | Отчёт на целевом ПК и более слабом устройстве с версиями браузеров |

Загрузка пакета в Pyodide и полноценное выполнение его нужных методов — разные проверки. `pretty_midi` не используется для realtime синтеза в этом этапе. Виртуальная ФС служит адаптером импорта/экспорта, а не долговременным пользовательским хранилищем.

Gate G1 — архитектурное решение:

- Продолжить с Pyodide, если алгоритмы исполняются корректно, UI остаётся отзывчивым, а лимиты G0 достижимы.
- При неприемлемом cold start исследовать lazy loading и кеш; при дорогом расчёте — выделить проблемный участок и повторно измерить.
- При неустранимом провале использовать FastAPI через тот же engine contract. Файлы отправляются только после явного выбора серверного режима; приложение объясняет пользователю место обработки.
- Покадровый runtime переносить на TypeScript только после профилирования. Полное переписывание ядра не является автоматическим следующим шагом.

### M2 — вертикальный браузерный MVP

Зависимости: G1. Цель: один полный пользовательский сценарий от файла до сохранённого воспроизведения.

| ID | Работа | Результат / проверка |
|---|---|---|
| W015 | Реализовать file input/drag-and-drop, проверку размера и ошибок | Импорт tracked MIDI, повреждённого и пустого файла |
| W016 | Нарисовать 88 клавиш и падающие ноты в PixiJS | Геометрия соответствует контракту; работают resize и culling |
| W017 | Нарисовать скелетные руки, номера пальцев и crossing layers | Выбранные позы совпадают с эталоном; касания и слои проверены визуально |
| W018 | Создать транспорт play/pause/seek/speed/volume | AudioContext master clock; безопасное отключение/перезапуск звучащих нот |
| W019 | Создать Web Audio семплер со встроенными ресурсами | Звук следует PerformancePlan; sustain, sostenuto, soft, repeated notes |
| W020 | Подготовить ограниченный lookahead-буфер движения и событий | Нет per-frame RPC; seek инвалидирует старый буфер |
| W021 | Сохранить/открыть MVP-проект в IndexedDB и скачать backup | Перезапуск страницы не теряет выбранный проект |
| W022 | Выполнить end-to-end проверку MVP и записать ограничения | Реальный браузер, включённый звук, ручная проверка и автоматизированные сценарии |

MVP включает player и импорт встроенной/файловой аппликатуры. Полноценного редактора, произвольного SF2/SF3, synced recordings, других скинов, экспорта видео и облака в этом gate нет. Поддержка PIG может быть завершена в M3, если нужна дополнительная адаптация импорта.

Gate G2: import → расчёт → видимые руки → слышимое исполнение → seek/pause → сохранение → повторное открытие проходит; статус ограниченного MVP явно указан. Упрощённые руки без подтверждённого соответствия исполнению gate не закрывают.

### M3 — паритет музыкальной и кинематической логики

Зависимости: G2. Цель: сохранить смысл и результат существующих алгоритмов.

| ID | Работа | Результат / проверка |
|---|---|---|
| W023 | Закрыть hand split, figure recognition и все настройки fingering | Golden comparison и профильные тесты для обеих рук |
| W024 | Закрыть chord fit, rolls, early release, maximum speed и interlocked/crossing hands | Performance events и числовые инварианты движения |
| W025 | Закрыть глиссандо, wrist gestures, rest poses и кеширование lookahead | Сравнение с/без работы вперёд; seek не меняет результат |
| W026 | Реализовать MIDI/PIG export с маркерами руки/пальца/глиссандо | Повторный импорт восстанавливает назначения; сохранены исходные события |
| W027 | Оптимизировать только выявленные горячие участки | До/после benchmark, неизменный паритет; ADR для TS/WASM переписывания |

Gate G3: по поддерживаемому fixture corpus точные hand/finger assignments; порядок событий совпадает; числовые отклонения времени/поз в заранее установленном допуске. Визуальные скины пока не входят в паритет. Совпадение с desktop не доказывает универсальную музыкальную правильность алгоритма.

### M4 — редактор аппликатуры и плотный UI

Зависимости: G2, W026; полная приёмка зависит от G3.

| ID | Работа | Результат / проверка |
|---|---|---|
| W028 | Горизонтальный piano roll, камера, масштаб, hit testing и выделение | Большая пьеса не создаёт DOM-узел для каждой ноты |
| W029 | Команды назначения руки/пальца, перепланирования и глиссандо | Стабильные noteId, ревизии, валидируемые команды |
| W030 | Undo/redo и последовательный ввод, горячие клавиши | История корректна через смену руки, пересчёт и экспорт |
| W031 | Difficulty/diagnostics, контекстные меню, help и панели | Диагностика привязана к текущей ревизии; клавиатурный доступ |
| W032 | Debounce/rebuild и защита от гонок | Старый расчёт не перезаписывает новые edits; видимый pending state |
| W033 | Проверить UI на desktop и узком экране, focus/keyboard/resize | Screenshots и сценарии, включая resize при открытом диалоге |

Gate G4: импорт → edit → undo/redo → перерасчёт → playback → export → re-import сохраняет назначения; UI остаётся доступным во время вычисления. Пиксельное копирование desktop layout не требуется, но функциональные действия должны быть сохранены.

### M5 — профили, настройки и надёжное хранение

Зависимости: G3/G4; базовый storage начат в W021.

| ID | Работа | Результат / проверка |
|---|---|---|
| W034 | Перенести anatomy/behavior/weights editor и активный профиль | Разные профили дают ожидаемые изменения исполнения |
| W035 | Перенести realistic/equal keys, placement, volume, performance overlay | Настройки сохраняются; геометрия и планирование согласованы |
| W036 | Импортировать legacy JSON профилей и settings | defaults для старых полей; reserved names и malformed JSON |
| W037 | Реализовать resource IDs, Recent, IndexedDB/OPFS и миграции схем | Windows paths не считаются браузерными разрешениями |
| W038 | Autosave, восстановление, backup package, quota handling | Тесты прерванной записи, quota failure, update/migration, clear storage |

Gate G5: устойчивое сохранение и восстановление, импорт старых профилей, понятные missing resource/errors. Настройка desktop frame cap заменяется доступной браузеру политикой render cap; «uncapped» не обещает превышение частоты обновления браузера.

Системные шрифты не копируются автоматически. Базовый шрифт поставляется с атрибуцией; пользовательский файл шрифта — возможная отдельная настройка. Удаление ресурса проверяет ссылки из проектов и Recent.

### M6 — скины, аудиозаписи и SoundFont

Зависимости: G3/G5.

| ID | Работа | Результат / проверка |
|---|---|---|
| W039 | Перенести cartoon/gloves/robot, тени и depth ordering | Визуальная приёмка поз, crossings и glissando по desktop snapshots |
| W040 | Импорт WAV/MP3/OGG/FLAC по фактической поддержке браузера | Capability checks, ошибки формата, память на длинной записи |
| W041 | Waveform peaks, offset drag, length validation и synced transport | Сохранена формула recording position = offset + song time / speed |
| W042 | Выбрать и исследовать SF2/SF3 engine для AudioWorklet/WASM | License, форматы, pedals, peak voices, memory, загрузка/cancel проверены |
| W043 | Реализовать пользовательский SoundFont либо документировать ограничение | Совместимость подтверждена fixtures; качественная ошибка unsupported |
| W044 | Добавить optional Web MIDI output и device disconnect handling | Разрешение, denied state, timestamp mapping и safe silence |

Gate G6: выбранные поддерживаемые форматы реально проигрываются; waveform/offset переживают сохранение; скины проходят приёмку. Произвольный SF2/SF3 не объявляется поддержанным только на основании одного успешного файла. Если совместимый engine не найден, это остаётся открытым ограничением полного переноса.

Сохранение высоты тона при смене скорости записи не добавляется автоматически: сначала проверить текущую desktop-семантику и оформить отдельное требование. Web MIDI не является условием встроенного звука или импорта MIDI-файлов.

### M7 — экспорт видео

Зависимости: G3, сцена/аудио стабильны; полный export зависит от G6.

| ID | Работа | Результат / проверка |
|---|---|---|
| W045 | Определить export scene, части кадра, lead-in/tail и точную временную шкалу | Контролы и editor overlays не попадают в кадр; соответствие desktop |
| W046 | Проверить MediaRecorder и WebCodecs на целевых браузерах | Реальные поддерживаемые codec/container configs и короткий экспорт |
| W047 | Реализовать детерминированную генерацию кадров/аудио и muxing | Exact timestamps, размер кадра, sync, backpressure и bounded memory |
| W048 | Добавить progress/cancel/cleanup и оценку возможности длинного экспорта | Отмена освобождает ресурсы; незавершённый файл не выдаётся за готовый |
| W049 | При необходимости создать отдельный FastAPI export service | Headless desktop renderer или согласованный web renderer + native FFmpeg; паритет результата |

Gate G7: **ВЫПОЛНЕН И ЗАКРЫТ (2026-10-13)**. Экспорт видео (W045–W048) реализован: headless PixiJS offscreen canvas, MediaRecorder capture, детерминированный шаг кадров, offline audio rendering с нормализацией пика до 0.89 (-1 dBFS), 16-bit PCM WAV кодировщик, диалог экспорта с пресетами 1080p/720p/4K/Window, превью-канвасом, прогрессом (веса 0.86/0.10/0.04), чистой отменой и скачиванием видео и WAV. Проверен тестами `offlineAudio.test.ts` (8/8), `videoExporter.test.ts` (5/5), браузерным тестом `video-export-m7.spec.ts` (1/1, 23.1s) и полной регрессией (9/9). Документирован в `web/docs/evidence/m7-video-export-2026-10-13.md`.

### M8 — deployment, PWA и приёмка релиза

Зависимости: для MVP preview G2; для полного локального web release G3–G7 и resolved release blockers.

| ID | Работа | Результат / проверка |
|---|---|---|
| W050 | CI: typecheck, scoped lint, unit/parity/browser tests, production build | Реальные команды, точные totals; артефакты прикреплены к отчёту |
| W051 | Настроить HTTPS-hosting, assets/MIME/base path/cache policy | Проверка actual deployed bundle/version и загрузки Worker/WASM |
| W052 | Service worker/PWA, offline cache, update lifecycle | Первый запуск online, затем offline; обновление не ломает текущий проект |
| W053 | CSP, file limits, filename/path sanitization, package import validation | Ошибочные/слишком большие документы и архивы отклоняются безопасно |
| W054 | Браузерная, визуальная, аудио- и performance-приёмка | Реальные браузеры/устройства, ограничения и измеренные результаты |
| W055 | Release notes, migration guide и rollback procedure | Backup before migration, compatibility errors, восстановление предыдущей поставки |

Публичное размещение не выполняется автоматически только потому, что локальные тесты прошли. Перед публикацией подготовить reviewable build и отчёт; фактическую публикацию выполнять в рамках авторизованной задачи. Desktop version/changelog не менять без заданного значения/содержимого.

COOP/COEP нужны при принятом использовании SharedArrayBuffer/многопоточного WASM; обычный Worker их сам по себе не требует. Перед включением проверить внешние ресурсы и выбранный host. Runtime и зависимости фиксируются; при self-hosting учитываются MIME и cache headers. Не загружать файлы пользователей в telemetry.

Gate G8: **ВЫПОЛНЕН И ЗАКРЫТ (2026-10-13)**. Полнофункциональный offline-first PWA релиз (W050–W055) развернут и проверен: manifest.webmanifest, maskable и vector иконки, Service Worker с кешированием app-shell и Pyodide-рантайма, CSP и заголовки статического хостинга (_headers), безопасная санитизация путей и имен файлов, лимиты 16 MiB MIDI / 32 MiB package / 100 MiB audio, защита от prototype pollution, CI pipeline runner (npm run ci), Release Notes, Migration Guide и Rollback runbook. Проверен unit-тестами (295/295, 18 suites), browser-тестами (28/28, 10 suites), CPython-тестами (12/12) и CI pipeline (PASS, 38.2s). Задокументирован в `web/docs/evidence/m8-deployment-pwa-2026-10-13.md`.

### M9 — облачное расширение, отдельный scope

Зависимости: устойчивый локальный формат проекта, решение о продуктовой необходимости.

| ID | Работа | Результат / проверка |
|---|---|---|
| W056 | FastAPI, auth, PostgreSQL и object storage | Ownership, revisions, metadata/files split |
| W057 | Jobs API и процессы/очередь расчёта или экспорта | POST → jobId; REST result/cancel; SSE progress; retries/idempotency |
| W058 | Explicit upload, resource retention/deletion и sync conflicts | Пользователь видит место обработки; local edits не теряются |
| W059 | Изоляция pianist context, worker lifecycle, CPU/time/memory limits | Два разных профиля/пользователя не смешиваются |
| W060 | Load/cost test и operational runbook | Измеренные CPU/time/storage/egress, мониторинг, rollback |

WebSockets вводить при двустороннем realtime/collaboration. gRPC не нужен для исходного SPA. PostgreSQL хранит проекты/ревизии/метаданные, object storage — медиа; SQLite migration отсутствует, поскольку исходная SQLite не используется.

## 6. Зависимости и порядок работы

```text
M0 → M1 → [G1: Pyodide либо FastAPI adapter] → M2 (MVP)
                                              ↓
                                      M3 (core parity)
                                              ↓
                                      M4 (editor)
                                              ↓
                                      M5 (profiles/storage)
                                              ↓
                                      M6 (skins/audio/SF)
                                              ↓
                                      M7 (video)
                                              ↓
                                      M8 (full release)

M8 bootstrap/preview возможен после M2.
M9 начинается только как отдельное облачное расширение.
```

Bootstrap UI и baseline tools можно разрабатывать независимо, но сложный editor не должен опережать G1. Преждевременный перенос всех скинов, серверной auth или видеопайплайна увеличивает риск переделки. План не предписывает создание агентов или параллельных чатов.

Оценку календарных сроков составить после W014: тогда известны доля адаптации ядра, производительность и стоимость передачи движения. Число задач здесь не является оценкой человеко-дней.

## 7. Проверки и свидетельства приёмки

| Область | Desktop evidence | Web evidence |
|---|---|---|
| MIDI, pedals, fingering | `test_core.py`, `test_figures.py`, `test_finetune.py` | Golden data, stable IDs, deterministic reruns, profile isolation |
| Loading/cancel | `test_loading.py` | Worker errors/cancel/restart/stale response |
| Hands/crossings/glissando | `test_core.py`, `test_glissando.py` | Numeric invariants, sampled poses, selected-time screenshots |
| Editor | `test_ui.py`, `test_edge_cases.py` | Edit/undo/sequential input/export/re-import flows |
| Profiles/settings | `test_recent.py`, `test_paths.py`, `test_fonts.py` | Legacy import, persisted settings, absent resources, storage migrations |
| Audio/SoundFont | `test_audio_sync.py`, `test_soundfont.py` | Audible playback, pedals/retrigger, offset, AudioWorklet and format capability |
| Video | `test_video_export.py` | File metadata, frame timestamps, decoded sync, cancel/cleanup |

Это карта существующих тестовых областей, а не заявление об их текущем прохождении. Точное соответствие тестов сценариям уточняется в W004/W005; pygame UI-тесты не переносить механически.

Начальные проектные ориентиры, которые необходимо уточнить в W007 и проверить в W014/W054:

- Целевые 60 FPS на reference desktop при 1080p; frame work p95 в пределах бюджета 16.7 ms. JS-тайминг и видимая плавность измеряются отдельно.
- Рассинхронизация звука и видимого удара ориентировочно до 50 ms без накопленного дрейфа на 10-минутном fixture; проверка учитывает устройство вывода и метод измерения.
- Input/cancel feedback до 100 ms; прекращение тяжёлого Worker job ориентировочно до 1 s через terminate при необходимости.
- Точные hand/finger assignments на согласованном golden corpus; начальный допуск времени исполнения 1 ms, координат 0.01 ширины белой клавиши. Допуски проверить и обосновать до использования.
- Память не растёт пропорционально длительности всей анимации. Peak memory и границы аудиодекодирования устанавливаются по reference/weak device, а не одинаково для всех браузеров.
- Нет обещания realtime/offline/background одинакового поведения на всех мобильных устройствах.

Числа выше — Proposed acceptance targets, не Tested results. Для native→Pyodide допуска чисел важно контролировать float precision, stable sort и tie breaking. Новые golden outputs не принимать только потому, что они совпали с новой реализацией.

Для каждого gate сохранить: source SHA; runtime/browser/device; fixtures; выполненные команды; точные totals; измерения; screenshots при визуальной проверке; ограничения; список незакрытых дефектов. Отдельно отмечать Verified (код/документация), Tested (выполненная проверка), Hypothesis (ожидаемый эффект), Unknown (неисследованное).

Команды, которые W002 должен определить в `web/package.json`: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:parity`, `npm run test:browser`, `npm run build`, `npm run dev`. До bootstrap эти команды не существуют. После создания lockfile CI использует `npm ci`. Python golden generation и pytest выполняются в отдельном test environment с зафиксированными requirements; не изменять запущенное desktop-окружение ради тестовых пакетов.

В ходе разработки выполнять проверки затронутой области. Полный unit/parity/browser набор обязателен для release gate; повторять дорогие проверки после новых изменений или обнаруженных проблем. Headless browser tests не заменяют ручную проверку слышимого звука, реальных device permissions и визуальную приёмку.

## 8. Основные риски и решения

| Риск | Ранний сигнал | Следующее действие |
|---|---|---|
| Python imports/NumPy/pretty_midi несовместимы | M1 не выполняет полный fixture | Изолировать проблемную зависимость; проверить adapter; принять FastAPI fallback |
| Python core смешан с pygame/state | `_chord_fits`, active profile, глобальные веса | Выделить geometry/context внутри web adaptation, сохранять parity |
| Дорогой bridge/pose вычисления | Буфер не успевает или stalls | Пакетный обмен, bounded lookahead, profiling; TS runtime для горячего участка |
| Интерполяция нарушает касание/слои | Неверный палец/проникновение рук | Event-aligned samples, адаптивный шаг, exact pose на событиях, сравнительные тесты |
| Звук зависит от render loop | Glitches/drift при resize/load | Audio master clock и независимое планирование; при buffer underrun контролируемая пауза |
| Большой SoundFont/PCM превышает память | Long audio allocation failure | Лимиты, частичная загрузка, release buffers, streaming strategy/серверный сценарий |
| Browser background lifecycle | Скрытая вкладка/закрытие прерывает работу | Документированная pause policy; сервер для длительных jobs |
| Потеря ресурсов/данных | quota/eviction/update failure | Persist request, backup, transactional migration и recovery |
| Browser codec/API mismatch | Safari/Firefox не воспроизводит экспорт | Capability detection и явно поддерживаемый формат; server fallback |
| Неясные условия распространения | Нет license/permissions на код/ресурс | Решить до публичной поставки; не приписывать отсутствующую лицензию |

## 9. Следующая конкретная задача

Начать с M0: W001–W007, затем M1. Первый reviewable результат — запускаемый минимальный web client и reproducible browser spike ядра, с baseline/golden fixtures, без изменения desktop исходников. После G1 зафиксировать ADR-002 о месте вычислений и только затем планировать реализацию MVP.

## 10. Источники технических ограничений

Локальная основа: `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `midi_loader.py`, `fingering.py`, `hands.py`, `common.py`, `pianist.py`, `sf2.py`, `sf_synth.py`, `audio_sync.py`, `video_export.py`, существующие `tests/` на указанном SHA. Браузерные возможности проверены при архитектурном анализе 2026-10-13; перед bootstrap нужно зафиксировать выбранные версии.

- [Pyodide в Web Worker](https://pyodide.org/en/stable/usage/webworker.html)
- [Ограничения Python в Pyodide](https://pyodide.org/en/stable/usage/wasm-constraints.html)
- [PixiJS render loop](https://pixijs.com/8.x/guides/concepts/render-loop)
- [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility)
- [Web Audio: AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [Audio output timestamps](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp)
- [requestAnimationFrame и фоновые вкладки](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
- [Политика autoplay](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [File picker и совместимость](https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker)
- [Storage quotas и eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [Web MIDI](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API)
- [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- [ffmpeg.wasm limitations](https://ffmpegwasm.netlify.app/docs/faq/)
- [FastAPI: тяжёлые фоновые задачи](https://fastapi.tiangolo.com/tutorial/background-tasks/)
