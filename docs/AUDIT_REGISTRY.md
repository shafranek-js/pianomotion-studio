# Реестр замечаний аудита PianoMotion Studio (A01–A16)

> **2026-10-15: предыдущие статусы ниже являются историческими заявлениями реализации, а не действующей приёмкой.** Повторная проверка нашла R01–R14; полный аудит не закрыт. Текущее исполнение и доказательства ведутся в [AUDIT_REPAIR_PROGRESS.md](./AUDIT_REPAIR_PROGRESS.md). Статусы «реализовано», «проверено автоматически» и «требует ручной проверки» учитываются отдельно.

Дата создания: **2026-10-14**.  
Основание: [Аудит от 2026-10-14](/C:/Users/pavel/.codex/visualizations/2026/10/13/01a134bd-3548-7483-bf3b-27bf94b721c4/audit-2026-10-14/AUDIT.md).  
Исходный коммит аудита: `dc7eb963ff793110c586b4e86129cb22282cd452`.  
Текущий рабочий каталог: `C:\Projects\pianomotion-studio`.

---

## 1. Реестр основных замечаний A01–A16

| ID | Приоритет | Замечание | Исходная локация | Исторический статус реализации | Исполнитель | Сценарий воспроизведения | Метод проверки и критерий приёмки |
|---|---|---|---|---|---|---|---|
| **A01** | **P1** | Любой корректный replan завершается `NameError` | `python-core/handthesia_core/api.py:994` | **Исправлен** (перестройка студии) | Core / Orchestrator | Analyze tracked MIDI → выбор ноты → смена пальца → `replan_document` завершался `NameError: name 'engine_version' is not defined`. | `test_replan.py` (4/4 PASS), browser test `stabilization.spec.ts`. Приёмка: полный цикл edit→replan→undo→re-export. |
| **A02** | **P1** | Promise сохранения завершается до commit транзакции IndexedDB | `apps/client/src/storage/projectDb.ts:362`, `autosave.ts:189` | **Исправлен** (перестройка студии) | Storage / Orchestrator | Искусственный `tx.abort()` после `request.onsuccess`. Ранее UI объявлял сохранение успешным, а ключ отсутствовал. | `storage.test.ts`, `m5-storage.test.ts`. Приёмка: Promise резолвится строго на `tx.oncomplete`; abort/error вызывают reject. |
| **A03** | **P1** | Production PWA не запускается offline | `apps/client/src/App.tsx`, `apps/client/public/sw.js`, `tools/generate-offline-manifest.mjs` | **Исправлен (Этап 2)** | PWA / Orchestrator | Запуск production build (`vite preview`), online reload с установленным SW, затем offline navigation. Ошибка `Failed to fetch source_manifest.json?t=...`. | Детерминированный `offline-manifest.json` с SHA-256; атомарный staging cache в SW с валидацией целостности; namespace-изоляция кэшей (`pianomotion-*`); поддержка base path; предложение обновления через статус-бар с сохранением перед reload; Playwright тесты `tests/browser/offline-pwa.spec.ts` (2/2 PASS). |
| **A04** | **P1** | Видеоэкспорт сообщает об успехе, но не экспортирует исполнение целиком | `apps/client/src/export/videoExporter.ts:141,162,221`, `types.ts:53` | **Исправлен (Этап 5)** | Video / Orchestrator | Запуск видеоэкспорта: нет поз рук, захват real-time captureStream зависит от wall clock, WAV пишется отдельно от видео. | WebCodecs + mediabunny 1.61.4; детерминированный покадровый рендеринг `scene.update(t)` с передачей `motionPlan` в `PianoScene.create`; экспорт MP4 (H.264/AAC) и WebM (VP9/Opus); синхронный звук через `AudioBufferSource` и `renderOfflineAudio`; разблокировка экспорта в UI (`StudioShell` Export menu -> `VideoExportModal`); юнит-тесты в `videoExporter.test.ts` (8/8 PASS). |
| **A05** | **P2** | WAV игнорирует `PerformancePlan` и педали | `apps/client/src/export/offlineAudioRenderer.ts` | **Исправлен (Этап 3)** | Audio / Orchestrator | Сдвиг событий `PerformancePlan` на 1 с давал идентичный побитово WAV, так как рендерер читал `document.notes`. | Рендеринг строго по `PerformancePlan.events`; общая машина состояний педалей (CC64 sustain, CC66 selective sostenuto, CC67 soft pedal); юнит-тесты в `offlineAudio.test.ts` (10/10 PASS). |
| **A06** | **P2** | SoundFont/Web MIDI в Settings меняют выбор/бейдж, но плеер остаётся на встроенном PianoSampler | `apps/client/src/player/PianoPlayer.tsx:175`, `transport.ts:137` | **Исправлен (Этап 4)** | Audio / Orchestrator | Переключение на SoundFont или Web MIDI меняло статус в UI, но реальные ноты/педали не направлялись в соответствующие бэкенды. | Реализован единый интерфейс `PerformanceOutput` (Synth, SoundFont, Web MIDI); SoundFont 2 движок с loop modes 0/1/3, селективным состенуто CC66, изоляцией голосов и отдельным хранилищем ассетов в IndexedDB по SHA-256 (`soundfontAssetStore`); Web MIDI с точными timestamps (`DOMHighResTimeStamp`), CC7 громкостью и panic при отключении/смене устройства; разблокировка soundfont и webmidi в `SettingsModal` с динамическим UI; юнит-тесты в `output.test.ts` и `soundfont.test.ts` (100% PASS). |
| **A07** | **P2** | Сохранённый проект/JSON backup нельзя открыть через UI | `apps/client/src/player/PianoPlayer.tsx:417` | **Исправлен** (перестройка студии) | Shell / Orchestrator | Отсутствовали вызовы и контролы меню для открытия сохраненных проектов из IDB и внешних JSON-пакетов. | Меню File → Open saved project / Open JSON package; E2E тест открытия проекта; целостность исходных байт и планов. |
| **A08** | **P2** | Toolbar skin сохраняется в localStorage, а startup предпочитает прежний IDB record | `apps/client/src/player/PianoPlayer.tsx:318`, `settingsStore.ts:56` | **Исправлен** (перестройка студии) | Storage / Orchestrator | Смена скина в панели сохранялась в localStorage, а при перезагрузке читался старый IDB record. | Единое committed persistence-хранилище настроек в IDB; перезагрузка страницы сохраняет выбранный скин. |
| **A09** | **P2** | Motion-stream Worker не получает новую source/revision после replan, отсутствует при session restore | `apps/client/src/player/PianoPlayer.tsx`, `workerJob.ts` | **Исправлен (Этап 1)** | Core / Orchestrator | Replan в отдельном Worker оставлял старый контекст в sampler; при restore worker становился null; streaming поз зависал. | Epoch-tracked отсечение устаревших ответов, непрерывное покрытие обеих рук, буферизация с автовозобновлением, тесты `player-m2.spec.ts` и `stabilization.spec.ts`. |
| **A10** | **P2** | MotionBuffer считает range coverage достаточной, не проверяя плотность и разрывы | `apps/client/src/render/motionBuffer.ts` | **Исправлен (Этап 1)** | Core / Orchestrator | Две позы в 0с и 30с давали `needsMorePoses(2) == false`, игнорируя 30-секундный разрыв. | Покрытие рассчитывается раздельно для активных рук с проверкой разрывов <= 250 мс; unit-тесты `motionBuffer.test.ts` (13/13 PASS). |
| **A11** | **P2** | Лимит initial poses применяется после полного заполнения duration grid | `python-core/handthesia_core/api.py` | **Исправлен (Этап 1)** | Core / Orchestrator | Tiny MIDI с большой временной дистанцией заполнял огромный set кандидатов до downsampling, создавая риск OOM. | Ленивая генерация кандидатов в пределах окна без глобальной сетки; честный возврат `HandCoverage` и continuationTimeSeconds. |
| **A12** | **P2** | Долгоживущий Worker удерживает все animator sessions по revisions | `python-core/handthesia_core/api.py` | **Исправлен (Этап 1)** | Core / Orchestrator | 20 последовательных ревизий оставляли 20 активных сессий в памяти Worker (`_active_animator_sessions`). | Ровно 1 активная animator session на Worker для текущей revision; вытеснение старых сессий при перепланировании; тесты в `test_motion_window.py`. |
| **A13** | **P2** | Разрешённый `maxPoses=1` вызывает ZeroDivisionError | `packages/contracts/src/index.ts`, `python-core/handthesia_core/api.py` | **Исправлен (Этап 1)** | Core / Orchestrator | Вызов `sample_motion_window` с параметром `maxPoses=1` вызывал деление на ноль. | Корректная обработка `maxPoses=1..5`; при 1 возвращается ровно одна поза в начале окна без ZeroDivisionError; тесты `test_motion_window.py`. |
| **A14** | **P2** | Запись проходит через два gain с одной громкостью; формула времени делила на скорость | `apps/client/src/audio/recording/syncedAudioSource.ts`, `PianoPlayer.tsx`, `transport.ts` | **Исправлен (Этап 3)** | Audio / Orchestrator | Установка master volume 0.5 давала 0.25 (двойное умножение: master 0.5 * source 0.5); формула времени `offset + songTime / speed` ломала синхронизацию с партитурой при смене скорости. | Применение мастер-громкости ровно 1 раз через master gain; отдельный независимый trim записи (по умолчанию 1.0); единая формула времени `recordingPosition = songTime + offset`; юнит-тесты `recording.test.ts` (28/28 PASS). |
| **A15** | **P2** | Speed change переатакует held/sustained ноты | `apps/client/src/audio/transport.ts`, `sampler.ts`, `syncedAudioSource.ts` | **Исправлен (Этап 3)** | Audio / Orchestrator | Смена темпа во время звучания вызывала `silenceAll` и повторный `noteOn`, приводя к сбросу envelope и щелчкам. | Звучащие голоса сохраняются без `silenceAll` и повторного `noteOn`; будущие события отменяются и перепланируются на новой скорости; интеграция `signalsmith-stretch 1.3.2` для растяжения аудио без сдвига высоты (`semitones = 0`); юнит-тесты `audio.test.ts` и `recording.test.ts`. |
| **A16** | **P2** | Если recorder/chunks отсутствуют, экспорт создаёт 1024 нулевых байта и объявляет success | `apps/client/src/export/videoExporter.ts:295` | **Исправлен (Этап 5)** | Video / Orchestrator | При сбое captureStream или отсутствии чанков экспортер создавал фиктивный Blob и выставлял статус `completed`. | Удаление фиктивного Blob; статус `completed` только при успешном завершении реального mux; явный fail с описанием ошибки; регрессионный тест в `videoExporter.test.ts` (PASS). |

