# PianoMotion Studio: журнал оркестрации

## Удаление выпадающей кнопки Edit / History (Undo/Redo) — 2026-10-22

По прямому указанию пользователя удалена выпадающая кнопка меню Edit / History из верхней панели StudioShell: шорткаты Ctrl+Z и Ctrl+Y являются общеизвестными стандартами и полностью поддерживаются нативно на уровне клавиатурных обработчиков редактора аппликатуры.
- apps/client/src/studio/StudioShell.tsx: удалены неиспользуемые импорты Undo2 и Redo2, вариант edit из состояния menu, ссылки editMenuTriggerRef, canUndo/canRedo и блок разметки кнопки меню studio-edit-menu.
- apps/client/src/studio/studio.css: очищены селекторы .studio-edit-menu и скорректирована разметка сетки колонок хедера на мобильных/узких брейкпоинтах (@media (max-width: 1199px), 560px, 380px).
- tests/browser/: тесты переведены с кликов по кнопке меню на прямые проверки через клавиатурные сочетания Control+z и Control+y.
- Верификация: typecheck PASS, lint PASS, test:unit PASS, browser test 2/2 PASS в Chrome. Git stage/commit/push/deploy не выполнялись.


## Glow активных 3D-нот — dev.21, 2026-10-18

`active_note_glow` (GPT-6 Luna Extra High) владел fallingNotes3dView.ts, новым helper и focused tests. Root: shared versions/release description, browser-привязка к музыкальному времени, визуальная приёмка, совместимость с сатиновым deck и документация. Root вернул на исправление ось масштаба, повторное объявление shader attribute и слишком тонкий ореол; исправления проверены. Эффект только у активных блоков, с цветом руки, ограниченными заранее выделенными instance-буферами и сохранением контура; без общего bloom сцены, изменений звука, транспорта или музыкальных данных. Chrome/Edge по 2/2 PASS, render3d 29/29, scoped lint/harness tsc/build PASS. Общий typecheck прошёл на финальном повторе после параллельных правок practice-тестов; первоначальные ошибки отражены в протоколе. [Протокол](evidence/active-note-glow-2026-10-18/VERIFICATION.md). Принята только область glow; commit/push/deploy не выполнялись. Существующие пользовательские изменения сохранены.

## Мягкие блики экрана нот — dev.20, 2026-10-18

`soft_note_surface` (GPT-6 Luna Extra High) владеет только материалом deck в fallingNotes3dView.ts; пять параметров изменены поверх существующих правок. Root: matched screenshots/метрики яркости, изолированные Chrome/Edge, focused regression, версии и документация. Геометрия, освещение и музыкальные данные сохранены. Первое измерение включило неизменные яркие пиксели нот; тестовый sampler уточнён без ослабления критерия подавления бликов. Chrome/Edge по 1 сценарию с двумя ракурсами PASS, render3d unit 26/26, typecheck, focused lint, harness tsc и build PASS. [Протокол](evidence/note-surface-2026-10-18/VERIFICATION.md). Принята только область материала; коммит/публикация не выполнялись.

## Второй этап практики: A–B и закладки — dev.22, 2026-10-18

`practice_transport`, `practice_architecture` и `practice_ui` (GPT-6 Luna Extra High) реализовали Transport/запись, optional practiceState в contracts/IndexedDB/recovery/package, Player/Play Along, PracticePanel/Shell/layout и шесть переводов. Root проверил handoffs и интеграцию, вернул на исправление bounded SoundFont windows, readiness ordering, pending-preparation races, Signalsmith future scheduling, keyboard/focus и mobile heading. Дополнительные release subagents подготовили metadata, harness и удаление незавершённого selector только из изолированной копии. Итоговая копия: 67 unit files / 639 tests PASS, full types и lint PASS, production build PASS; Chrome подтверждает девять уникальных сценариев исходным и focused прогонами, Edge 9/9 PASS. [План](PRACTICE_STAGE2_PLAN.md), [точный протокол и ограничения](evidence/practice-stage2-2026-10-18/VERIFICATION.md).

Пользователь после реализации явно разрешил commit, push и deploy накопленных изменений. Публикуется замороженный снимок dev.22 из scratch/release-dev22: параллельная незавершённая настройка модели рук остаётся в исходном checkout, рабочие файлы не откатываются. Root формирует Git index из проверенной копии и контролирует Pages workflow/live build. Старые menu/rail/library/audit/stage изменения сохранены; desktop и зависимости не менялись. Локальный этап завершён; общий migration/полный CI gate не объявляется закрытым.
## Сохранение выбора библиотеки после refresh — 2026-10-18

Пользователь просит сохранять настройки Built-in Melodies. `library_preferences` (GPT-6 Luna Extra High) владел BuiltinMelodiesDialog.tsx, новым libraryPreferences.ts и focused unit: filter, sort и query, lazy restore и синхронное best-effort сохранение, безопасная валидация хранилища. `library_preferences_browser` подготовил library-preferences.spec.ts и scoped tsconfig: close/reopen, refresh, welcome → player, сброс defaults и избранное; узко исправил прежний неоднозначный Browse locator в существующем сценарии. Root проверил diff и снимок, уточнил relative row locators, выполнил независимые unit/typecheck/lint/bundle и последовательные Chrome/Edge с отдельным cache. Итог: 12/12 focused unit, typecheck/lint/Vite bundle PASS; Chrome 3/3 и Edge 3/3 PASS. [Протокол и снимки](evidence/library-preferences-2026-10-18/VERIFICATION.md). Локальное исправление завершено; избранное, проекты и прежние menu/rail/stage изменения сохранены. Версии/зависимости/desktop вне scope, Git stage/commit/push/deploy не выполнялись; общий release gate не закрыт.

## Быстрые действия левой панели — 2026-10-18

Пользователь утвердил первый этап: Библиотека, Импорт MIDI и Аудиозапись. `rail_implementation` (GPT-6 Luna Extra High) владел StudioShell.tsx/studio.css: существующие callbacks, прямой переход на Audio, фокус и адаптивная панель. `rail_localization` подготовил новый rail-контракт и переводы EN/CS/UK/DE/ES/IT. `rail_browser` подготовил rail-quick-access.spec.ts и scoped tsconfig: реальные действия, доступность, narrow/short viewport и screenshots. Root проверил diff и снимки, вернул на уточнение docking offset, компактный mobile row и порядок modal/localization browser-проверки. Итог: 4/4 focused unit, typecheck/lint/Vite bundle PASS; четыре уникальных Chrome-сценария подтверждены исходным и focused прогонами, Edge 4/4 PASS. [Точный протокол и снимки](evidence/rail-quick-access-2026-10-18/VERIFICATION.md). Первый этап локально завершён; A–B и закладки остаются следующим этапом. Существующие menu/audit/CI/stage изменения сохранены. Версии/зависимости/desktop вне scope, commit/push/deploy не выполнялись; общий release gate не закрыт.

## Рассеянный концертный свет — dev.19, 2026-10-18

