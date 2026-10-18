# Исправление четырёх дефектов аудита — 2026-10-18

## Результат и границы

Четыре дефекта исправлены и прошли локальную проверку в назначенной области. Это не закрывает общий release/roadmap gate, полные media/PWA suites, аппаратную MIDI-проверку или приёмку параллельных изменений 3D-сцены.

Работа выполнена в общем dirty checkout `C:\Projects\pianomotion-studio`, исходный HEAD `4e51283`. Во время работы другая задача добавляла настройки сцены и повышала версию dev.16 → dev.17 → dev.18. Эти изменения сохранены; настоящая задача не меняла зависимости, версии, lockfile, desktop, Python-окружение и goldens. Stage/commit/push/deploy/reset/clean не выполнялись.

Первый браузерный прогон в живом checkout прервался на перезагрузке Vite, были ошибки уничтоженного execution context и повторной загрузки React. Он не использован как положительная приёмка. Для воспроизводимой проверки создана локальная копия:

`C:\Projects\pianomotion-studio\scratch\audit-verification-20261018-1918`

В ней отдельный Vite cache, порт 4197, скопированные реальные исходники и подготовленные runtime/media assets; установленные зависимости используются без установки. В browser-конфигурации alias contracts указывает на contracts этой копии. Браузеры запускались последовательно, один worker, без retries/skips. Python/desktop tests не запускались.

## Изменения

1. **P1: поздняя стартовая загрузка заменяет проект.** `sessionOperation.ts` задаёт общую generation/AbortSignal для bootstrap и явного открытия. `App.tsx` отделяет readiness манифестов от отменяемой загрузки сессии, берёт ownership до асинхронного preflight сохранённого проекта/пакета, отбрасывает старые результаты/ошибки и освобождает Worker. Отмена и cleanup инвалидируют текущую операцию; переключение после Save дополнительно проверяет поколение подготовленного кандидата.
2. **P2: Save теряет recovery-метаданные.** `recoverySnapshot.ts` используется autosave и явным Save. Снимок содержит имя, viewMode, dimension/camera, документ, профиль, исходные байты и manual intent. Save читает актуальное committed состояние через layout-ref и сохраняет существующий save/update barrier. Редактор по прежним правилам интерфейса переключает dimension на 2D; тест сохранения 3D использует Play along.
3. **P2: аккомпанемент Play Along теряет ритм.** Onset каждого companion occurrence планируется от времени текущего шага. У каждого occurrence отдельный voiceId; stop/seek/смена шага или руки/autoplay-off/dispose отменяют таймеры и принадлежащие им голоса. Старый noteOff не обрывает новый occurrence. Stop/dispose освобождают удерживаемые пользовательские голоса. `PianoPlayer` передаёт voiceId реальному output.
4. **P2: waveform расходится с аудио при speed != 1.** Production renderer использует общий `mapSongTimeToRecordingPosition(songTime, offset)`. Prop speed оставлен совместимым; деление координаты записи на скорость удалено. Аудиотракт и его time-stretch семантика не изменены.

## Проверки кода и сборки

| Команда | Фактический результат |
| --- | --- |
| `npm.cmd run test:unit -- --maxWorkers=1` | **59 файлов, 594 теста PASS**, 81.50 s |
| `npm.cmd run typecheck` | PASS, exit 0 |
| `npm.cmd run lint` | Сначала один `prefer-const` в onsetTimer; исправлен исполнителем, повторный полный lint PASS, exit 0 |
| `node.exe node_modules/typescript/bin/tsc -p tests/browser/audit.tsconfig.json` | PASS, exit 0; отдельно проверяет новые browser specs и production source |
| `npm.cmd run build` в checkout | PASS; итог проверенного запуска `39312818f566d464d1ec7140` |
| `npm.cmd run build` в изолированной копии | PASS; release **`5752ff8a634f81ecb05ba356`**, 258 offline resources / 70.58 MiB |
| `git diff --check` | PASS; были обычные предупреждения преобразования LF/CRLF |

Сборка оставляет предупреждение о chunk >500 kB; ошибки сборки нет. Подготовка runtime проверила pinned hashes: 12 runtime/wheel files, 21.37 MiB. Изолированная сборка использует существующие закреплённые runtime/cache и исходный SoundFont, не устанавливает пакеты.

До интеграции исполнители проверили focused suites: session helpers — 2 файла/4 теста; Play Along — 1 файл/25 тестов; waveform renderer — 1 файл/2 теста. Эти числа не прибавляются к общим 594.

## Browser evidence

Запуск из директории изолированной копии:

