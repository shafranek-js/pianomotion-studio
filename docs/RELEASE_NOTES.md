# PianoMotion Studio — Release Notes

## 0.1.0-dev.22 — Practice A-B and bookmarks, 2026-10-18

- Studio включает панель Practice с повтором выбранного участка A/B, синхронным для обычного воспроизведения и PlayAlong.
- Именованные закладки времени сохраняются и восстанавливаются; JSON-перенос привязывает их к SHA исходного MIDI, чтобы не переносить позиции на другой источник.
- Исправления меню и библиотеки мелодий, а также накопленные улучшения 3D-сцены сохранены.
- [Проверки и ограничения](evidence/practice-stage2-2026-10-18/VERIFICATION.md). Публикация здесь не подтверждается.

## 0.1.0-dev.21 — Soft active-note glow, 2026-10-18

- Проигрываемые 3D-блоки получили мягкий ореол: синий для левой руки, зелёный для правой. Свет плавно появляется и затухает в пределах времени ноты, восстанавливается после seek и ограничен внутренним контуром рояля.
- Сатиновая поверхность, цвета нот и клавиш, музыкальные данные и транспорт сохранены. Отдельный postprocess bloom и новые настройки не добавлены; эффект общий для live и fixed/manual сцены.
- [Проверки и ограничения](evidence/active-note-glow-2026-10-18/VERIFICATION.md). Версия обновлена; commit/push/deploy не выполнялись.

## 0.1.0-dev.20 — Softer note-surface highlights, 2026-10-18

- Поверхность экрана нот стала более шероховатой и менее глянцевой: блики мягче и слабее, ноты сохраняют зрительный приоритет. Освещение сцены и материалы корпуса/клавиш/нот не менялись.
- Исправление общее для live и fixed/manual сцены, без новых настроек или изменения музыкальных данных. [Сравнение и проверки](evidence/note-surface-2026-10-18/VERIFICATION.md). Версия обновлена; commit/push/deploy не выполнялись.

## 0.1.0-dev.19 — Scattered stage light, 2026-10-18

- В Concert добавлены мягкий голубой столб света за инструментом и широкое свечение у краёв круглой площадки, с плавным исчезновением наружу. Studio сохраняет нейтральное окружение.
- Эффект использует существующие brightness/quality: две или три заранее созданные световые оболочки, без дополнительного postprocess-прохода. Отражения, ноты, все клавиши, музыкальная ревизия и история редактора сохраняются.
- Световая геометрия не перехватывает указатель и не пишет глубину; в отражении исключается её повторное наложение. Fixed/manual render остаётся детерминированным.
- Первая визуальная итерация с чёткими конусными границами отклонена и смягчена. [Проверки и ограничения](evidence/stage-atmosphere-2026-10-18/VERIFICATION.md). Версия синхронизирована; commit/push/deploy не выполнялись.

## 0.1.0-dev.18 — Concert stage, 2026-10-18

- Круглый графитовый деревянный пол плавно исчезает на внешних 30% радиуса. Настоящее planar-отражение сцены размывается и затухает вместе с полом; отражённая геометрия не дублируется вручную.
- Concert: тёплый основной свет, холодный контровой и синее пятно за роялем. Studio: более нейтральный свет. Inspector → Scene содержит пресет, яркость, силу отражения и качество; подписи добавлены во все шесть языков.
- Качество ограничивает отдельную текстуру отражения: Low 256², Auto 256² на узком viewport / 512² на широком, High 1024². Нулевая сила отключает проход отражения. Только один основной источник строит shadow map.
- Предпочтения локальные, мигрируются со старыми настройками и входят в неизменяемый снимок экспорта. Сцена fixed/manual сохраняет resolution=1 и явный render. Музыкальная ревизия и Worker при настройке света не меняются.
- Версии manifests/lockfile и release details синхронизированы. [Протокол и ограничения](evidence/concert-stage-2026-10-18/VERIFICATION.md). Commit/push/deploy не выполнялись.