---

## 2. Дополнительные замечания аудита

1. **SF2-движок (Этап 4) — Исправлен**:
   - Исправление loop bounds (`loopStart >= start`, `loopEnd <= end`), sample modes 0, 1, 3.
   - Корректное отпускание после педалей и селективное состенуто (CC66) без ложного захвата новых нот.
   - Изоляция независимых голосов с одинаковой высотой.
   - Хранение SF2 в отдельном IndexedDB asset store по SHA-256 (`soundfontAssetStore`) без раздувания JSON проекта.
2. **Импорт профиля пианиста (Этап 6) — Исправлен**:
   - При совпадении profileId в `ProfileModal.tsx` отображается диалог конфликта с выбором: "Создать копию" (по умолчанию, выделена), "Заменить" (для пользовательских профилей) или "Отмена".
   - Канонические встроенные профили строго защищены от перезаписи в `saveProfile` (`profileStore.ts`).
   - Юнит-тесты в `profiles.test.ts` (22/22 PASS).
3. **Subdirectory Hosting (Этап 2) — Исправлен**:
   - Поддержка base path: пути к manifest, Worker, icons, DSP и runtime корректно резолвятся как в `/`, так и в `/pianomotion/`.
4. **Namespace-изоляция кэшей Service Worker (Этап 2) — Исправлен**:
   - Удаление только собственных кэшей с namespace приложения и base path (`pianomotion-*`), чтобы не задеть другие приложения на том же origin.
5. **Photo Rig / Photo Mesh (Этап 6) — Исправлен**:
   - Из выпадающих списков настроек (`SettingsModal.tsx` и `StudioInspector.tsx`) скрыты нереализованные заглушки `photo-segmented`, `photo-mesh`, `photo-3d`.
   - Активны 5 реализованных процедурных векторных стилей: `realistic` (по умолчанию), `cartoon`, `gloves`, `robot`, `skeleton`.
6. **Лицензии и документация релиза (Этапы 0 и 6) — Исправлен**:
   - Аудит лицензий ключевых библиотек:
     - **Signalsmith Stretch 1.3.2**: MIT (по установленному пакету и lockfile; notices сохраняются).
     - **Mediabunny 1.61.4**: MPL-2.0 (Weak copyleft on file level, compatible with web bundling).
     - **Pyodide 314.0.7**: MPL-2.0.
     - **PixiJS 8.x**: MIT.
     - **React 19 / TypeScript 6 / Vitest 5**: MIT / Apache-2.0.
   - Исторические результаты G1–G8 не закрывают текущую приёмку. R01–R14 повторной проверки находятся в ремонте; полное закрытие A01–A16 не подтверждено.