```powershell
$env:PIANOMOTION_BROWSER_CHANNEL = 'msedge' # либо chrome
$env:PIANOMOTION_AUDIT_RUN = 'full'
node.exe C:/Projects/pianomotion-studio/node_modules/@playwright/test/cli.js test --config playwright.audit.config.ts tests/browser/audit-session-recovery.spec.ts tests/browser/audit-playalong-audio.spec.ts tests/browser/audit-waveform.spec.ts tests/browser/update-save-barrier.spec.ts tests/browser/play-along.spec.ts tests/browser/stabilization.spec.ts
```

- **Edge 155.0.4283.45: 11/11 PASS**, 128.78 s, 0 skipped/retries/flaky. [Raw report](edge-full.json).
- **Chrome 155.0.8059.80: подтверждены те же 11 уникальных сценариев в focused запусках**, не один общий зелёный прогон: первые два сценария (actual Synth onsets и delayed default) прошли в консольном выводе изолированного запуска, остановленного для исправления restore harness; следующий запуск оставшихся девяти дал 7 PASS и 2 ошибки стенда ([raw report](chrome-initial.json)); после исправления ровно эти два сценария прошли 2/2, 54.90 s ([raw report](chrome-focused.json)). Общие прошедшие suites повторно не запускались.

Исправлены только ошибки нового стенда:

- Первый listener Worker принадлежал диагностике. Теперь Worker subclass задерживает доставку первого настоящего `analysis-result` всем получателям, затем доставляет сохранённые данные тому же Worker; проверяется termination именно этого Worker. Само вычисление не подменяется.
- В сценарии Save ожидалось 3D после входа в редактор, хотя UI явно включает 2D. Сценарий сохраняет 3D Overhead в Play along, затем проверяет reload, имя и manual intent.
- При динамическом browser-import Vite CJS module `react-dom/client` экспортировал createRoot через default. Добавлен interop fallback в компонентный тест.

Состав доказательств:

| Проверка | Что подтверждено |
| --- | --- |
| Delayed default → MIDI import → finger 5 | Старый signal aborted, после завершения настоящего fetch default analysis не отправлен; projectId/revision/manual intent сохранены |
| Delayed real restore result → explicit open | Удерживается настоящий Worker result; старый Worker завершён, поздняя доставка не заменяет новый проект |
| Named MIDI → edit → 3D Overhead/Play along → Save → reload | Имя, camera, dimension, viewMode, исходный hash и manual finger восстановлены |
| Play Along + настоящий Synth output | Ноты другой руки на 0/0.5 s имеют разные onsets/voice IDs; выход из практики освобождает удерживаемый пользовательский голос. Обёртка наблюдения вызывает оригинальный output |
| WaveformCanvas, настоящий browser canvas | Проверены пиксели на скоростях 0.25/0.5/1/2, оба знака offset и разные seek/scroll; используется synthetic peaks fixture, это не проверка audio decode/PCM |
| Existing stabilization + update barrier | IDs/history/MIDI markers, package/profile/geometry recovery, pending intent, transaction abort и изменение во время активации обновления |

## Соответствие рабочему дереву

[SHA-256 manifest](source-hashes.json) сравнивает исходники проверенной копии с checkout. Семь production-файлов и три новых browser specs сравниваются явно. Helpers, Play Along, waveform и specs совпадают побайтно. `App.tsx` и `PianoPlayer.tsx` отличаются только строкой описания параллельного релиза dev.17/dev.18; после нормализации исключительно атрибута release description код совпадает. Эта нормализация не применяется к остальной логике.

Поздние параллельные stage/environment изменения не считаются отдельно принятыми данным отчётом. Число 594 относится к выполненному общему unit-прогону, а не к последующим тестам другой задачи. Hardware MIDI, Firefox/Safari, слабые устройства и полные production PWA/media/audio suites остаются за рамками этой локальной приёмки.

## Файлы настоящего задания

- `apps/client/src/App.tsx`, `sessionOperation.ts`, `sessionOperation.test.ts`.
- `apps/client/src/player/PianoPlayer.tsx`, `recoverySnapshot.ts`, `recoverySnapshot.test.ts`, `playAlongEngine.ts`, `playAlongEngine.test.ts`.
- `apps/client/src/editor/waveform/WaveformCanvas.tsx`, `waveformCanvasRenderer.ts`, `waveformCanvasRenderer.test.ts`.
- `tests/browser/audit-session-recovery.spec.ts`, `audit-playalong-audio.spec.ts`, `audit-waveform.spec.ts`, `audit.tsconfig.json`.
- `docs/AUDIT_REMEDIATION_PLAN.md`, раздел настоящего задания в `docs/ORCHESTRATION.md`, этот протокол и его evidence.

Остальные dirty/untracked файлы принадлежат предыдущей или параллельной работе и этим заданием не очищались и не принимались.