## 0.1.0-dev.17 — Gold piano wordmark, 2026-10-18

- На переднем фартухе — утверждённые золотые serif-буквы PIANOMOTION и меньшая строка CONCERT GRAND. Прозрачный фон, локальная текстура и физический золотой материал; сетевые шрифты не требуются.
- Надпись общая для live и fixed/manual 3D-сцены, её GPU-ресурсы освобождаются вместе с корпусом. Предыдущие исправления формы и сглаживания сохранены.
- Workspace manifests, lockfile и release details синхронизированы. [Проверки и ограничения](evidence/piano-branding-2026-10-18/VERIFICATION.md). Публикация не выполнялась.

## 0.1.0-dev.16 — Smooth grand piano casing, 2026-10-18

- Изгибы боковин и борта разбиты на более мелкие сегменты; фаски получили дополнительную детализацию.
- Нормали непрерывных поверхностей сглаживаются с порогом 30°, острые стыки остаются чёткими. Устранены плоские поперечные полосы блика на боковинах.
- Добавлены regression для нормалей и одинаковые крупные планы до/после. [Проверки и ограничения](evidence/case-smoothing-2026-10-18/VERIFICATION.md).
- Версии workspace/lockfile и release details синхронизированы; публикация не выполнялась.

## 0.1.0-dev.15 — Curved grand piano note surface, 2026-10-18

- Экран нот заполняет внутренний контур рояля вместо прямоугольника. Поверхность и корпус используют общую геометрию; выступающие за изогнутый борт участки исключены.
- Длина видимых нот ограничивается контуром для каждой клавиши; время движения и точка подхода к клавиатуре сохраняются.
- Версии workspace manifests, lockfile и release details синхронизированы. 20 render3d unit, WebGL Chrome/Edge, typecheck/lint/build прошли; [точный протокол и ограничения](evidence/grand-highway-2026-10-18/VERIFICATION.md). Публикация в этот цикл не входит.

## 0.1.0-dev.14 — Browser CI and SoundFont offline clock, 2026-10-18

- Browser-сценарии различают сохраняемые 2D/3D canvas, пустой старт и восстановление; фиксируют эталонный профиль для Python goldens и ждут обработанную прокрутку перед выбором ноты.
- Проверки IndexedDB используют валидный SF2 и действующий store метаданных; явно подтверждают success перед abort и откат записи/удаления.
- Исправлен реальный сбой offline SF2: старт голоса больше не вызывает `resume()` у `OfflineAudioContext`. Его временем и паузами подготовки управляет экспортёр; live AudioContext продолжает автоматически возобновляться.
- Отчёты и оставшийся gate полного CI: [протокол](evidence/ci-adaptation-2026-10-18/VERIFICATION.md). Commit/push/deploy в этот цикл не выполнялись.

## 0.1.0-dev.13 — Internationalization, header layout unification, and editor undo stabilization, 2026-10-18

- Добавлена полная локализация интерфейса (i18n): английский (en), чешский (cs), украинский (uk), немецкий (de), испанский (es), итальянский (it) с музыкальной терминологией и переключателем в настройках.
- Унифицирован размер шрифтов верхней панели до 12px с сохранением единой строки без переносов на десктопных разрешениях.
- Кнопки операций в панели аппликатуры (Clear, Unplayable, Gliss) заменены на квадратные иконки без текста.
- Исправлена ошибка сохранения dirty пальцев при отмене (Undo) после перерасчёта аппликатуры: теперь восстанавливается исходный baseline документа.

## 0.1.0-dev.12 — 3D correctness and responsive camera, 2026-10-17

Предыдущая dev.11 уже опубликована пользователем. Текущий цикл получает отдельную версию dev.12. Пользователь отдельно разрешил commit, push и публикацию через GitHub Pages; фактический результат проверяется по Actions и live buildId.

