# Быстрые действия левой панели — 2026-10-18

## Принятый объём и результат

Первый этап согласованного предложения реализован: на панели появились Library, Import и Audio. Сохранены Projects, Inspector и Focus. A–B, закладки и новая панель практики остаются следующим этапом и в этот запрос не включены.

- Library открывает существующую библиотеку мелодий.
- Import вызывает существующий выбор MIDI-файла и обычный путь импорта.
- Audio одним действием открывает Inspector на вкладке Audio. Повторное нажатие сохраняет открытую вкладку; переход из Scene выбирает Audio. При закрытии панели фокус возвращается к кнопке Audio, включая мобильный sheet.
- Audio отключена до загрузки проекта и во время busy. Library и Import отключены во время busy. Подсказки поясняют действие или недоступность.

Desktop-полоса расширена с 48 до 64px, чтобы подписи читались на всех шести языках. Действия сгруппированы, Focus остаётся внизу. На узких экранах используются компактные вертикальные иконки с подписями в горизонтальном ряду 60px: при 390px все шесть кнопок видны одновременно. Предусмотрена локальная горизонтальная прокрутка для ещё меньшей ширины и вертикальная для коротких desktop-окон. Порог закрепления панели учитывает новую ширину rail и сохраняет требование к центральной области 960px.

## Файлы и роли

`rail_implementation` (GPT-6 Luna Extra High) изменил только:

- `apps/client/src/studio/StudioShell.tsx` — три входа, выбор Audio одной операцией состояния, возврат фокуса, доступность и новый rail test ID.
- `apps/client/src/studio/studio.css` — группировка, размер панели и адаптивные размеры/прокрутка.

`rail_localization` изменил `apps/client/src/i18n/types.ts` и шесть `apps/client/src/i18n/locales/{en,cs,uk,de,es,it}.ts`: новый типизированный раздел `rail` с семью строками. Старые переводы, включая stageAppearance, сохранены.

`rail_browser` подготовил `tests/browser/rail-quick-access.spec.ts` и `tests/browser/rail-quick-access.tsconfig.json`. Оркестратор проверил diff, вернул на уточнение desktop docking offset, мобильные размеры, disabled-подсказку и иконку аудиофайла, затем независимо выполнил проверки и просмотрел screenshots.

## Проверки оркестратора

| Проверка | Результат |
| --- | --- |
| `npm.cmd run test:unit -- apps/client/src/studio/StudioWorkspace.test.tsx` | 4/4 PASS, один файл |
| `npm.cmd run typecheck` | PASS, exit 0 |
| `npm.cmd run lint` | PASS, exit 0 |
| `node.exe node_modules/typescript/bin/tsc --noEmit --pretty false -p tests/browser/rail-quick-access.tsconfig.json` | PASS, exit 0 |
| Scoped ESLint для нового browser-spec | PASS, exit 0 |
| `node.exe node_modules/vite/bin/vite.js build --config scratch/rail-vite.config.ts --outDir ../../scratch/rail-build --emptyOutDir` | Production bundle PASS, 3001 modules; предупреждение о размере chunk |
| Scoped `git diff --check` | PASS; только уведомления LF/CRLF |
| Chrome | Все четыре уникальных сценария подтверждены; точная последовательность ниже |
| Edge | 4/4 PASS, 0 skipped / unexpected / flaky, 52.8s |

### Браузерные сценарии

1. Полные File/Export в пустом проекте: геометрия, hit-test, клавиатура, внешний клик и переключение меню.
2. File/Export с проектом: desktop/mobile/short viewport, настоящее сохранение и JSON-экспорт.
3. Новый rail: Library → настоящий диалог; немецкие подписи через реальные настройки; Import → native file chooser → MIDI fixture → настоящий анализ в одном Worker; Audio → Audio tab, повторное нажатие, Scene → Audio и возврат фокуса по Escape. Все шесть кнопок проходят hit-test при 1024×350 и 390×520; Projects, Inspector и Focus работают, горизонтального overflow документа нет.
4. Существующая проверка шести размеров 1920×1080, 1440×900, 1366×768, 1024×768, 768×1024 и 390×844: одна сохраняемая сцена, все 88 клавиш, редактор, панели, фокус и закрепление панели. Дополнительно проверяются header breakpoints 320/560/900/1600px.

Использован настоящий лёгкий synth и 2D через существующий интерфейс настроек. Worker, импорт, renderer и UI не подменялись. Специальные полные audio/3D suites и release packaging здесь не повторялись.

### Команды и Chrome correction

Изолированные Vite/Playwright-конфиги находятся в `scratch/rail-vite.config.ts` и `scratch/rail-playwright.config.ts`; cache — `scratch/rail-vite-cache`, проверочный сервер — `127.0.0.1:4199`. Пользовательский dev-сервер на 5173 не останавливался.

```powershell
$env:PIANOMOTION_BROWSER_CHANNEL='chrome' # затем msedge
$env:PIANOMOTION_RAIL_RUN='rail'
node.exe node_modules/@playwright/test/cli.js test --config scratch/rail-playwright.config.ts tests/browser/rail-quick-access.spec.ts tests/browser/menu-visibility.spec.ts tests/browser/studio-workspace.spec.ts --grep 'workspace rail|empty File|project menus|six responsive sizes'
```

Первый Chrome-прогон: 3 PASS и 1 FAIL в новом тесте. Тест искал немецкую rail-кнопку, пока Preferences оставался модально открыт и Radix корректно скрывал rail из accessibility tree. Исправлен порядок теста: закрыть Preferences, проверить доступный переведённый rail, снова открыть Preferences и вернуть английский. Продуктовые файлы не менялись; skips, retries и допуски не добавлялись.

Повторена только упавшая проверка:

```powershell
$env:PIANOMOTION_BROWSER_CHANNEL='chrome'
$env:PIANOMOTION_RAIL_RUN='rail-focused'
node.exe node_modules/@playwright/test/cli.js test --config scratch/rail-playwright.config.ts tests/browser/rail-quick-access.spec.ts
```

Результат focused Chrome: 1/1 PASS, 18.7s. Затем окончательный набор целиком прошёл в Edge: 4/4. Начальный Chrome report с ошибкой теста сохранён вместе с окончательным focused report.

## Снимки и отчёты

- [Исходный скриншот пользователя](reference-before.png).
- Chrome: [desktop](chrome/rail-desktop.png), [390×844](chrome/rail-mobile-390x844.png), [390×520 с фокусом на Audio](chrome/rail-mobile-390x520.png), [закреплённая панель](chrome/projects-pinned.png), [initial report](chrome/initial-report.json), [focused report](chrome/focused-report.json).
- Edge: [desktop](edge/rail-desktop.png), [390×844](edge/rail-mobile-390x844.png), [390×520](edge/rail-mobile-390x520.png), [закреплённая панель](edge/projects-pinned.png), [report](edge/playwright-report.json).

Оркестратор просмотрел исходный screenshot и финальные desktop/mobile снимки. Цвета, иконки и взаимодействия продолжают существующий интерфейс; все шесть действий видны в ряду 390px. Сцена на проверочных снимках 2D с MIDI fixture, исходный пользовательский screenshot — 3D с другим произведением; попиксельное совпадение всей сцены не заявляется.

## Границы

Проверено локально в текущем checkout dev.19. Версия появилась в параллельной задаче сцены; rail-задача версий и зависимостей не меняла. Сохранены предшествующие menu/audit/CI/i18n/stage изменения. Desktop Python и пользовательские файлы не затрагивались. Stage/commit/push/deploy не выполнялись; общий release/roadmap gate не закрывался.
