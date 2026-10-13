# PianoMotion Studio — Handoff

Дата: 2026-10-13. Веб-проект `C:\Projects\pygame-piano-animator\web`.

## Цель и статус

Веб-студия PianoMotion Studio с автономным расчётом аппликатуры, исполнения и кинематики. Реализованы и полностью закрыты все запланированные вехи Milestone M1–M8 (включая M7 экспорт видео и M8 PWA, безопасность, CI и релиз). Итоговые команды и результаты зафиксированы в [отчёте M8](evidence/m8-deployment-pwa-2026-10-13.md), [отчёте M7](evidence/m7-video-export-2026-10-13.md), [отчёте M6](evidence/m6-skins-audio-2026-10-13.md) и [отчёте стабилизации](evidence/stabilization-2026-10-13.md).

Верификация: 295/295 unit-тестов (18 suites), 12/12 CPython тестов, 28/28 browser-тестов (10 suites Playwright Chromium), CI pipeline (`npm run ci`) PASS (38.2s), 13 эталонных фикстур без расхождений, production сборка PASS. Dev-сервер работает: http://127.0.0.1:5175/. Все релизные гейты (G1–G8) закрыты.

## Сначала прочитать

1. [README](../README.md): назначение, структура, запуск и актуальный поток данных.
2. [User Guide](USER_GUIDE.md), [AGENTS](../AGENTS.md), [ORCHESTRATION](ORCHESTRATION.md).
3. [ADR-001](adr/ADR-001-contracts-and-time.md): IDs, source/transport time, plans и motion frame.
4. [ADR-002](adr/ADR-002-pyodide-engine-and-worker.md): Pyodide decision.
5. [G0 review](evidence/g0-review-2026-10-13.md), [fixtures](../tests/fixtures/README.md), [performance profile](evidence/performance-profile-2026-10-13.md), [licenses](evidence/licenses-2026-10-13.md).

## Сохранность материалов

Не выполнять reset/clean/stage/commit/push/deploy без прямого поручения пользователя. Сохранять файлы проекта и внешние материалы. Не создавать nested Git repo.

Пользователь назначил основного агента оркестратором; implementation agents — GPT-6 Luna Extra High (`gpt-6-luna`, `xhigh`, `fork_turns:none`), без дальнейшего создания агентов. Все работают в общем checkout; один writer npm/lock. Handoff исполнителя не является приёмкой.

## Структура и владение

| Область | Ответственность |
|---|---|
| `App.tsx` | Manifests, persistence startup, MIDI import, source-session lifetime, restored session |
| `player/PianoPlayer.tsx` | Draft/source context, one debounce controller, live scene/transport, exports/autosave |
| `player/workerJob.ts` | Worker lifecycle, schemas, identity filtering, abort/error/timeout, cleanup |
| `editor/` | Commands/history/selection, manual vs automatic intents, materialize edited document |
| `m1WorkerClient.ts`, `workers/` | Transfer-copy bridge, runtime loading, analyze/replan/export |
| `python-core/` | Adapted numerical core, original-byte normalization and direct edited planning |
| `packages/contracts/` | Strict DTO and contextual refs/revisions/resources/result validation |
| `audio/`, `render/` | Clock/state reducer, synth and actual PerformancePlan visuals |
| `storage/`, `profiles/`, `settings/` | IDB, serialized autosave, byte-complete package, async persistence/migration |
| `docs/evidence/`, `tests/browser/stabilization.spec.ts` | Exact evidence and meaningful integration regressions |

## Engine handshake

Original import: `analyze-midi` → `analysis-result`, Python `analyze_midi(bytes, options)`.

Edited planning: `replan-document` → `replan-document-result`, Python `replan_document(bytes, document, fingeringPlan, options)`. Request содержит request/project/revision/engine, original bytes, materialized document, draft plan, explicit profile, resource descriptor, original rawBaseline и options fixtureId/keyStyle. Исходные ноты сопоставляются по persistent IDs, а не pitch/time и не MIDI re-import.