- Исправлено направление всех fixed/manual камер без OrbitControls; экспорт не подключает ResizeObserver/ввод и сохраняет владение canvas.
- Пустой PerformancePlan не возвращает исключённые исходные ноты; три педали сохраняют независимые состояния, их списки готовятся при смене плана.
- Убран скачок пальцев при начале завершающего подъёма.
- У камеры есть компактный селектор на узком экране; исправлена адаптивная сетка шапки на промежуточных ширинах.
- Добавлены семантические regression tests и повторяемый реальный браузерный медиа-стенд.

Результаты и границы: [протокол dev.12](evidence/3d-repair-2026-10-17/VERIFICATION.md). Публикация и полная релизная готовность этим циклом не объявляются.

## 0.1.0-dev.8 — Native calculation repair, 2026-10-16

Исправлены растяжение рук Native (NaN после pre-roll), разные карты ID нот и неверные pitch при replan. Сохранены неизвестные руки до split, исправлены pedal-off, truncated MIDI и progress callback. Инспектор различает выбранный и активный движок; видео фиксирует runtime снимка; build ID учитывает Native исходники. Версии workspace/lockfile и статус-бар синхронизированы.

488 unit-тестов проходят. Полная эквивалентность Python/TypeScript остаётся открытой; сравнение выполняется отдельной командой с ненулевым exit code при расхождении. [Точная приёмка и ограничения](DUAL_ENGINE_REVIEW.md).

## 0.1.0-dev.7 — локальная разработка, 2026-10-16

- Включён MuseScore General v0.2 с проверенной MIT-лицензией и сохранёнными acknowledgements. Новые настройки выбирают этот банк; прежние явные выходы не заменяются.
- Загрузка собственных SF2/SF3 сохраняется, предел 1 GiB. Сжатые Ogg/Vorbis-сэмплы SF3 читаются отдельно и декодируются по требованию в общем live/export кеше.
- MuseScore SF3 без sampleLink использует исходные channel zones/pan; strict reciprocal SF2 validation не ослабляется.
- Генератор включает банк и полный license notice в content-addressed release/offline-набор. Версия статуса и workspace manifests синхронизированы.
- Проверки и ремонт Fazioli описываются отдельными протоколами; исходные пользовательские файлы не перезаписываются. Полный SF2/SF3 synth parity не заявляется.


**Version**: 0.1.0-dev.6

**Date**: 2026-10-16

**Status**: Development preview. Manual hardware/listening and load limits remain open. Deployment is authorized after verification; check the Pages workflow and live version/build ID for its actual state. Historical audit evidence is separate from this change.
**Architecture**: Offline-First Progressive Web Application (SPA + Web Workers + WebAssembly)

---

## Built-in MIDI library — dev.6

Adds 162 built-in MIDI melodies, searchable by title from the empty workspace, File menu and Projects panel. Opening creates an independent editable project through the existing validated import/unsaved-changes flow. Source MIDI bytes remain unchanged; content hashes verify downloaded assets. The release builder generates the catalog and includes every melody in the coherent production offline set. Only the requested MIDI directory is embedded; other source formats and private SoundFonts remain excluded. [Implementation evidence and acceptance limits](evidence/builtin-melodies-2026-10-16/VERIFICATION.md).

*Historical count: dev.6 shipped 162 melodies; the current built-in catalogue contains 163.*

The complete catalog exposed and repaired source-only identity diagnostics leaking into normalized plans, missing diagnostics for ambiguous dropped percussion, and identical motion poses colliding after timestamp rounding. Numerical golden fields remain unchanged.

The subsequent user-bank check repairs supported SF2 global/local generator inheritance, preset/instrument offsets, tuning/attenuation units, hold/decay/sustain volume envelopes and cancellation continuity. Missing sampleModes now means one-shot playback; arbitrary loop bounds alone no longer enable looping. Strict malformed-stereo and unsupported-SF3 errors remain. Private banks are ignored by Git and excluded from the release. [Bank-specific results](evidence/user-soundfonts-2026-10-16/VERIFICATION.md).

