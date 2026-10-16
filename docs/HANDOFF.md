# PianoMotion Studio — Handoff

Обновлено: 2026-10-16. Основной checkout: `C:\Projects\pianomotion-studio`.
Старый desktop checkout `C:\Projects\pygame-piano-animator` — отдельный проект.

## Цель и статус

Текущая версия кода **0.1.0-dev.6**: по прямому запросу пользователя встроены 162 файла из `builtin_melodies/midi/`. Источники не изменяются; прочие форматы из `builtin_melodies/` не публикуются. Каталог доступен в File, Projects и стартовом экране; открытие проходит через существующий атомарный `runCandidate` с защитой несохранённых правок. Генератор `tools/prepare-builtin-melodies.mjs` создаёт content-addressed MIDI и manifest; `predev` и release builder вызывают его автоматически. Исходные MIDI входят в коммит, генерируемая public-папка игнорируется Git. `npm run test:catalog` проверяет все полные API-результаты реальной схемой TypeScript и включён в CI после Python. [Приёмка dev.6](evidence/builtin-melodies-2026-10-16/VERIFICATION.md). Пользователь разрешил commit/push/deploy после проверок; фактический deployment проверяется по workflow и live buildId.

Проверены все восемь приватных банков: шесть валидных SF2 прошли Settings/Worker/playback/reload/PCM-пробы в Chrome и Edge. Fazioli содержит повреждённую активную стереоссылку 287→288 и отклоняется, MuseScore General SF3 не поддерживается. Исправлены legal global/local generators, tuning/attenuation, огибающая и default one-shot. Это не реализация всех фильтров/модуляторов SF2. [Протокол и точные границы](evidence/user-soundfonts-2026-10-16/VERIFICATION.md). `soundfonts/` игнорируется Git и не публикуется; файлы не исправлялись автоматически.

Предыдущая локальная dev.5 добавила stereo SF2 и Blob-банки до 1 GiB. [Контракты, ресурсные ограничения и её приёмка](SOUNDFONT_STEREO_IMPLEMENTATION.md). Тот цикл не включал публикацию; последующее разрешение пользователя относится к объединённой dev.6. Приватные банки сохранять без изменения и не включать в репозиторий/релиз.

В предыдущем SF2-цикле untracked `builtin_melodies/` не использовалась; её MIDI-подпапка подключена позднее в dev.6 по отдельному запросу. Не выполнять массовый stage/cleanup пользовательских папок.

Текущий ремонт пауз «Buffering animation poses»: запросы ограничены 4 секундами/200 позами, но запускаются заранее, включая lead-in, с запасом по скорости и измеренной задержке Worker. Заполняется первый непрерывный пробел каждой руки; поздняя событийная точка больше не заслоняет ранний пробел. Возобновление требует запаса, Pause/Stop отменяют его. Исправлены также два исключения из пользовательского лога: cleanup стереоголосов и незапакованный dev Service Worker. Точная проверка Chrome/Edge и ограничения — в отчёте dev.5.

Итог dev.5: 447 unit, typecheck/lint/build; все 13 численных эталонов без отклонений; Chrome/Edge — delayed motion/2×/Pause, streaming после replan/restore, mono/stereo WAV/MP4/WebM, native IDB abort/migration, реальные файлы 128/512/1024 MiB, read-only Nice Steinway и production offline. [Полный протокол](evidence/sf2-motion-2026-10-16/VERIFICATION.md). Реальный банк потребовал снятия лишнего равенства длины L/R и относительных loops; каждый канал сохраняет исходные границы. Автоматическая проверка банка не заменяет субъективное прослушивание или полную совместимость со всеми SF2.

Предыдущая сдача R01–R14 повторного аудита от 15 октября имеет собственные автоматические результаты ниже; они не подменяют приёмку новых изменений dev.5. Ручные hardware/listening gates и ограничения нагрузки остаются открытыми. Полноширинная студия, два режима на одной сцене, 88 клавиш, native-DPR antialiasing и история редактора сохраняются. Пользователь заменил первоначальный Split на единое поле нот, клавиатуры и рук; инструменты зависят от режима. Диагностика, версия и описание изменений доступны из компактного нижнего статус-бара.

