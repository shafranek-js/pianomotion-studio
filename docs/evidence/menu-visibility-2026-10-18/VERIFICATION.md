# Восстановление меню File и Export — 2026-10-18

## Результат

Локально исправлено обрезание выпадающих меню. File снова полностью показывает пять действий, Export — три. Общий механизм исправлен также для Edit и Help. Проверки выполнены оркестратором в текущем checkout, поверх существующих незакоммиченных изменений dev.18.

| Меню | Сохранённые действия |
| --- | --- |
| File | Open MIDI; Built-in melodies; Open project package; Open saved project; Save project |
| Export | Fingered MIDI (.mid); Project package (.json); Performance video (.mp4 / .webm) |
| Edit | Undo; Redo |
| Help | Keyboard shortcuts; About |

При пустом проекте Save и экспорт видимы, но отключены. После загрузки проекта они доступны. История Git и текущие обработчики подтверждают этот набор: удалённые действия восстанавливать из старых реализаций не потребовалось.

## Исходный дефект

В настоящем Chrome на пользовательском dev-сервере `127.0.0.1:5173`, в новом browser context с `/?empty=true`, File содержал все пять кнопок в DOM. Однако только первая проходила `elementFromPoint`; остальные были обрезаны. В Export все три кнопки присутствовали в DOM, но не проходили hit-test.

У `.studio-header` вычислялось `overflow: auto hidden`. Вложенный абсолютный popover выходил за высоту шапки и обрезался. Дополнительно автоматический фокус прокручивал шапку по вертикали, скрывая её обычное содержимое.

- [File до исправления](before-file-chrome.png)
- [Export до исправления](before-export-chrome.png)

## Изменения

- `apps/client/src/studio/StudioShell.tsx`: меню перенесены через React portal в `document.body`, фиксированное положение рассчитывается от активной кнопки с учётом окна, прокрутки и изменения размеров. Начальный фокус использует `preventScroll`, случайная вертикальная прокрутка шапки сбрасывается, горизонтальная сохраняется. Обработчик внешнего клика учитывает и кнопку, и портальное меню. Сохранены действия, disabled-состояния, Escape и клавиатурная навигация.
- `apps/client/src/studio/studio.css`: положение, высота и внутренняя прокрутка popover; явные стили текста и фокуса для меню вне оболочки.
- `tests/browser/menu-visibility.spec.ts` и `menu-visibility.tsconfig.json`: регрессия проверяет реальную геометрию и hit-test каждой кнопки, а не только наличие или Playwright visibility.

Исполнитель `menu_repair` владел двумя продуктовыми файлами; `menu_browser` — новым browser-spec и его tsconfig; `menu_inventory` проверял историю и handlers без записи. Все исполнители — GPT-6 Luna Extra High. Оркестратор независимо проверил diff, интеграцию, команды и изображения.

## Проверки

| Команда / группа | Результат |
| --- | --- |
| `npm.cmd run test:unit -- apps/client/src/studio/StudioWorkspace.test.tsx` | 4/4 PASS, один файл |
| `npm.cmd run typecheck` | PASS, exit 0 |
| `npm.cmd run lint` | PASS, exit 0 |
| `node.exe node_modules/typescript/bin/tsc --noEmit --pretty false -p tests/browser/menu-visibility.tsconfig.json` | PASS, exit 0 |
| `node.exe node_modules/eslint/bin/eslint.js --config eslint.config.js tests/browser/menu-visibility.spec.ts` | PASS, exit 0 |
| `node.exe node_modules/vite/bin/vite.js build --config scratch/menu-vite.config.ts --outDir ../../scratch/menu-build --emptyOutDir` | Production bundle PASS, 3000 modules; обычное предупреждение о размере chunk |
| Scoped `git diff --check` | PASS; только уведомления Git о LF/CRLF |
| Chrome: menu visibility + editor commands | 4/4 PASS, 0 skipped / flaky / unexpected |
| Edge: те же сценарии | 4/4 PASS, 0 skipped / flaky / unexpected |

Browser-команда для каждого канала (`chrome`, затем `msedge`):

```powershell
$env:PIANOMOTION_BROWSER_CHANNEL='chrome' # затем msedge
node.exe node_modules/@playwright/test/cli.js test --config scratch/menu-playwright.config.ts tests/browser/menu-visibility.spec.ts tests/browser/editor-commands.spec.ts
```

Использован отдельный Vite на `127.0.0.1:4198` с cache `scratch/menu-vite-cache`. Пользовательский сервер на 5173 не останавливался. Scratch-конфиги и bundle — локальные проверочные артефакты, не часть продуктового изменения.

Browser-проверки подтверждают:

- Полный набор и enabled/disabled-состояния File/Export в пустом и загруженном проекте.
- Попадание указателя в каждый пункт и сохранение доступности кнопки меню; положение внутри окна при 1280×900 и 390×844.
- Доступность всех пунктов через внутреннюю прокрутку при 390×260, без вертикальной прокрутки шапки.
- Home/End/ArrowDown/Escape, возврат фокуса, внешний клик и прямое переключение File → Export.
- Настоящее сохранение в IndexedDB и JSON-экспорт с валидацией контракта, project ID и исходных MIDI-байтов.
- Help и возврат фокуса после диалога, реальные Undo/Redo через общее меню и историю редактора.

Открытие и использование MIDI/video export не проверялось полным экспортом в этой задаче: их существующие callbacks сохранены, видимость и доступность соответствующих пунктов проверены. Полные тяжёлые suites и release packaging повторно не запускались.

## Артефакты после исправления

- Chrome: [File](chrome/project-desktop-file.png), [Export](chrome/project-desktop-export.png), [File 390px](chrome/project-mobile-file.png), [Export 390px](chrome/project-mobile-export.png), [JSON report](chrome/playwright-report.json).
- Edge: [File](edge/project-desktop-file.png), [Export](edge/project-desktop-export.png), [File 390px](edge/project-mobile-file.png), [Export 390px](edge/project-mobile-export.png), [JSON report](edge/playwright-report.json).

Оркестратор просмотрел desktop File/Export и narrow Export в Chrome, narrow File в Edge. Все пункты видны; длинная подпись video export переносится внутри меню.

## Границы

Сохранены параллельные audit, CI, i18n и 3D/stage изменения. В рамках этой задачи не изменялись версии, зависимости, desktop Python и roadmap acceptance. Commit, push и deploy не выполнялись. Это подтверждение локального исправления меню, а не полный release gate.