## Stereo SoundFont and file-backed large banks — dev.5

Animation streaming now prefetches bounded windows during lead-in, adapts its reserve to playback speed and measured Worker latency, and fills the earliest uncovered interval before later event anchors. Resuming requires a usable reserve; Pause/Stop cancel automatic resumption. The stereo voice cleanup callback and a stale development Service Worker error reported in the user's console are also repaired. See the current implementation report for measured browser results.

Linked left/right PCM SF2 samples now play synchronously with per-channel controls and paired note/pedal lifecycle. File/Blob import accepts up to 1 GiB, indexes metadata in a Worker and hashes 4 MiB chunks instead of materializing full-bank PCM. IndexedDB v2 separates Blob payloads from metadata and migrates older assets transactionally. Live and export share a 256 MiB decoded/preparing sample budget with 64 MiB inactive LRU; exhausted capacity fails explicitly. Snapshots retain the immutable bank Blob; WAV and video use the same stereo synth.

The former 128 MiB limit was application policy, not a format/browser limit. Full SF2 compatibility is not claimed. SF3, ROM, linkedSample type 8 and other unsupported synthesis features remain excluded. Version/package format independence is preserved: portable projects stay v2. [Implementation and exact acceptance](SOUNDFONT_STEREO_IMPLEMENTATION.md), [audio subset](AUDIO_SUPPORT.md).

## Historical editor command menus and Auto-advance — dev.4

The secondary toolbar above the scene is removed. Undo/Redo move into the Edit menu while retaining keyboard shortcuts. Help (?) opens a menu with Keyboard shortcuts. Auto-advance replaces Step Entry and sits with finger assignments in the header, visible only in Fingering and off by default. Only numeric finger assignments advance selection; hand assignment, Clear, Unplayable and Gliss retain selection. Confirming an already assigned finger can advance without adding an edit or history entry.

The same editor session owns menu actions and keyboard shortcuts. The portable project format remains v2. Validation: 401 unit tests, typecheck, lint and project-path production build passed. Edge passed all 13 changed UI scenarios; Chrome passed 11 initially, followed by all 3 focused scenarios after responsive-header and Escape fixes. Ten viewport sizes/boundaries and keyboard access to the scrolled mobile scene were checked. Exact runs, screenshots and limits are in [dev.4 evidence](evidence/editor-command-menus-2026-10-15/VERIFICATION.md).

The deliberately invalid, text-like MIDI fixture is now marked binary in Git attributes so Windows autocrlf cannot change its byte-exact checksum. A fresh autocrlf checkout preserves the expected hash. The previous Windows CI run stopped at that checksum before browser tests; its result is not a browser pass.

## Historical UI change: fingering header controls — dev.3

Hand, finger, Clear, Unplayable and Gliss assignments move next to the workspace mode switch in the top header, visible only in Fingering. Smaller windows wrap these controls into additional header rows. Undo/Redo, Step Entry and Shortcuts stay above the shared scene. The editor session and canvas stay mounted when switching modes. The package format remains v2.

Focused verification: 25 unit tests; Chrome 11 scenarios plus final editor/responsive reruns; Edge 11 scenarios; typecheck, scoped lint and build passed. Six standard viewports and four additional header boundary widths have no page horizontal overflow or inaccessible header controls. See [UI evidence](evidence/fingering-header-2026-10-15/VERIFICATION.md) for exact runs and screenshots. This is separate from the preceding audit checks below.

## Historical audit remediation baseline before dev.5

The active record is [AUDIT_REPAIR_PROGRESS.md](AUDIT_REPAIR_PROGRESS.md). This preview adds committed-save/update barriers, content-addressed offline releases with old-tab pins, bounded motion streaming, one performance-event audio path, local Signalsmith 1.3.2 time stretch, prepared SF2/MIDI outputs and deterministic MP4/WebM export. The application version is synchronized across workspaces and the status bar.