Актуальные дефекты, владельцы, команды и результаты: [AUDIT_REPAIR_PROGRESS](AUDIT_REPAIR_PROGRESS.md). Устройство студии: [STUDIO_WORKSPACE_IMPLEMENTATION](STUDIO_WORKSPACE_IMPLEMENTATION.md). Исторические отчёты M1–M8 сохраняются как история и не закрывают дефекты последующего аудита. Не переносить старые pass-counts в текущую приёмку.

Текущий ремонт включает сохранение/update barrier, согласованные offline-сборки, streaming motion, события live/WAV, Signalsmith DSP, SF2/MIDI и видео. Видеозапуск доступен после проверки реальных MP4/WebM; в диалоге выполняется отдельная проверка выбранного кодека/разрешения/частоты кадров. Подготовка выхода асинхронна: Player показывает фактически активный backend и сохраняет предыдущий при ошибке. Функциональная автопроверка одного пользовательского банка записана в dev.5; физический MIDI и субъективное прослушивание требуют отдельной ручной фиксации.

Историческая сдача ремонта: 397 unit-тестов, 28 Python-тестов, 13 неизменённых эталонов; UI, Worker, аудио, PWA и MP4/WebM проверены локально в Chrome и Edge. Точная матрица, включая Chrome PWA с полным и исправленным отдельным запуском, находится в реестре. Машинный снимок — `docs/evidence/audit-repair-2026-10-15/latest-verification.json`. Этот ремонт и dev.3 впоследствии закоммичены и опубликованы; актуальную ревизию смотреть через git, публикацию — через Pages workflow ниже. Не выполнять reset/clean ради получения зелёного статуса.

Следующий безопасный шаг — субъективное прослушивание пользовательского SF2, физический MIDI и прослушивание/просмотр экспорта по `AUDIO_SUPPORT.md`. Нагрузка 10k/50k нот достигла 120-секундного лимита и не принята; 2k измерены только на уровне Worker анализа. Не переносить этот результат на полную сцену 50k и не объявлять публичный релиз готовым. Производственные сборки должны идти через `npm run build`, который изолирует NODE_ENV=production; прямой Vite build обходит согласованную упаковку.

## Новые точки интеграции

В dev.4 отдельная строка над сценой удалена. Undo/Redo находятся в меню Edit и остаются доступны по Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z. Help (?) → Keyboard shortcuts открывает справку. Auto-advance (бывший Step Entry) находится возле назначений в шапке, только в Fingering; по умолчанию выключен. Переход происходит только после назначения пальца; подтверждение того же пальца не создаёт фиктивную правку или запись истории.

Приёмка dev.4: 401 unit-тест, typecheck/lint и production build с `/pianomotion-studio/` проходят. Edge: 13/13 UI; Chrome: 11 успешных первоначальных сценариев и 3/3 исправленных focused-проверки. Escape закрывает только верхний слой справки, возвращая фокус; история и canvas сохраняются между режимами. [Доказательства и границы](evidence/editor-command-menus-2026-10-15/VERIFICATION.md). Полные audit/PWA/media suites заново для этого UI-изменения не запускались.

`PianoPlayer` передаёт DOM-host через `headerAddon` оболочки и `assignmentControlsHost` редактора. `FingeringToolbar` выводит назначения через React portal, не перемещая сам редактор: `HTMLElement` означает готовый host, `null` — ожидание host без дублирования кнопок, `undefined` сохраняет прежнее самостоятельное размещение toolbar. `active` ограничивает показ портала режимом Fingering. Не переносить `FingeringEditor` между родителями: это сбросит историю.

Приёмка этого UI-изменения, команды и скриншоты: [fingering header verification](evidence/fingering-header-2026-10-15/VERIFICATION.md). Результаты аудита выше не заменены новыми частичными прогонами.

Версия текущей локальной сборки — `0.1.0-dev.5`. При сдаче следующего набора изменений увеличивать dev-версию и синхронно обновлять root/client/contracts package.json, ссылку на локальный contracts в client, соответствующие записи lockfile и release notes. Статус-бар читает client package.json. SemVer приложения не связан с `PACKAGE_VERSION=2` переносимого музыкального формата: этот формат нельзя менять ради номера сборки. Dev-версия не означает релизную приёмку.