Root-facing exports: `M1ReplanDocumentRequestSchema`, `validateM1ReplanDocumentResultForRequest`, `postM1ReplanDocumentRequest`, `materializeEditedDocument`. Result содержит full analysis envelope и keyStyle. Для преобразования в M1 analysis envelope сначала убрать keyStyle и изменить discriminator; strict schema не принимает лишнее поле.

`fingerMode` / `glissMode` отделяют пользовательские pins/clear от computed assignments. Clear снимает manual finger pin; Unplayable означает явное исключение из performance. Flags сохраняются в replan results и истории, иначе Undo после следующего расчёта теряет намерение пользователя. Manual pin, который engine не может соблюсти, не должен молча заменяться: validation/error сохраняет draft для исправления.

RawBaseline сохраняется как наблюдение исходного импорта. Он не становится эталоном изменённого исполнения. Производные планы соответствуют текущему document/profile/engine, с точными linked plan IDs.

Pinned runtime: Pyodide314.0.7, Python3.14.2, NumPy2.4.6, pretty-midi0.2.11.post0, mido1.3.3, importlib-resources7.1.0, packaging26.1 и catalog deps по manifest. Desktop NumPy2.5.4 отличается; 13-fixture numeric parity проверяется в настоящем браузере.

Engine version после стабилизации: `bfd43f9e0647e99e976517a52526ff59e0e600a009964e93cc3d5fba411378d7`. Это snapshot, не константа для будущих edits: packager вычисляет digest из adapted-file hashes. После core edits перепаковать и перезагрузить страницу. Runtime assets 12 files /21.37MiB; browser грузит их со своего origin.

## Player и editor lifetime

App remounts player по новому source result.requestId. В пределах одной source session editor остаётся mounted при смене вкладок; hidden editor не принимает global shortcuts. Stable manager identity основан на project/source resource, а не ссылке props.

Selection/navigation/step-entry — view events. Edit/undo/redo публикуют draft сразу, с монотонной revision. Parent debounce300ms создаёт одну задачу; новая правка/profile/style отменяет прошлый Worker. Late responses фильтруются по identity и generation. Success обновляет согласованный bundle и живые Transport/PianoScene; не стирает history/selection.

`Transport.updatePlan()` сохраняет playhead и playing/paused state. Seek/resume/speed восстанавливают только звучащие key-down/pedal-held voices, без проигрывания исторического префикса. Pure reducer сохраняет equal-time ordering, selective sostenuto и soft-at-strike. Visual keyboard и falling bars используют performance press/release, а metadata — source/derived display-only document.

Settings применяются к speed/volume/lead-in, timbre новых voices, labels/skin/shadow, RAF updates и Pixi ticker FPS cap. Это не означает готовую интеграцию всех M6 output adapters. Ошибки AudioContext/scene/Worker отображаются в UI.

## Persistence и recovery

Startup: `await initializeAppPersistence()` → `loadSessionSnapshot()` → `assessSessionSnapshot(snapshot, engineVersion)`. Не включать работу с source до завершения bootstrap и не перезаписывать старый session пустым initial state.

Snapshot содержит valid last `result`, original `rawMidiBytes`, current materialized `document`, `draftFingeringPlan`, full selected profile, keyStyle/viewMode и plansState. Pending draft сохраняется как recompute-required; после reload выполняется typed replan. Valid snapshot восстанавливается без нового импорта.

Compatibility: stale engine/profile/draft при проверенных bytes → recompute-required; source/hash/size/cross-project corruption → corrupt; legacy без validated full result envelope → incompatible. Последние два случая сохраняют record и показывают причину, автоматический unsafe restore не выполняется. Legacy с bytes, но без envelope, тоже требует явного MIDI re-import.

Autosaves сериализованы; новый snapshot не обгоняется старой async записью. Quota/storage failure не маскируется под успех. Пока вычисление pending/failed, полноценный save/export ждёт согласованного результата; draft остаётся в autosave, доступен Retry.

SavedProject включает original bytes, resource descriptors/payloads, profile и связанные планы. JSON package содержит base64 bytes с size/SHA-256 и identity checks. Restore helpers: `projectPackageToSavedProject`, `importProjectOrPackage`. UI открытия произвольного пакета/списка проектов ещё требует отдельного завершения.