Automatic verification: **397 unit tests, 28 Python tests, all 13 frozen fixtures**, typecheck/lint/build, and Windows Chrome/Edge UI, Worker, audio, production PWA and native media decode scenarios. Exact outcomes and the Chrome PWA full-plus-focused correction are recorded in the active matrix. Production builds always pin production mode even when invoked from a Vite development process. Real decoded examples and JSON evidence are retained with the report.

Manual gates remain for a user's compatible SF2 bank, physical MIDI, subjective listening and complete motion review. Worker analysis finished the 2k-note benchmark; 10k and a valid 50k MIDI timed out at 120 seconds and are not accepted as supported loads. See [ROLLBACK.md](ROLLBACK.md) for non-destructive recovery, [audio support](AUDIO_SUPPORT.md) for the explicit SF2 subset and cancellation boundary, and [dependency notices](evidence/licenses-2026-10-15.md) for corrected Signalsmith MIT and Mediabunny MPL-2.0 evidence. Source redistribution rights remain unresolved.

**Everything below is historical milestone documentation.** Its old test totals, renderer descriptions, MediaRecorder fallback and two-cache model do not describe current acceptance or the current export/PWA implementation. Do not cite the historical test table as a current pass.

---

## 1. Executive Summary

PianoMotion Studio is a complete, browser-native piano animation, fingering analysis, and performance visualization system. All compute-intensive operations—including MIDI parsing, ergonomic cost-optimization fingering planning, kinematic collision resolution, and frame-accurate pose interpolation—run locally on client hardware via Pyodide WebAssembly in background Web Workers.

---

## 2. Key Capabilities & Milestone Breakdown

### Milestone M1: WebAssembly Core & Zero-Deviation Baseline
- **Headless Worker Architecture**: Pyodide 314.0.7 running in a dedicated `Worker` isolated from the main UI thread.
- **Strict Typed Contracts**: Complete bidirectional TypeScript/Python DTO schemas powered by `@handthesia/contracts` and Zod (`SongDocument`, `FingeringPlan`, `PerformancePlan`, `MotionPlan`).
- **Golden Corpus Parity**: 13 out of 13 reference fixtures validated with zero unassigned notes and sub-millisecond execution timing parity.

### Milestone M2: High-Performance Playback & Scene Rendering
- **PixiJS 8 Rendering Pipeline**: Accelerated 2D rendering of realistic and equal 88-key piano keyboards (A0 to C8), color-coded falling notes (LH blue, RH green), and skeletal hands.
- **Web Audio Transport & Sampler**: Lookahead-scheduled polyphonic audio synthesizer featuring harmonic overtone modeling and full MIDI pedal handling (Sustain CC 64, Sostenuto CC 66, Soft Pedal CC 67).
- **Transport Synchronization**: Master AudioContext clock driving playhead position, speed scaling (0.25x to 2.0x), and lead-in count-in periods.

### Milestone M3: Musical Logic, Kinematics & MIDI Export
- **Canonic Figure Modeling**: Canonical scale fingering (e.g., 1-2-3-1-2-3-4-5 in C major RH) and explicit track assignment overrides.
- **Biomechanical Constraints**: Automatic rolled chords for spans exceeding physical hand stretch, early releases for consecutive fast strikes, and dynamic layer-ordering during hand crossings.
- **Glissando & Export Invariants**: 100% round-trip retention of assigned hand and finger meta-events in exported standard MIDI files (`.mid`) and PIG format notation.

### Milestone M4: Interactive Piano Roll Editor & Diagnostics
- **Canvas 2D Piano Roll**: Viewport-culled, 60 FPS horizontal piano roll with smooth zoom (40–600 px/sec) and pan controls.
- **Fingering Manipulation**: Single and marquee note selection, step-entry sequential assignment, and 50-step undo/redo history.
- **Ergonomics & Difficulty Engine**: Real-time evaluation of stretch semitones, note velocity density, awkward transitions, and difficulty classification (Beginner to Virtuoso).