- `player/saveResult.ts` и `studio/updateGuard.ts`: результат committed/blocked/failed, identity с revision и changeToken. `AutosaveService.flush({ throwOnError: true })` используется перед обновлением; обычный background flush по-прежнему сообщает ошибку через callback.
- `player/motionStreamController.ts`: один активный запрос с identity/seek epoch/timeout; любой соответствующий terminal освобождает запрос, устаревшие результаты не попадают в новый буфер. `render/motionBuffer.ts` проверяет покрытие отдельно по ожидаемым рукам и событийным точкам. Sparse diagnostic poses не являются доказательством dense playback coverage.
- Python начальное окно — 4 секунды/200 поз; API не больше 5 секунд/500 поз суммарно. Продолжение использует coverage/truncated/continuation; невозможность продвижения — ошибка ёмкости. Numerical goldens не менять.
- `audio/performancePlan.ts` — общий reducer событий press/release/педалей. Корректный пустой план означает тишину. Master gain применяется один раз. SF2 backend создаётся и готовится отдельно до активации; MIDI permission запрашивается кнопкой пользователя.
- `audio/signalsmithStretch.ts` и `audio/recording/timeStretch.ts`: локальный Signalsmith Stretch 1.3.2, нулевой pitch shift. Ошибка DSP не заменяется varispeed. Общая карта записи: songTime + offset; speed применяется к выходной временной карте.
- `tools/build-release.mjs`, `pwa/urls.ts`, `public/sw.js`: buildId до Vite, immutable release URLs и отдельный app scope. Manifest пишется только в dist. Не использовать Vite BASE_URL как корень приложения в production.
- `render/pianoScene.ts`: fixedViewport для экспорта с точными размерами, resolution=1, manual render, без ResizeObserver/ticker. Обычная сцена сохраняет native-DPR AA.
- `export/types.ts`: sourceIdentity содержит оригинальные MIDI bytes, revision/engine, fingering, raw baseline, исходный namespace/геометрию, resource и фактически активный аудиовыход. Экспорт обязан копировать снимок до async работы и не использовать live Worker студии.

Общие App/Player, контракты, зависимости и lockfile принадлежат оркестратору. Три исполнителя GPT-6 Luna Extra High: motion; audio/DSP/SF2/MIDI; PWA/storage, затем video. Browser suites выполнять последовательно. Результат исполнителя — сдача для независимой проверки, не автоматическое закрытие замечания.

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
| `App.tsx`, `player/controller.ts` | Atomic open candidate, manifests/startup/import, сохранение старой сессии до проверки новой |
| `studio/` | Полноширинная оболочка, Projects/Inspector, layout preferences, contextual UI и статус-бар |
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

Engine version текущего этапа: `93bc6a9a9eec06860d78a72234965a68542cdaeb769aa45b422c028ea91f8b69`. Это snapshot, не константа для будущих edits: packager вычисляет digest из adapted-file hashes. После core edits перепаковать и перезагрузить страницу. Runtime assets 12 files /21.37MiB; browser грузит их со своего origin.

## Player и editor lifetime

App remounts player по новому source result.requestId. В пределах одной source session editor остаётся mounted при смене вкладок; hidden editor не принимает global shortcuts. Stable manager identity основан на project/source resource, а не ссылке props.

Обе вкладки используют один `PianoScene` canvas. `FingeringEditor externalScene` сохраняет менеджер истории и публикует bridge выбора/назначений; собственного piano-roll canvas в студии нет. Геометрия отрисованных нот используется для hit testing и marquee. В редакторе отображается исходное время нот, в Performance — время PerformancePlan. Прокрутка/масштаб редактора не меняют позицию Transport; прокрутка во время исполнения сначала приостанавливает его.

`prepareSourceCandidate` передаёт проверенный Worker вместе с результатом. Подготовка saved project анализирует MIDI и перепланирует сохранённое намерение на том же Worker; только после успеха App заменяет сессию. Не добавлять повторный «прогрев» ядра при монтировании плеера. Операции Worker сериализованы: Pyodide globals и activeSongContext принадлежат одной операции за раз. Отмена нового проекта завершает только его Worker.