Пользователь запросил столб рассеянного света и подсветку краёв круглой площадки по прежнему референсу. `concert_stage` (GPT-6 Luna Extra High) владел только PianoStage3D, новым `pianoStageAtmosphere.ts` и focused unit. Root сократил через исполнителя лишнюю детализацию, уточнил quality/visibility/reflector-контракт, вернул первый жёсткий конус по P1 и принял смягчённую вторую итерацию. Root владеет браузерным сравнением on/off, fixed/manual стабильностью и fade, общими версиями/описанием, документацией и интеграционным ревью. Общие preset/brightness/quality сохранены; новые пункты UI не добавлены. Chrome 4/4, Edge 4/4, focused unit 3/3, typecheck/lint/build PASS. В полном unit-прогоне 601/602 и таймаут неизменённого теста перепланирования ядра; отдельный повтор файла прошёл 6/6, исходный тест за 1885 мс при прежнем лимите. [Точный протокол и визуальные итерации](evidence/stage-atmosphere-2026-10-18/VERIFICATION.md). Одновременные menu/rail/hand-rig и прочие пользовательские правки сохранены. Принята только область света, общий release gate не закрыт. Commit/push/deploy не выполнялись.

## Восстановление видимости меню File/Export — 2026-10-18

Пользователь сообщил, что File и Export показывают по одному пункту. `menu_repair` (GPT-6 Luna Extra High) владел StudioShell.tsx/studio.css: portal вместо обрезаемого вложенного popover, привязка к кнопке, focus/outside-click и responsive layout. `menu_browser` подготовил menu-visibility.spec.ts и scoped tsconfig: реальные hit-test/viewport/action/keyboard проверки. `menu_inventory` независимо сверил исторический набор пунктов и handlers read-only. Root воспроизвёл исходный дефект, проверил diff и изображения, выполнил независимые unit/typecheck/lint/Vite bundle и последовательные Chrome/Edge с отдельным cache. Итог: File 5 и Export 3 пункта полностью доступны; 4/4 focused unit, Chrome 4/4, Edge 4/4 PASS. [Протокол и снимки](evidence/menu-visibility-2026-10-18/VERIFICATION.md). Исправление локально проверено; общий release gate не закрыт. Существующие audit/stage/CI изменения сохранены, версии/зависимости/desktop вне scope. Commit/push/deploy не выполнялись.

## Концертная площадка — dev.18, 2026-10-18

`concert_stage` (GPT-6 Luna Extra High): круглый пол, radial fade, Reflector, свет, renderer lifecycle и unit. `stage_controls`: Inspector/styles и шесть локализаций. `stage_verification`: реальные WebGL/browser-сценарии и отдельный стенд. Root: общие settings-контракты, Player/display/export wiring, debounce persistence, версия, независимое ревью и последовательная приёмка. После исчерпания квоты исполнителя browser-сценарии доведены root: правильный canvas locator, более плотные измерения открытого пола, проверка одинаковых кадров до сравнения движения, локальная favicon. Порог движения отражений учитывает физическое перекрытие корпусом; снимки и метрики сохраняются. Параллельные изменения пользователя не откатываются. [Результаты и ограничения](evidence/concert-stage-2026-10-18/VERIFICATION.md). Публикация не запрошена.

## Исправление четырёх дефектов аудита — 2026-10-18

Пользователь разрешил сохранить план и приступить. [План и критерии приёмки](AUDIT_REMEDIATION_PLAN.md). `repair_session` (GPT-6 Luna Extra High): bootstrap/open lifecycle, полный recovery snapshot и regression tests; первым владел App/PianoPlayer. `repair_playalong`: тайминг, voice identity и отмена аккомпанемента; callback wiring в PianoPlayer выполнен после явной передачи владения. `repair_waveform`: соответствие waveform позиции аудио, focused tests и настоящий browser canvas. Root проверил код, вернул на исправление teardown/readiness и ошибки browser harness, выполнил общие проверки и последовательную приёмку Chrome/Edge. Итог: 594 unit PASS, typecheck/lint/build PASS, 11 уникальных browser-сценариев подтверждены в Chrome focused прогонами и 11/11 в Edge. Из-за параллельных изменений и Vite reload browser evidence снят в отдельной локальной копии с собственным cache; functional code совпадает с checkout, различается только release description dev.17/dev.18. [Подробный протокол и границы](evidence/audit-remediation-2026-10-18/VERIFICATION.md). Четыре дефекта локально исправлены и проверены; общий release/roadmap gate не закрыт. Существующие изменения и параллельная сцена сохранены; desktop, зависимости, версии и goldens вне scope. Commit/push/deploy не выполнялись.

## Золотая надпись рояля — dev.17, 2026-10-18

После утверждения текста `grand_highway` (GPT-6 Luna Extra High) владел `pianoBranding3d.ts` и wiring в keyboard3dView. Root проверил интеграцию, уменьшил размер до сдержанной эмблемы через исправление исполнителю, владел browser-крупным планом и версиями. Общие файлы редактировались узко; появившиеся параллельные изменения App/sessionOperation, waveform и play-along сохраняются. [Протокол](evidence/piano-branding-2026-10-18/VERIFICATION.md). Commit/push/deploy не запрошены.

## Сглаживание корпуса — dev.16, 2026-10-18

`grand_highway` (GPT-6 Luna Extra High) подготовил helper creased normals и regression test; `grand_visual` (GPT-6 Luna Extra High) подготовил стенд крупного плана. После исчерпания квоты исполнителей root завершил wiring в production cheek/rim, отдельные крупные планы слева/справа, сравнение до/после и независимые проверки. Существующие dev.14–15 изменения сохранены. [Протокол](evidence/case-smoothing-2026-10-18/VERIFICATION.md). Commit/push/deploy не запрошены.

## Экран нот по контуру рояля — dev.15, 2026-10-18

`grand_highway` (GPT-6 Luna Extra High): общий контур корпуса, поверхность нот и ограничение нот по полосам клавиш; владеет render3d geometry files и focused unit tests. `grand_visual` (GPT-6 Luna Extra High): отдельный browser-spec/стенд с реальным WebGL. Root: версии, App/Player release description, документация, независимое ревью и последовательная приёмка Chrome/Edge. Существующие незакоммиченные CI/audio-исправления сохранены. Пройдены 20 render3d unit, реальный WebGL Chrome/Edge с четырьмя fixed-ракурсами, typecheck, lint, build; root вернул исполнителю и проверил исправление ошибки типов в новом regression test. [Результаты и границы](evidence/grand-highway-2026-10-18/VERIFICATION.md). Публикация не запрошена.

## Адаптация browser CI к 2D/3D — 2026-10-18

По запросу пользователя исправляем проверки `Verify studio`, сохраняя продуктовые функции и незавершённую параллельную локализацию. `ci_ui_specs` (GPT-6 Luna Extra High) владел UI-specs, `ci_specialized_specs` — Worker/audio/PWA/SoundFont-specs; `ci_test_review` независимо проверил предпосылки тестов. Root владеет общими helpers, интеграционными исправлениями, последовательными прогонами и протоколом. После исчерпания квоты исполнителей root завершает найденные интеграционные исправления. Пользовательский выпуск `4e51283` dev.13 включил первоначальную часть адаптации; текущие проверки и исправления строятся уже поверх него.