### Milestone M5: Profiles, Customization & Native Storage
- **Anatomy & Behavior Profiles**: Full support for custom pianist profiles (Small Hands, Virtuoso, Left-Hand Dominant) with bone length adjustments and kinematic weight sliders.
- **Pianist Profile Importer**: Seamless import and validation of custom pianist profile `.json` configuration files.
- **IndexedDB `handthesia_db` v2**: Persistent client-side database with transactional schema upgrades, autosave session recovery snapshots, and storage quota protection.

### Milestone M6: Visual Skins, Audio Sync & Waveform Scrubbing
- **Procedural Hand Skins**: Realistic Cartoon Flesh, White Cartoon Gloves, Futuristic Robot Shell, and Classic Skeleton styles with soft drop shadows and depth ordering.
- **External Audio Synchronization**: In-browser decoding of WAV, MP3, OGG, and FLAC recordings with 5ms peak extraction.
- **Waveform Timeline**: Synchronized waveform alignment canvas with coarse drag and 10ms Shift-fine offset scrubbing.

### Milestone M7: Offline / Real-Time Video & Master Audio Export
- **Headless Video Export Engine**: Offscreen PixiJS canvas rendering with MediaRecorder capture (VP9/VP8 WebM / MP4) at 1080p, 720p, 4K, and Window resolutions.
- **Master Audio Offline Synthesizer**: Pure 16-bit PCM RIFF WAV encoder with peak normalization targeting -1 dBFS (0.89 max amplitude, up to 16.0x gain).
- **Export UI & Cancellation**: Live export modal with progress bars, status updates, cancellation cleanup, and direct video/WAV downloads.

### Milestone M8: Progressive Web App, Hosting & Hardened Security
- **PWA Standalone Mode**: Web App Manifest (`manifest.webmanifest`) and responsive vector/PNG application icons.
- **Dual-Cache Service Worker (`sw.js`)**: Offline application shell caching (`handthesia-shell-v1`) and immutable Pyodide runtime caching (`handthesia-pyodide-v1`).
- **Security Hardening**:
  - Content Security Policy (CSP) permitting local WASM compilation without remote eval.
  - Strict upload payload limits: 16 MiB MIDI, 32 MiB project packages, 100 MiB audio recordings.
  - Path traversal and filename sanitization defending against directory traversal, control characters, and reserved Windows device names (`CON`, `PRN`, `AUX`, etc.).
  - Prototype pollution defenses rejecting malicious `__proto__`, `constructor`, and `prototype` object properties.

---

## 3. Verified Test Matrix

| Test Suite | Total Tests | Passed | Execution Time |
|---|---|---|---|
| Vitest Unit Tests (18 suites) | 295 | 295 (100%) | 3.31 s |
| Playwright E2E Browser Tests (10 suites) | 27 | 27 (100%) | ~2.5 min |
| Python Core Parity Tests (3 suites) | 12 | 12 (100%) | 2.1 s |
| TypeScript Typecheck | All workspaces | Clean (0 errors) | 3.4 s |
| ESLint Scoped Check | All workspaces | Clean (0 errors) | 2.8 s |
| Production Build | Full client bundle | Built in 409 ms | 409 ms |

---

## 4. Known Boundaries & Non-Goals

1. **Local-Only Storage**: Projects and profiles reside in browser IndexedDB. Cloud synchronization requires Milestone M9 (separate enterprise backend).
2. **MediaRecorder Codec Availability**: WebM (VP9/VP8) is universally supported on Chromium and Firefox; Safari may default to MP4/H.264 based on OS codecs.
3. **Hardware Acceleration**: 60 FPS playback is optimized for hardware-accelerated WebGL 2.0; software fallbacks may throttle falling notes rendering during intense polyphonic passages.