Player освобождает Worker в microtask, если следующий setup не переиспользовал его. Это необходимо для React StrictMode: немедленный terminate в replay cleanup оставляет плеер с завершённым Worker и приводит к зависанию следующей правки. Реальная смена/закрытие сессии освобождает прежний Worker.

Selection/navigation/step-entry — view events. Edit/undo/redo публикуют draft сразу, с монотонной revision. Parent debounce300ms создаёт одну задачу; новая правка/profile/style отменяет прошлый Worker. Late responses фильтруются по identity и generation. Success обновляет согласованный bundle и живые Transport/PianoScene; не стирает history/selection.

`Transport.updatePlan()` сохраняет playhead и playing/paused state. Seek/resume/speed восстанавливают только звучащие key-down/pedal-held voices, без проигрывания исторического префикса. Pure reducer сохраняет equal-time ordering, selective sostenuto и soft-at-strike. Visual keyboard и falling bars используют performance press/release, а metadata — source/derived display-only document.

Settings применяются к speed/volume/lead-in, timbre новых voices, labels/skin/shadow, RAF updates и Pixi ticker FPS cap. Это не означает готовую интеграцию всех M6 output adapters. Ошибки AudioContext/scene/Worker отображаются в UI.

## Persistence и recovery

Startup: `await initializeAppPersistence()` → `loadSessionSnapshot()` → `assessSessionSnapshot(snapshot, engineVersion)`. Не включать работу с source до завершения bootstrap и не перезаписывать старый session пустым initial state.

Snapshot содержит valid last `result`, original `rawMidiBytes`, current materialized `document`, `draftFingeringPlan`, full selected profile, keyStyle/viewMode и plansState. Восстановление проверяет исходные bytes/IDs и подготавливает согласованные планы. Pending draft восстанавливается без старых performance/motion plans прежней revision/profile. Метаданные намерения адаптируются к текущему engine перед перепланированием; ID и manual flags сохраняются.

Compatibility: stale engine/profile/draft при проверенных bytes → recompute-required; source/hash/size/cross-project corruption → corrupt; legacy без validated full result envelope → incompatible. Последние два случая сохраняют record и показывают причину, автоматический unsafe restore не выполняется. Legacy с bytes, но без envelope, тоже требует явного MIDI re-import.

Autosaves сериализованы; новый snapshot не обгоняется старой async записью. Quota/storage failure не маскируется под успех. Пока вычисление pending/failed, полноценный save/export ждёт согласованного результата; draft остаётся в autosave, доступен Retry.

SavedProject включает original bytes, sourceContext, resource descriptors/payloads, profile и связанные планы. JSON package v2 содержит base64 bytes с size/SHA-256 и identity checks. Меню File открывает MIDI, JSON-пакеты и список сохранённых проектов; Projects предоставляет поиск и recent list. Читатель v1 выводит namespace только из всех канонических source IDs и требует явного выбора исходной геометрии. Не угадывать note IDs по pitch/time и не переписывать повреждённые пакеты.

Layout preferences хранятся отдельно в settings store под `studio.layout.v1`; режим входит в session snapshot. Legacy Split нормализуется в Performance. Общие настройки и анатомия открываются в полноэкранном рабочем слое с фокусом/Escape. Профиль этого экрана берётся из текущей сессии, включая импортированный пакет, а не автоматически из глобального preset. Внешняя запись и её offset остаются runtime-состоянием; их перенос в пакет не является результатом этого этапа.

Profiles/settings используют async IDB initialization и persistence, мигрируют legacy localStorage без очистки и перезаписи новых IDB данных. Profile callback получает committed normalized revision. Канонические presets защищены; ошибку сохранения показывать пользователю.

## Запуск и проверки

```powershell
Set-Location C:\Projects\pianomotion-studio
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 5176 --strictPort
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:unit
npm.cmd run test:browser
npm.cmd run build
```