В тестах различаются видимая сцена и идентичность каждого renderer, явно задаётся пустой старт для импорта, проверяются Native и Python Worker, подтверждённые настройки IndexedDB и обработанная прокрутка перед выбором ноты. Обычные UI-сценарии используют настоящий synth/2D через интерфейс; отдельные проверки сохраняют default SF3 и реальный 3D. Goldens, допуски, skips/retries неизменны. Аудиоприёмка дополнительно выявила реальную гонку: Synth автоматически возобновлял suspended OfflineAudioContext при старте ноты, нарушая окна подготовки экспортёра. Root воспроизвёл её unit-тестом и browser repeat и ограничил auto-resume live-контекстом; версия повышена до dev.14. [Правила browser-проверок](../tests/browser/README.md), [фактическая приёмка](evidence/ci-adaptation-2026-10-18/VERIFICATION.md). Итоговый gate требует самостоятельного результата всех групп Chrome/Edge; локальная адаптация не объявляет GitHub CI зелёным. Commit/push/deploy в этом запросе не выполняются.

## Локализация интерфейса (i18n): EN, CS, UK, DE, ES, IT — 2026-10-18

По прямому указанию пользователя реализована мультиязычная локализация интерфейса:
- Исходный пул: Английский (`en`, English) и Чешский (`cs`, Čeština).
- Расширение пула: Украинский (`uk`, Українська), Немецкий (`de`, Deutsch), Испанский (`es`, Español) и Итальянский (`it`, Italiano).

Оркестратор разделил работу на специализированных исполнителей GPT-6 Luna Extra High:
1. `i18n_core`: Базовая типизированная архитектура i18n (`apps/client/src/i18n/`):
   - Контракты типов `TranslationDictionary`, `AppLanguage = "en" | "cs" | "uk" | "de" | "es" | "it"`, `I18nContextValue`.
   - Полные словари для английского (`locales/en.ts`) и чешского (`locales/cs.ts`) языков.
   - Автономный `getTranslation(lang, path, params)` с интерполяцией и fallback на английский.
   - Реактивный `I18nProvider` и хук `useI18n()` с реакцией на смену настроек.
   - Расширение `Settings` полем `language` с сохранением в IndexedDB и localStorage.
2. `i18n_settings_modals`: Локализация окон и настроек:
   - `SettingsModal.tsx`: селектор всех 6 языков в настройках, перевод всех вкладок (General, Audio, Engine, Storage).
   - `ProfileModal.tsx`, `BuiltinMelodiesDialog.tsx`, `VideoExportModal.tsx`.
3. `i18n_studio_player`: Локализация оболочки и плеера:
   - `StudioShell.tsx`, `StudioWorkspace.tsx`, `ProjectsPanel.tsx`, `PianoPlayer.tsx`, `FingeringToolbar.tsx`.
4. `i18n_uk_de`:
   - `locales/uk.ts`: полный украинский словарь (242 ключа: аплікатура, клавіатура, ліва/права рука, звуковий банк, вбудовані мелодії, експорт).
   - `locales/de.ts`: полный немецкий словарь (242 ключа: Fingersatz, Klaviatur, linke/rechte Hand, SoundFont, integrierte Melodien, Export).
5. `i18n_es_it`:
   - `locales/es.ts`: полный испанский словарь (242 ключа: digitación, teclado, mano izquierda/derecha, banco de sonidos, melodías integradas, exportación).
   - `locales/it.ts`: полный итальянский словарь (242 ключа: diteggiatura, tastiera, mano sinistra/destra, banco di suoni, brani integrati, esportazione).

Результаты верификации:
- 100% структурное соответствие (242/242 ключа во всех 6 языках), интерполяционные плейсхолдеры `{name}`, `{time}`, `{date}`, `{progress}` идентичны.
- `npm run test:unit`: 54 файла, 573 теста PASS (0 failures).
- `npm run typecheck`: PASS (0 ошибок).
- `npm run lint`: PASS (0 предупреждений/ошибок).
- `npm run build`: PASS (сборка релиза успешна).

## R3D-01–04 — dev.12, 2026-10-17

Номер повышен с dev.11 по прямому указанию пользователя: dev.11 уже опубликована им на GitHub. Существующие скриншоты/метрики остаются историческим свидетельством проверенного кода до переименования; новая сборка dev.12 проверяется отдельно.

База d5caa72, пользовательские исправления dev.10 сохранены. Три GPT-6 Luna Extra High: r3d_scene — pianoScene3d и отдельные regression tests (камера/manual export, пустой PerformancePlan); r3d_hover — handRigBuilder/render3d.test (непрерывный release); r3d_ui — StudioShell/styles/types и UI tests (адаптивная камера). Root владеет версиями/lockfile, App/Player release text, документацией, интеграционной и media/browser проверкой. Общие файлы имеют одного владельца. Новые модели и зависимости не входят. После реализации пользователь отдельно разрешил commit/push/deploy версии dev.12. Результаты: 556 unit, typecheck/lint/build, 13 numerical parity и независимые исходные repro PASS; реальный Chrome проверил четыре fixed-камеры, MP4/WebM, decode/audio/seek; 14 viewport measurements PASS после возврата UI на исправление. Edge и полный production-PWA/media CI остаются открыты. [Протокол dev.12](evidence/3d-repair-2026-10-17/VERIFICATION.md). Во время работы появился отдельный пользовательский коммит 74d0050; root commit/push/deploy не выполнял.

## Native full parity и локальный журнал — dev.9

Пользователь поручил довести Native до полного паритета и добавил ошибку неполного motion-window и запрос локального логирования. Три GPT-6 Luna Extra High: `native_hands_repair` владеет hands/geometry/pianist и геометрическими тестами; `native_api_repair` — API, Python compatibility, MIDI/fingering и строгими API-тестами; `native_acceptance` — новый реальный Worker parity browser suite. Root владеет журналом и его UI, Worker/Transport/Player интеграцией, CI, версиями/lockfile, независимой приёмкой и документацией. Существующие dirty изменения dev.8 сохранены. Goldens и допуски неизменяемы; никакого fixture-specific вывода или Python fallback. Commit/push/deploy не запрошены. Текущий результат фиксируется после freeze исходников.

## Native calculation repair — dev.8

После пользовательской самостоятельной доработки база заново прочитана: HEAD `7edd431`, дерево чистое. Три GPT-6 Luna Extra High: `native_hands_repair` — hands/geometry/pianist (изменён только hands); `native_api_repair` — API/MIDI/общая identity и тесты; `native_acceptance` — настоящий Worker browser spec. Root владеет Worker factory, Player/Inspector, export runtime snapshot, build/version/lockfile, независимой приёмкой и отчётом. Обнаруженные test-harness ошибки возвращаются в собственные проверки, численные goldens не меняются. [Результаты и открытые границы](DUAL_ENGINE_REVIEW.md). Коммиты/push/deploy не запрошены.