Profiles/settings используют async IDB initialization и persistence, мигрируют legacy localStorage без очистки и перезаписи новых IDB данных. Profile callback получает committed normalized revision. Канонические presets защищены; ошибку сохранения показывать пользователю.

## Запуск и проверки

```powershell
Set-Location C:\Projects\pygame-piano-animator\web
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 5175 --strictPort
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run test:browser
npm.cmd run build
```

Dev URL [127.0.0.1:5175](http://127.0.0.1:5175/). Сервер текущей сессии остаётся запущенным, но не является Windows service. Browser tests используют4173 и fresh server; production smoke может использовать отдельный preview4174. Не завершать чужие port processes. PowerShell tool calls здесь `login:false`, npm.cmd/direct Node избегают profile delays.

```powershell
node.exe tools/package-python-core.mjs
..\.venv\Scripts\python.exe python-core/tests/test_replan.py
..\.venv\Scripts\python.exe python-core/tests/test_export.py
```

Эти Python scripts имеют настоящий main runner; запуск не устанавливает пакеты.

## Текущее состояние и возможности

1. Проверить actual checkout/status/server/manifests; прочитать итоговые totals в [evidence M8](evidence/m8-deployment-pwa-2026-10-13.md), [evidence M7](evidence/m7-video-export-2026-10-13.md) и [evidence стабилизации](evidence/stabilization-2026-10-13.md).
2. **Milestone M7 (Offline / Real-Time Video Export) закрыт, Gate G7 пройден**:
   - Реализован headless PixiJS offscreen canvas capture с MediaRecorder стримингом (VP9/VP8 WebM, MP4) и детерминированным шагом кадров 60 FPS.
   - Реализован offline audio synthesizer с нормализацией пика до 0.89 (-1 dBFS) и чистый 16-bit PCM RIFF WAV кодировщик.
   - Добавлен UI диалог экспорта с пресетами 1080p/720p/4K/Window, превью-канвасом, прогрессом (веса 0.86/0.10/0.04), отменой и раздельным скачиванием видео и WAV.
   - Проверен unit-тестами `offlineAudio.test.ts` (8/8), `videoExporter.test.ts` (5/5) и browser-тестом `video-export-m7.spec.ts` (PASS, 23.7s).
3. **Milestone M8 (Deployment, PWA & Final Polish) закрыт, Gate G8 пройден**:
   - Реализован manifest.webmanifest (standalone, #111516) и векторные/маскируемые PNG иконки.
   - Реализован Service Worker (`sw.js`) с двухслойным кешированием `pianomotion-shell-v1` и `pianomotion-pyodide-v1` и fallback для offline-работы.
   - Настроены статические заголовки хостинга `_headers` с CSP для WebAssembly и кешированием 1 год для неизменяемых ассетов.
   - Реализована строгая валидация файлов и санитизация: лимиты 16 MiB MIDI, 32 MiB package, 100 MiB audio, защита от обхода путей (`sanitizeFilename`, `isSafeResourcePath`) и prototype pollution (`assertNoPrototypePollution`).
   - Создан автоматический CI pipeline runner `web/tools/ci-verify.mjs` (`npm run ci`, PASS 38.2s).
   - Подготовлены Release Notes ([RELEASE_NOTES.md](RELEASE_NOTES.md)), User Guide ([USER_GUIDE.md](USER_GUIDE.md)) и Rollback runbook ([ROLLBACK.md](ROLLBACK.md)).
   - Проверен browser-тестом `pwa-deployment-m8.spec.ts` (4/4 PASS, 19.5s) и полной регрессией (28/28 PASS).
4. **Текущий статус**:
   - Все этапы дорожной карты браузерного приложения (M1–M8, W001–W055) полностью завершены.
   - M9 (облачное расширение: FastAPI, PostgreSQL, S3) является отдельным опциональным этапом, запускаемым по явному продуктовому решению.

Текущая передача не разрешает commit/push/deploy без явного указания пользователя. При продолжении сохранять целостность проекта.