Dev URL текущей сессии [127.0.0.1:5176](http://127.0.0.1:5176/). 5173 занят старой копией из `pygame-piano-animator/web`, она не завершалась. Наличие процесса нужно проверить перед запуском; это не Windows service. Browser tests используют4173 и fresh server. Не завершать чужие port processes. PowerShell tool calls здесь `login:false`, npm.cmd/direct Node избегают profile delays.

```powershell
node.exe tools/package-python-core.mjs
python -B python-core/tests/test_replan.py
python -B python-core/tests/test_export.py
```

Эти Python scripts имеют настоящий main runner; запуск не устанавливает пакеты.

## Следующий безопасный шаг

Отрисовка сцены включает PixiJS anti-aliasing. Resolution берётся из валидного devicePixelRatio с границами 1–2 и обновляется при resize; autoDensity сохраняет логические координаты клавиш, рук и выбора нот. Постоянный supersampling 2× отклонён: первый прогон серии скриншотов с ним превысил лимит 180 секунд. Это не отдельный FPS-бенчмарк. Текущий вариант проверен на шести размерах окна с проверкой фактического WebGL antialias flag и framebuffer.

Проверить checkout/status/server/manifests и текущую запись приёмки студии. Изменения находятся в рабочем дереве поверх `dc7eb963ff793110c586b4e86129cb22282cd452`; commit/push/deploy не выполнялись.

Для проверки интерфейса открыть `http://127.0.0.1:5176/`: MIDI → Fingering → выбрать ноту → назначить руку/палец → Save → Export package. Панели и режимы не должны создавать новый canvas или Worker. Все 88 клавиш остаются в доступной ширине.

Сохранённый импортированный профиль может отсутствовать в глобальной библиотеке: дублирование копирует фактический профиль сессии, Save увеличивает revision даже при первой записи в библиотеку. Повреждённая старая сессия остаётся в IndexedDB; подробная ошибка доступна из нижнего статус-бара. Не очищать такие данные автоматически.

Полная релизная готовность не объявляется. Результаты исходных сценариев R01–R14 и оставшиеся ограничения перечислены в актуальном реестре. Прежние исторические отчёты M7/M8 не служат подтверждением исправления. Восстановление выполняется по [ROLLBACK](ROLLBACK.md), без удаления данных сайта. Исправленные сведения о лицензиях и notices: [inventory 2026-10-15](evidence/licenses-2026-10-15.md); права исходного проекта остаются отдельным препятствием публичной публикации.

M9 (FastAPI/PostgreSQL/S3) — опциональное облачное расширение по отдельному продуктовому решению. До этого приложение остаётся клиентским, данные хранятся в браузере и экспортируемых пакетах.

## GitHub Pages

Workflow `.github/workflows/deploy-pages.yml` запускает release build с `APP_BASE=/pianomotion-studio/`; публикация ограничена проектным путём Pages, веткой `main` и Actions variable `PAGES_ENABLED=true`. На 2026-10-15 репозиторий публичный, GitHub Pages включён. Deployment run [38762695870](https://github.com/shafranek-js/pianomotion-studio/actions/runs/38762695870) прошёл build за 38 секунд и deploy за 50 секунд на commit `07cae1c`; сайт опубликован по адресу https://shafranek-js.github.io/pianomotion-studio/.

Предыдущая попытка настройки Pages завершилась HTTP 422, пока репозиторий был private на неподдерживаемом плане; это историческая причина, устранённая изменением видимости и включением Pages. Windows Verify run [38744216820](https://github.com/shafranek-js/pianomotion-studio/actions/runs/38744216820) остановился на SHA-256 Python из-за CRLF checkout; `.gitattributes` сохраняет LF для исходников. Следующий run [38763404607](https://github.com/shafranek-js/pianomotion-studio/actions/runs/38763404607) прошёл Python/typecheck/lint/unit, затем остановился на checksum текстоподобной invalid MIDI fixture до browser suites. В dev.4 этот конкретный файл помечен `-text`; свежий autocrlf checkout подтверждает сохранение исходного SHA-256. Результат следующего полного Windows CI нужно проверить отдельно; локальная UI-приёмка его не заменяет. Текущий deploy: [workflow](https://github.com/shafranek-js/pianomotion-studio/actions/workflows/deploy-pages.yml).