## Встроенный MuseScore General и SF3 — dev.7

Три GPT-6 Luna Extra High: `sf3_parser_provider` — SF3 RIFF/Ogg metadata, ограниченный decode/provider; `builtin_sf3_asset` — подтверждённый MIT source/provenance, генератор, loader, затем два browser-сценария; `fazioli_repair` — первичные источники/авторская версия и отдельная проверяемая копия без изменения оригинала. Root владеет synth SF3 channel semantics, Settings/Player/Transport, версиями/lockfile, build/PWA, существующими browser suites, docs и независимой приёмкой. Для SF2 reciprocal links остаются строгими, MuseScore SF3 zero-links читаются как независимые channel zones по SF3 RFC. Нет нового разрешения commit/push/deploy; исходники пользователя защищены.

## Встроенные мелодии — dev.6

По запросу пользователя подключается `builtin_melodies/midi/` (162 файла). GPT-6 Luna Extra High: `builtin_catalog_assets` — генератор/loader/unit; `builtin_catalog_ui` — каталог и ProjectsPanel. После их freeze `builtin_source_identity_repair`, затем `catalog_identity_finalize` исправляют обнаруженные полным контрактом identity/diagnostics/duplicate-motion ошибки. Оркестратор владеет App/Player/StudioShell, версиями/lockfile, build/offline-интеграцией и независимой браузерной приёмкой. Пользователь позднее разрешил commit/push/deploy после проверок. [Протокол dev.6](evidence/builtin-melodies-2026-10-16/VERIFICATION.md).

Дополнительный запрос: проверить все восемь локальных банков. `all_soundfont_banks` — parser/global generators и read-only metadata/PCM audit; `sf2_envelope_hardening` — synth/envelopes/loop defaults; `bank_browser_harness` — новый native acceptance spec. Root уточнил правила range/root-key по первичному SF2 spec, независимо выполняет финальные Chrome/Edge и сохраняет различие между рабочими банками, повреждённой стереоссылкой Fazioli и неподдерживаемым SF3. Три исполнителя одновременно не превышены; пользовательские банки не публикуются. [Протокол банков](evidence/user-soundfonts-2026-10-16/VERIFICATION.md).

## SF2 stereo/Blob цикл dev.5

Принят план поддержки связанных L/R PCM-сэмплов и входных банков до 1 GiB. Три GPT-6 Luna Extra High: `sf2_blob_storage` — парсер/Worker/hash/IndexedDB/Settings; `sf2_stereo_synth` — пары голосов/provider/output/factory; `sf2_export_checks` — снимок экспорта/offline/media. Оркестратор владеет общими контрактами, Transport/Player, hash-wasm/lockfile, версией dev.5 и независимой приёмкой. [Контракты, ограничения и статус](SOUNDFONT_STEREO_IMPLEMENTATION.md).

Дополнительный цикл по пользовательскому логу 16 октября: `motion_buffering_repair` исправил выбор первого пропуска и граничный continuation; root интегрировал адаптивный резерв и раннюю подкачку. `sf2_completion_repair` завершил per-channel cleanup/loop-state и независимо просмотрел Blob/provider/export. `sf2_native_acceptance_repair` исправил порядок IDB error/abort, повторное открытие video helper и после независимого сбоя реального банка снял лишнее требование одинаковых L/R lengths/loop offsets. Владение четырьмя parser/synth файлами было явно передано ему после freeze прежнего владельца. Root повторяет native-приёмку последовательно; все результаты и первоначальные неудачи зафиксированы в [отчёте dev.5](evidence/sf2-motion-2026-10-16/VERIFICATION.md). Коммит/push/deploy не выполняются.

## UI-цикл dev.4: меню команд и автопереход

Пользователь одобрил удаление второй строки инструментов: Undo/Redo в Edit, Keyboard shortcuts в Help (?), Auto-advance около пальцев в шапке. Исполнители GPT-6 Luna Extra High: `editor_commands_ui` владеет editor UI/Player/studio shell и их локальными интерфейсами; `editor_autoadvance` — editorState, команды, типы EditorAction и семантические unit-тесты. Оркестратор владеет npm manifests/lockfile (dev.4), browser-проверками, документацией и интеграционной приёмкой. Состояние сессии, история, Worker и canvas должны сохраняться. Результаты проверок записываются после интеграции.

Результат: 401 unit, typecheck/lint и project-path build PASS; Edge 13/13, Chrome 11 первоначальных PASS + 3/3 финальных focused. Независимая проверка выявила переполнение шапки при 900 px и закрытие нижней панели по Escape из справки; исполнитель исправил оба дефекта, повторные проверки прошли. Проверена доступность всех 88 клавиш через вертикальную прокрутку на 390×844. Версия синхронизирована до dev.4. [Полное свидетельство](evidence/editor-command-menus-2026-10-15/VERIFICATION.md).

Отдельный read-only исполнитель `pages_release` установил причину остановки Windows CI после прежнего исправления Python LF: autocrlf менял текстоподобную invalid MIDI fixture. Оркестратор добавил узкий `-text` атрибут и проверил SHA-256 в свежем autocrlf checkout. Содержимое fixture и эталоны не изменены; полный удалённый CI требует собственного результата.

## Цикл публикации GitHub Pages: 2026-10-15

Добавлен `.github/workflows/deploy-pages.yml` для push в `main` и ручного запуска. Build job устанавливает Node.js 24 и зависимости, выполняет `npm run typecheck`, `npm run lint`, `npm run test:unit`, затем `APP_BASE=/pianomotion-studio/ npm run build` и загружает `apps/client/dist/`. Полные Windows Chrome/Edge suites остаются в отдельном `verify.yml`; они не входят в Pages deploy gate.

Deploy job требует успешную сборку, ветку `main` и Actions variable репозитория `PAGES_ENABLED=true`. У него только `pages: write` и `id-token: write`; используется environment `github-pages`. При выключенном gate проверки и артефакт сборки всё ещё выполняются, публикация пропускается. Ручной запуск с другой ветки также не публикует сайт.

Итог на 2026-10-15: после явного разрешения пользователя репозиторий сделан публичным, GitHub Pages включён, а `PAGES_ENABLED=true`. Deployment run [38762695870](https://github.com/shafranek-js/pianomotion-studio/actions/runs/38762695870) успешно собрал сайт за 38 секунд и выполнил deploy за 50 секунд на commit `07cae1c`; опубликованный адрес — https://shafranek-js.github.io/pianomotion-studio/. Первая попытка настройки Pages до смены видимости получила HTTP 422 из-за плана private-репозитория; этот отказ сохранён как исторический.

Отдельный Verify run [38744216820](https://github.com/shafranek-js/pianomotion-studio/actions/runs/38744216820) завершился одинаково в Chrome и Edge на первом шаге `Python Core and Frozen Goldens`: SHA-256 `handthesia_core/__init__.py` был другим после Windows CRLF checkout. CRLF bytes дают именно хэш из лога, тогда как Git blob и manifest используют LF. Добавлен `.gitattributes` с LF для `python-core/handthesia_core/*.py`. CI rerun после этой правки ожидается; прежний run остановился до typecheck, lint, unit, build и browser suites и не является результатом этих проверок.

## UI-цикл 2026-10-15: назначения в верхней панели

По запросу пользователя переносим только группу назначений руки/пальцев/Clear/Unplayable/Gliss в header, видимую в Fingering. Исполнитель `fingering_header` — GPT-6 Luna Extra High; область записи: editor toolbar/editor, Player и studio shell/styles. На этот цикл Player делегирован этому единственному исполнителю. Оркестратор обновляет версии до dev.3, документацию и browser-сценарии, независимо проверяет адаптивность и сохранение истории. Общие зависимости и lockfile остаются у оркестратора. Результаты проверки фиксируются после интеграции; прежняя приёмка аудита не заменяет проверку этого UI.

Сдача dev.3: исправлены замечания интеграционного ревью к ширинам колонок и выравниванию вспомогательных команд. Независимые проверки: 25 unit; Chrome 11 + дополнительный responsive + финальные 2; Edge 11; typecheck, scoped lint/build/diff-check PASS. Проверены шесть стандартных окон и четыре граничные ширины, просмотрены финальные скриншоты. [Точные результаты](evidence/fingering-header-2026-10-15/VERIFICATION.md). Коммит/push/deploy не выполнялись.

## Активный цикл 2026-10-15: R01–R14

План пользователя принят к исполнению. Текущее распределение файлов и результаты находятся в [AUDIT_REPAIR_PROGRESS.md](./AUDIT_REPAIR_PROGRESS.md). Исторические gates ниже не являются приёмкой этого ремонта. Общие App/Player, contracts и зависимости принадлежат оркестратору; исполнители repair_motion, repair_audio и repair_pwa работают в непересекающихся областях.

Начало: 2026-10-13.

Пользователь назначил основного агента оркестратором и указал модель исполнителей: GPT-6 Luna, reasoning effort Extra High (`gpt-6-luna`, `xhigh`). Основной агент формулирует задания, координирует изменения, проверяет доказательства и возвращает обнаруженные дефекты на исправление. Итог subagent не равен приёмке.

## Исторический цикл: стабилизация интеграции M1–M5

Актуальные доказательства и ограничения: [stabilization-2026-10-13.md](evidence/stabilization-2026-10-13.md). После аудита пользователь разрешил исправить перепланирование, историю редактора, восстановление аудио, применение профилей/настроек и сохранение исходных байтов/сессии. Исполнители: `stabilize_editor_engine`, `stabilize_storage_profiles`, `stabilize_audio_render` — GPT-6 Luna Extra High. Основной агент интегрировал Player/App, проверил реальные Worker/экспорт/reload и возвращал выявленные дефекты исполнителям.

Совместный прогон после интеграции: 223 unit-теста, 22 browser-теста, 13 фикстур с нулевыми расхождениями, typecheck/lint/build PASS. При просмотре production-скриншота дополнительно выявлено и исправлено искажение cartoon-руки. Итог: 226 unit-тестов,24 skin-теста внутри этого набора, повторные4/4 browser-проверки, typecheck/lint и compiled production smoke PASS. Основной агент просмотрел реальные изображения; клиппинг ладони/запястья и непрерывные касания остаются открытой визуальной приёмкой.

Следующие разделы сохраняют исторические результаты M1–M5. Заголовки «Gate закрыт» описывают прежние решения по реализации и не закрывают выявленные позднее ограничения. W020 (непрерывные позы/lookahead), физический контакт пальцев с клавишами, Worker/WASM memory и нагрузка на слабых устройствах остаются открытыми. Полная приёмка плеера и публичного релиза не объявлена.

## Принятый цикл: M6 & W020 (Gate G6 закрыт)

Scope: W020, W039–W044, непрерывный буфер поз, кадрирование ладони, процедурные скины рук, внешние аудиодорожки и сквозная синхронизация.
- Кадрирование ладони и сукно (W020): функция `computeBottomLayout` устранила обрезку запястий и предплечья за счёт расчёта области рук `handH` (до 7.0x ширины белой клавиши) и планки красного сукна (`FELT_H = 6`). 5/5 тестов в `bottomLayout.test.ts`.
- Скользящий буфер поз и физический контакт (W020): `MotionBuffer` с упреждением 4.0s и сбросом при перемотке; функция `sample_motion_window` в Python-core с кэшированием сессий и обработчик в Worker; валидация касания клавиш ($z \le 0.1$, $x$ внутри клавиши). 11/11 тестов в `motionBuffer.test.ts`, 4/4 в `test_motion_window.py`.
- Процедурные скины рук (W039): 4 стиля (`cartoon`, `gloves`, `robot`, `skeleton`) и направленные тени с ослаблением по глубине $z$. 24/24 тестов в `skins.test.ts`.
- Внешние аудиодорожки и синхронизация (W040, W041): декодирование `.wav`, `.mp3`, `.ogg`, `.flac`, 5ms пики, интерактивный холст `WaveformCanvas` со сдвигом смещения. 29/29 тестов в `recording.test.ts`.
- Выходные аудио-движки (W042, W043): интеграция селектора SoundFont / Web MIDI в `SettingsModal` и быстрые действия плеера.
- Сквозная приёмка Playwright (W044): тест `skins-audio-m6.spec.ts` (PASS, 14.9s) подтвердил переключение скинов, управление тенями, загрузку аудио-трека и рендеринг формы волны без ошибок браузера. Отчёт: `docs/evidence/m6-skins-audio-2026-10-13.md`.

| Исполнитель | Задачи | Область записи | Статус |
|---|---|---|---|
| m6_skins | W039 | apps/client/src/render/skins/, skins.test.ts, handsView.ts | Завершено (24/24 тестов PASS) |
| m6_audio | W040, W041 | apps/client/src/audio/recording/, waveform/, recording.test.ts | Завершено (29/29 тестов PASS) |
| w020_motion_sampling | W020 (Python core, Worker) | python-core/api.py, test_motion_window.py, workers/ | Завершено (4/4 CPython PASS) |
| w020_motion_buffer | W020 (MotionBuffer, contact) | render/motionBuffer.ts, motionBuffer.test.ts, pianoScene.ts | Завершено (11/11 тестов PASS) |
| Основной агент | Кадрирование, интеграция Player/UI, E2E spec, G6 | player/PianoPlayer.tsx, SettingsModal.tsx, skins-audio-m6.spec.ts | **Gate G6 закрыт** |

## Исторический цикл: M5 (ранее заявлен Gate G5)

Scope: W034–W038, профили пианиста, настройки приложения, миграция IndexedDB v2 и автоматическое сохранение (autosave).
- Канонические профили пианистов (W034): `default` (канонический десктоп), `small-hands` (юношеские/малые руки, 0.75x–0.85x кости, пониженная растяжка, темп 2.2), `virtuoso` (увеличенный размах 1.25x кости, растяжка +0.7, темп 4.5), `left-dominant` (доминирование левой руки). Полная валидация Zod `PianistProfileSchema`.
- Настройки приложения (W035): реактивное хранилище `SettingsStore` с сохранением в `localStorage` (`handthesia:settings`), поддержка стилей клавиш, тембра синтезатора, ограничения частоты кадров (FPS cap 30/60/120/vsync), оверлея FPS и визуальных подсказок нот/пальцев.
- Импорт и экспорт профилей (W036): безопасный разбор legacy JSON десктопного формата из `pianists/*.json` с заполнением дефолтных значений, санитаризацией прототипа (`__proto__`) и проверкой положительных длин костей. Клонирование, редактирование анатомических слайдеров и защита канонического профиля от удаления.
- Миграция хранилища IndexedDB v2 (W037): бесшовная миграция с версии 1 на 2 с сохранением проектов и добавлением хранилищ `profiles`, `settings` и `session`. Изоляция ошибок квоты (`StorageQuotaExceededError`).
- Дебаунсинг и восстановление сессии (W038): сервис `AutosaveService` с дебаунсом 400 мс для сохранения снимков сессии (`SessionSnapshot`), оценка доступной квоты через `navigator.storage.estimate()`. Модальные окна `ProfileModal` и `SettingsModal` с доступным управлением и предпросмотром.
- Сквозная приёмка Playwright (W038): тест `profiles-m5.spec.ts` успешно подтвердил переключение профилей, смену настроек, клонирование профиля и автосохранение снимка сессии в IndexedDB. 19/19 браузерных тестов PASS. Отчёт: `docs/evidence/m5-profiles-2026-10-13.md`.

| Исполнитель | Задачи | Область записи | Статус |
|---|---|---|---|
| m5_profiles | W034, W036 | apps/client/src/profiles/ | Завершено (21/21 тестов PASS) |
| m5_storage_settings | W035, W037, W038 | apps/client/src/settings/, apps/client/src/storage/ | Завершено (15/15 тестов PASS) |
| Основной агент | W038 (UI модалы ProfileModal/SettingsModal, E2E spec, G5) | apps/client/src/player/, tests/browser/profiles-m5.spec.ts | **Gate G5 закрыт** |

## Принятый цикл: M4 (Gate G4 закрыт)

Scope: W028–W033, редактор аппликатуры, плотный интерфейс (Dense UI), расчёт эргономики/сложности и сквозной E2E.
- Интерактивный Piano Roll на Canvas 2D (W028): горизонтальный ролл на 88 клавиш (A0..C8) с фоновой разметкой клавиш, time grid, зумом с центрированием на курсоре (40..600 px/s), панорамированием, отсечением невидимых нот (viewport culling) для масштабирования на 10k+ нот со стабильными 60 FPS, хит-тестированием и выделением рамкой (marquee).
- Командный паттерн и история правок (W029, W030): чистые команды назначения рук (L/R), пальцев (1..5), переключения глиссандо и очистки. Стек отмены/повтора на 50 шагов (undo/redo), режим последовательного шагового ввода (step-entry mode) и горячие клавиши.
- Диагностика и сложность (W031): расчёт эргономических метрик (растяжка, темп нот/с, скрещивания, неудобные переходы), оценка сложности (1..10) и грейд (Beginner..Virtuoso). Панель диагностики с быстрым переходом к проблемным нотам.
- Дебаунсинг и перепланирование Pyodide (W032): фоновый перерасчёт PerformancePlan и MotionPlan с задержкой 300 мс и защитой от устаревших ревизий.
- Интеграция режимов отображения (W033): вкладки Performance, Fingering Editor и Split View (одновременный показ PixiJS анимации и Canvas редактора аппликатуры с синхронизированным плейхедом).
- Сквозная приёмка Playwright (W033): тест `editor-m4.spec.ts` успешно прошёл полный пользовательский сценарий (выбор, редактирование, отмена/повтор, метрики сложности, сплит-режим, скачивание экспортированного MIDI). Отчёт: `docs/evidence/m4-editor-2026-10-13.md`.

| Исполнитель | Задачи | Область записи | Статус |
|---|---|---|---|
| m4_canvas | W028 | apps/client/src/editor/pianoRollCanvas.ts, pianoRollView.ts, pianoRoll.test.ts | Завершено (17/17 тестов PASS) |
| m4_editor_ui | W029–W032 | apps/client/src/editor/commands.ts, editorState.ts, difficulty.ts, DiagnosticsPanel.tsx, FingeringToolbar.tsx, editor.test.ts | Завершено (17/17 тестов PASS) |
| Основной агент | W032 (интеграция моста Pyodide), W033 (Split View, E2E spec, G4) | apps/client/src/editor/FingeringEditor.tsx, player/PianoPlayer.tsx, tests/browser/editor-m4.spec.ts | **Gate G4 закрыт** |

## Принятый цикл: M3 (Gate G3 закрыт)

Scope: W023–W027, музыкальная логика, кинематические инварианты и экспорт с маркерами.
- Экспорт fingered MIDI (`.mid`) и PIG (`.txt`): реализованы `_encode`, `save_fingered_midi_bytes` (встраивание meta text events R1..R5, L1..L5, Rg, Lg; разделение каналов RH/LH; широковещательная рассылка CC), `read_pig_text`, `save_pig_text`, `export_fingered_midi`. Python unit tests в `test_export.py` подтвердили 100% сохранение назначений рук/пальцев и круглый цикл. Интегрирована кнопка «⬇ Export Fingered MIDI (.mid)» в веб-плеере через Web Worker Pyodide.
- Паритет кинематики и музыкальной логики (W023, W024, W025, W027): 10/10 тестов в `tests/unit/m3-logic-parity.test.ts` подтверждают:
  - Приоритет названий треков («Right Hand» / «Left Hand») над регистром нот.
  - Сохранение канонической аппликатуры гамм и октав (Hanon C-dur 1-2-3-1-2-3-4-5).
  - Смещение времени взятия нот в широких аккордах (rolled chord) при превышении физического размаха руки.
  - Раннее снятие нот (early release) при превышении максимальной скорости пианиста.
  - Корректность `layerOrder` при скрещивании рук (перекрещивающаяся рука сверху).
  - Учёт глиссандо без дискретного перебора пальцев.
  - Детерминизм seek и lookahead (совпадение поз при перемотке и непрерывном воспроизведении).
- Отчёт: `docs/evidence/m3-logic-evidence.md`.

| Исполнитель | Задачи | Область записи | Статус |
|---|---|---|---|
| m3_export | W026 | python-core/midi_loader.py, api.py, test_export.py | Завершено (экспорт MIDI/PIG с маркерами, 100% roundtrip) |
| m3_logic_parity | W023–W025, W027 | tests/unit/m3-logic-parity.test.ts, evidence/m3-logic-evidence.md | Завершено (10/10 тестов PASS) |
| Основной агент | W026 (интеграция UI/Worker), G3 приёмка | packages/contracts, workers/, player/, App.tsx | **Gate G3 закрыт** |

## Принятый цикл: M2 (Gate G2 закрыт)

Scope: W015–W022, вертикальный браузерный MVP. Реализованы рендеринг PixiJS (88 клавиш, падающие ноты, скелетные руки), Web Audio синтез и транспорт с упреждением, сохранение в IndexedDB и drag-and-drop. Сквозной тест `player-m2.spec.ts` пройден. Отчёт: `docs/evidence/m2-vertical-player-2026-10-13.md`.

| Исполнитель | Задачи | Область записи | Статус |
|---|---|---|---|
| m2_audio | W018, W019 | apps/client/src/audio/ | Завершено (Web Audio семплер, транспорт, 17/17 тестов PASS) |
| m2_render | W016, W017, W020 | apps/client/src/render/ | Завершено (PixiJS клавиатура, падающие ноты, скелетные руки) |
| m2_storage | W015, W021 | apps/client/src/storage/ | Завершено (IndexedDB, экспорт пакета, 23/23 тестов PASS) |
| Основной агент | W022, интеграция, G2 | apps/client/src/player/, App.tsx, player-m2.spec.ts | **Gate G2 закрыт** (вертикальный MVP подтверждён) |

## Принятый цикл: M1 (Gate G1 закрыт)

Scope: W008–W014, проверка фактического Python-ядра в браузере. Выполнена полная браузерная верификация всех 13 фикстур с нулевыми расхождениями (0 parity differences). Проверены жизненный цикл Web Worker, отмена задач и обработка невалидного MIDI. Зафиксировано ADR-002.

| Исполнитель | Задачи | Область записи | Статус |
|---|---|---|---|
| m1_core | W008–W010 | python-core, package-python-core tool, public/python-core, evidence/m1-core | Завершено (паритет подтверждён) |
| m1_worker | W011, W013 | Client/Worker, runtime packaging, npm manifests/lock, worker browser tests, evidence/m1-worker | Завершено (жизненный цикл и отмена подтверждены) |
| m1_verification | W012, W014, protocol | Отдельные M1 schemas, parity tools/tests, fixtures staging, ADR-002, evidence/m1-* | Завершено (16/16 тестов PASS, 0 расхождений) |
| Основной агент | Координация, review, G1 decision | Этот журнал, roadmap/README, acceptance evidence | **Gate G1 закрыт** (решение: продолжить с Pyodide) |

Все subagents созданы на GPT-6 Luna Extra High. Только m1_worker устанавливает npm-пакеты и меняет lockfile. CPython core checks выполняются в изолированной среде; активная desktop `.venv` не изменяется. M0 goldens сохраняются.

Согласованный batch API: `handthesia_core.api.analyze_midi(data: bytes, options: dict) -> dict`. Protocol identity: requestId/projectId/revision/engineVersion; optional profile передаётся через options. Результат: loaded/repaired/invalid, document, fingeringPlan, performancePlan, motionPlan, resolved profile, resource, diagnostics и rawBaseline для сравнения с desktop. Invalid/rejected raw status сохраняется внутри rawBaseline.

Pyodide: точный runtime 314.0.7; планируется self-hosting pinned runtime/catalog/wheels, без CDN latest или PyPI resolution во время анализа. Pyodide NumPy 2.4.6 отличается от desktop NumPy 2.5.4; пригодность определяется реальным parity, а не объявлением совместимости.

В M1 проверяются serial execution, A/B/A profiles, progress/error/cancel/restart, stale response filtering, все 13 fixture inputs и numerical pose comparison. Weak/mobile hardware отсутствует: реальные результаты текущего ПК и возможная симуляция обозначаются отдельно. W014 и G1 не закрываются как полный hardware acceptance при отсутствующей проверке слабого устройства.

Известная metadata неточность M0: golden snapshots содержат raw pose coordinates, но их старый coordinateFrame описывает y как screen-down. Фактическая mathematical y направлена от пианиста; projection `screenY = frontY - rawY`. Числа golden остаются эталоном, преобразование берётся из ADR-001. Молча изменять oracle запрещено.

## Принятый цикл: M0

Scope: W001–W007 из [roadmap](../../docs/WEB_MIGRATION_ROADMAP.md). Создание структуры веб-проекта, desktop baseline/golden fixtures, контракты, лицензии и профиль проверки. **G0 принят для локального продолжения M1**; [отчёт приёмки](evidence/g0-review-2026-10-13.md). M1 и пользовательский player пока не начаты.

| Исполнитель | Задачи | Область записи | Статус |
|---|---|---|---|
| web_bootstrap | W002 | web/package*, configs, .gitignore, apps/client, tests/browser, evidence/bootstrap | Bootstrap принят; player не реализован |
| desktop_baseline | W001, W004, W005 | web/tools, tests/fixtures, evidence/baseline* | Baseline принят; independent QA 24/24 PASS |
| contracts_review | W003, W006, W007 | web/packages/contracts, ADR-001, evidence/contracts/licenses/performance-profile | Принято в scope M0; ограничения release/performance сохранены |
| Основной агент | Координация и приёмка G0 | Этот журнал, roadmap status, web/README; контроль интеграции | G0 принят; dev-сервер оставлен пользователю |

Все исполнители работают в общем checkout с раздельными областями записи. Только web_bootstrap устанавливает npm-пакеты и обновляет lockfile; установка начинается после готовности workspace manifests. Desktop baseline использует отдельное тестовое окружение, не активную `.venv`.

## Защищённые материалы

- Корневые Python-модули, desktop tests, version.py, CHANGELOG.md.
- Активное приложение и его `.venv`, пользовательские pianists/settings, внешние MIDI/аудио.
- Существующие изменения других задач. Нельзя reset/clean/stage/commit/push/deploy в рамках M0.
- Нельзя объявлять Pyodide совместимым, пока M1 не выполнит реальные browser checks.

## Приёмка

1. Исполнитель сдаёт файлы, реальные команды и exact totals, ограничения и известные ошибки.
2. Основной агент читает изменения и проверяет ключевые сценарии/интеграцию; не дублирует дорогое тестирование без причины.
3. Дефекты оформляются конкретным заданием: файл/сценарий, наблюдаемая проблема, ожидаемый результат, проверка исправления.
4. Gate G0 закрывается только после проверки baseline, контрактов и bootstrap. Лицензионные ограничения публичного выпуска фиксируются отдельно.
5. Статусы Verified/Tested/Proposed/Unknown не смешиваются. Прохождение bootstrap не является готовым player или полной браузерной приёмкой.

## Проверки основного агента

Handoffs получены. Проверено содержимое desktop pytest log: 148 passed, 0 failed, 0 skipped, 40.64 s, отдельное окружение. Полный suite повторно не запускался.

Предварительная независимая проверка golden index: 13 сценариев, 11 loader-loaded и 2 loader-rejected; 825 нормализованных нот, 59 первоначальных sampled poses. Хеши MIDI/golden, уникальность нормализованных ID и ссылки assignments/performance не имеют ошибок. Исполнитель расширяет pose snapshots; итоговые counts и reproducibility ещё подлежат сдаче.

Итоговый baseline после расширения: 13 inputs (10 loaded, 1 repaired, 2 rejected), 827 decoded source notes, 826 normalized notes, 79 sampled poses. Root повторно проверил хеши MIDI/golden/generator, ID, ссылки результатов и наличие полного skeleton: 0 ошибок. Авторский reproducibility check: PASS, 15 output artifacts. Исходная active `.venv` не изменена.

Bootstrap: typecheck, lint и production build PASS; Chromium smoke 1/1 PASS. Root просмотрел screenshot 1365×900. Клиент ясно обозначает отсутствие player. После дополнительных правок контрактов focused typecheck/ESLint PASS и 12/12 unit tests PASS; прежний bootstrap-wide unit run был 11/11. Build/browser не повторялись для контрактного изменения, поскольку UI не импортирует этот пакет; полнота исправлений проверяется отдельными probes.

W006: actual lock inventory содержит 243 package records, 19 direct names; 2 Unknown записи — собственные private workspaces без declared license. Условия исходного Python-кода и будущих семплов остаются отдельно unresolved для публичной поставки. W007: current reference machine описана, числовые цели Proposed; performance и weak/mobile device Unknown.

## Возвращённые на исправление дефекты

| ID | Исполнитель | Причина | Ожидаемая проверка | Статус |
|---|---|---|---|---|
| R001 | web_bootstrap | typecheck охватывал только клиент | Проверка client + contracts + configs | Исправлено и проверено |
| R002 | web_bootstrap | Playwright мог переиспользовать stale server | reuseExistingServer=false, запуск текущего checkout | Исправлено и проверено |
| R003 | contracts_review | Неверные Zod strict/extend/discriminator конструкции | Реальный typecheck и runtime tests валидных/невалидных DTO | Исправлено и проверено |
| R004 | contracts_review | Неполные проверки связанных планов/revision/profile/engine | Cross-reference tests и response-for-request validation | Исправлено; identity/link probes пройдены |
| R005 | contracts_review | Test ожидал release без preceding press; pose не содержал crossing layer | Исправленный event-order fixture; typed layer | Исправлено; допускаются equal layers вне crossing |
| R006 | desktop_baseline | Snapshot только tips/wrist/counts; нет полного skeleton/layer reference | bones/joints/units и paired crossing samples; regenerate + check | Исправлено и проверено |
| R007 | desktop_baseline | source note ordinal назывался raw SMF event ID | Точная provenance terminology; loader loaded != playable UI | Исправлено и проверено |
| R008 | contracts_review | License inventory не охватывал client и lock graph | Все workspace direct deps и actual locked transitive metadata | Инвентаризация завершена; public-release условия отдельно |
| R009 | contracts_review | Explicit gliss run мог получить обычные played fingers | Двухнотный explicit run и solitary mark; autodetection deferred | Исправлено; independent probes PASS |
| R010 | contracts_review | Рука в assignments могла противоречить нормализованной ноте | Context validation source hand и regression probe | Исправлено; independent probes PASS |
| R011 | contracts_review | Performance мог добавлять/пропускать педали | Threshold/change-only pedal sequence comparison | Исправлено; independent probes PASS |

## Dev-сервер

По запросу пользователя запущен из `web/`: `node node_modules/vite/bin/vite.js --config apps/client/vite.config.ts --host 127.0.0.1 --port 5175 --strictPort`.

- URL: http://127.0.0.1:5175/.
- Exec session: `57841`; оставлен работающим для пользователя.
- Проверены HTTP 200, title `Hand-thesia Web · Bootstrap` и actual `/src/App.tsx` текущего checkout.
- Тесты используют отдельный порт 4173; не останавливать пользовательский dev-сервер в QA/cleanup.

## Наблюдаемое поведение desktop для дальнейших этапов

- B001: совпадающие исходные ноты могут объединяться; маркеры аппликатуры на `(tick,pitch)` не сохраняют различие треков. Это отражается в baseline как identity loss, а не скрывается.
- B002: аккорд с шестью нотами в одной руке может иметь `finger=null`; соответствующая нота не попадает в фактическое performance. Контракт должен выражать `unplayable`, сохраняя исходную музыку.
- Названия треков имеют приоритет в выборе руки; не совпадающее с регистром название — существующая политика, а не изменение этого цикла.

Эти наблюдения не означают внесённых исправлений desktop. Изменение музыкальной семантики отделяется от задачи переноса и требует явного решения/fixture expectations.


## Верхняя панель (Header Layout & Typography)

- В `apps/client/src/studio/studio.css` верхняя панель `.studio-header` переведена в строго однорядный flex-режим (`display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; height: 34px`).
- Устранены многострочные CSS-сетки (`grid-template-rows: 56px auto` и `grid-template-rows: 56px 44px auto`), ранее принудительно переносившие элементы аппликатуры и `Auto-advance` на вторую и третью строки на экранах $\le 1899\text{px}$ и $\le 1199\text{px}$.
- Унифицирован размер всех шрифтов и элементов в панели до единого значения `11px` (включая логотип, пункты меню, название проекта, переключатель видов, кнопки аппликатуры, индикатор сохранения и экспорт).
- Кнопки компактно масштабированы до высоты 22–24px, кнопки пальцев — до 20px, без нарушения кликабельности и доступности.
- Исправлен `handAssignment` в `en.ts` ("Hand selection") и `FingeringToolbar.tsx` для сохранения полной совместимости с локализацией и тестами.
- Проведено полное тестирование: 54 тестовых файла (573 теста) успешно пройдены, typecheck — 0 ошибок, lint — 0 предупреждений, production build собран успешно.

## 2026-10-22 — playback startup freeze

- Request: reproduce and fix notes stopping at the keyboard before the music starts.
- Implementation owner: `/root/fix_startup_freeze`, GPT-6 Luna, xhigh; no nested agents.
- Write scope: player motion policy/PianoPlayer, transport/render only if needed, focused playback regression tests. Existing audio recording/locale edits belong to another task and must be preserved.
- Acceptance: reproduce before fix, retain audio/visual clock synchronization and buffering safety, check preparation cancellation, focused regression and browser evidence; root reviews integration.
- Outcome: no confirmed production fix. On 2026-10-22 the user reported the pause no longer occurs after restarting the app. Confirmed actual Chrome settings: included MuseScore General, native TS engine, 3D Pianist POV, 60 FPS, -2 s lead-in.
- Evidence: cold Chrome/SoundFont/3D capture showed main-thread long tasks up to 1.869 s but no motion-buffer or transport pause during playback. CPU profiles show expensive cold WebGL program setup; subsequent playback and a cold/warm audio-clock comparison did not reproduce the prolonged onset freeze. These observations do not establish the exact cause of the original symptom.
- Artifacts (ignored QA output): `test-results/cold-root.json`, `cold-root-startup.cpuprofile`, `cold-root-playback.cpuprofile`, `cold-clock.json`. Temporary diagnostic-only browser test was removed; original motion tests are unchanged. No playback source changes; unrelated concurrent work preserved. Root-owned test server on port 4292 stopped; user's app tabs and settings preserved.
- Follow-up if it recurs: capture the application's diagnostics immediately after the first affected Play before reloading, then correlate transport/motion events with frame/audio timing. No commit/push/deploy performed.
