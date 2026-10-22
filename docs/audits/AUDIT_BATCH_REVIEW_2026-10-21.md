# Независимая проверка накопленных исправлений аудита

Дата: 2026-10-21. Checkout: `C:\Projects\pianomotion`, HEAD `f54821b`, main ahead of origin/main на три коммита по локальным Git refs. Проверено рабочее содержимое поверх HEAD: исходно 33 modified и 25 untracked entries. Git fetch/push/deploy не выполнялись. Новый файл этого отчёта — единственное изменение исходных материалов со стороны проверяющего; продуктовый код и resolution log не редактировались.

Основание: приложенный отчёт `Pasted text.txt` из attachment `fe420440-609e-4825-b748-21bfb832e2de`, текущие diff/new files и логи `.ci-local/2026-10-21T19-36-46-337Z/`. Предыдущие независимо принятые ENG-2/3/4, ENG-5/6, CLI-1 не переоткрываются.

## Решение

**Пакет целиком пока не принят.** Движковые исправления в основном соответствуют Python; основные lifecycle-изменения и новые browser-сценарии работают. Но в CLI-8, CLI-9, ENG-8 и release validators остаются конкретные пробелы, не обнаруженные зелёным gate. Наличие этих замечаний не означает, что текущий dist повреждён: текущий dist отдельно успешно проверен по его manifest. Проблема release validators — ложное принятие других, неполных артефактов.

## Замечания, требующие исправления

### B1 · P2 · CLI-8: cleanup не подключён в активном workspace

`apps/client/src/App.tsx:854–914` выбирает между активным `PianoPlayer` и пустым `StudioShell`. Новый `onDeleteProject` передан только `ProjectsPanel` в пустом shell. Активный player создаёт другой panel в `apps/client/src/player/PianoPlayer.tsx:2103`, без callback.

Сценарий: открыть/сохранить проект → удалить его в Projects активного studio → row удалён (`ProjectsPanel.tsx:56–67`), recovery не очищен, player остаётся открытым и способен продолжать autosave. При reload удалённый проект возвращается из recovery. Новый helper-тест не проверяет эту фактическую связку компонентов.

Исправление: провести один согласованный delete lifecycle через оба экземпляра panel. Определить судьбу активного player после удаления: закрыть/заблокировать recovery для удалённой сессии либо явно принять и показать другую семантику. Просто передать callback недостаточно, если следующий autosave тут же восстановит тот же snapshot. Regression должен удалять активный проект и проверять отсутствие его recovery после последующих событий и reload.

### B2 · P1 · CLI-8: stale delete может стереть recovery другого проекта

`apps/client/src/storage/deletedProjectRecovery.ts:12–21` делает отдельные `await load()` и `await clear()`. Между ними snapshot может смениться. App передаёт глобальный `autosaveService.clear()` (`App.tsx:906–913`), который отменяет текущий pending snapshot и безусловно очищает session store (`autosave.ts:534–569`). Он не привязан к project/generation и не сериализован с in-flight `savingPromise`/очередью записи snapshots.

Независимый deterministic probe без настоящего IndexedDB: начать удаление A и задержать возврат старого read A → заменить persisted recovery на B → вернуть A из read → helper возвращает true и очищает B. Вывод: `deletedProject=A, persistedBeforeClear=B, persistedAfterClear=null`.

Исправление: условное удаление по актуальному projectId/identity внутри одной readwrite transaction и согласование с очередью autosave. Старое удаление A не должно отменять/стирать pending или committed recovery B; in-flight autosave A не должен воскресить удалённую сессию. Добавить regressions на обе гонки. Не удалять существующие пользовательские записи в рамках проверки.

### B3 · P2 · CLI-9: JSON package export не защищён scope

`apps/client/src/player/PianoPlayer.tsx:1793–1807` по-прежнему вызывает `await downloadProjectPackage(...)` и пишет success/error status без generation/abort guard. В `storage/packageExporter.ts:365–375` скачивание выполняется внутри helper после асинхронной упаковки, до возврата вызывающему коду. Новый `ExportOperationScope` используется только в `handleExportMidi`.

Сценарий: начать экспорт пакета A → переключить проект/размонтировать player до завершения async упаковки → старый helper скачает A и старый callback может перезаписать статус новой сессии. Это незакрытая часть исходного CLI-9 (MIDI/package), а не новый функциональный запрос.

Исправление: разделить подготовку JSON и download либо передать cancellation/identity guard до download. Проверять актуальность и перед скачиванием, и перед изменением status. Focused regression должен задерживать реальную асинхронную подготовку, переключать сессию, затем завершать старую операцию и проверять отсутствие download/status side effects.

Снятое подозрение: изменение draftPlan при обычном редакторском действии **не** является пропущенной зависимостью MIDI scope. `document` материализуется с `revision=draftPlan.inputRevision` (`PianoPlayer.tsx:344–348`), а cleanup зависит от `document?.revision` (`:1791`). MIDI guard/catch/finally в проверенной области согласованы.

### B4 · P2 · ENG-8: два настоящих кеша всё ещё не ограничены

Шесть 20k-проверок исправлены, но `packages/engine-ts/src/hands.ts:2736` (`_idle_cache`) и `:2883` (`_grid_pose`/`_cache`) всё ещё выполняют `.length > 4000` над plain objects. Условие не срабатывает. Соответствующие Python пути считают число элементов.

Независимый probe вызвал настоящий метод `HandAnimator.prototype._grid_pose` с безопасным stub solver для 5 000 разных ключей: в `_cache` осталось 5 000 entries. Дорогая геометрия и браузер не запускались. Текущий `hands-cache.test.ts` вызывает только `_cap_cache` напрямую и не покрывает эти реальные пути.

Исправление: учесть оба 4k-cache, сохранив их пороги и Python semantics. Проверить реальные `_grid_pose`/idle-cache paths, а не только новый helper. Видимый snap при wholesale clear и производительность больших таблиц не считаются проверенными этой задачей.

### B5 · P2 · DEP-1 follow-up: verify:release принимает manifest без релиза

`tools/verify-release-dist.mjs:23–29` проверяет schemaVersion и непустой buildId, но не требует обязательный непустой files, index entry и `releases/<buildId>/` entries. Отсутствуют проверка hex-формата buildId, duplicate paths и соответствие release prefix; CSP/worker ID проверяются поиском подстроки (`:57–65`).

Независимый probe в изолированной временной папке создал только:

- `offline-manifest.json`: `{schemaVersion:2, buildId:<24 hex>, totalBytes:0, files:[]}`;
- index с пустым CSP meta и buildId как текстом;
- sw.js с buildId в комментарии.

Verifier успешно сообщил: `Verified dist aaaaaaaaaaaaaaaaaaaaaaaa: 0 files, 0 bytes, CSP and service-worker IDs present.` Release directory и JS/runtime assets отсутствовали. Такой manifest затем отвергает собственный SW (`public/sw.js:59–86` требует shell и release entries).

Исправление: переиспользовать/согласовать структурные инварианты offline manifest с SW, потребовать shell и обязательные release assets; проверять actual marker/references вместо произвольного includes. Добавить negative tests: empty/missing files, missing index/release, duplicate/foreign-build paths, неверный buildId, отсутствующий/пустой CSP. Не считать hash-проверку перечисленных файлов доказательством полноты самого списка.

### B6 · P2 · DEP-6: preflight доверяет пустым манифестам

`tools/release-assets.mjs:23–69` перебирает `manifest.files ?? []`, `Object.keys(manifest.files ?? {})`, entries/fixtureSources с пустыми fallback и проверяет только `access()` (`:8–15`). Наличие самих manifest-файлов с пустыми коллекциями приводит к успеху даже без runtime/core; нулевой SoundFont также считается присутствующим.

Вторая часть независимого temporary-directory probe: пустые manifests для Pyodide/core/melodies/fixtures и нулевой `empty.sf3` → `assertReleaseAssets()` успешно завершился. Ни одного настоящего runtime/core source не было. Поэтому DEP-6 улучшен для полностью отсутствующей папки, но полностью не закрыт.

Исправление: валидировать schema/обязательные непустые поля и ожидаемый pinned runtime/core inventory; требовать обычные файлы и проверять хотя бы declared size/hash там, где они доступны. Проверить partial corruption: отсутствующий wasm/wheel/core file, пустой/неполный manifest, directory вместо file, нулевой банк. Текущий regression «prepared tree»/«совсем пустая папка» этого не различает. Сообщение также ссылается на отсутствующий npm script `build:release`; использовать существующий entrypoint.

## Оценка остальных заявленных пунктов

| Пункт | Итог независимой проверки |
|---|---|
| CLI-2 | Принято по code review + lifecycle regression. begin/finish синхронизируют busy только current owner; early/error/legacy paths завершаются. Global cancel вызывается синхронной кнопкой текущей операции. Отдельный App-render test исходной гонки отсутствует — это граница evidence, не обнаруженный кодовый дефект. |
| CLI-3 | Частичное исправление соответствует отчёту: pagehide/hidden flush, cleanup listeners; teardown commit не гарантируется. |
| CLI-5 | Частичное исправление: chunked btoa и digest reuse есть; итоговая payload checksum validation не ослаблена. Same-length mismatch probe отвергнут. Профиль больших пакетов не снят. |
| CLI-6 | Частичное исправление: повторные serialization/hash сокращены; listProjects всё ещё загружает full records. |
| CLI-7 | Принято как UX semantics: audio session-only явно обозначено и переведено на шесть языков; сохранение audio не обещается. |
| CLI-8 | Не принято: B1/B2. |
| CLI-9 | Частично: MIDI path принят, package path остаётся B3. |
| CLI-10 | Основная permission-часть принята: Chrome browser regression 1/1; auto init снят. Полный исходный finding остаётся частичным: после отказа manager хранит denied/errorMessage, но PlayAlongTransport показывает общий Connect MIDI без объяснения (`PlayAlongTransport.tsx:321`, props в `PianoPlayer.tsx:2005`). Старый неиспользуемый init catch всё ещё prompt. |
| CLI-11 | Принято по code review/helper tests: время сохраняется для того же projectId, выбирается ближайший eligible step, новый проект сбрасывает ref. Реальный browser replan/project-switch scenario отдельно не повторялся. |
| CLI-12 | Принято в заявленной dev/webdriver модели. Guards применены к App results/errors и player snapshot; явного внешнего доступа через globals не появилось. |
| CLI-13 | Deferred обоснован: профиля кадров/long tasks нет, изменений реализации нет. |
| CLI-14 | Основные переводы и Escape-focus приняты (Chrome 1/1). Полная локализация не доказана: Audio status приходит английским из `PianoPlayer.tsx:1884`. Raw enum в Diagnostics (`StudioInspector.tsx:240`) сам по себе может быть намеренным техническим значением, его не считать автоматически UI-багом. Save/cancel прочие focus paths проверены по коду, не все браузером. |
| ENG-8 | Частично: B4. |
| ENG-12 | Принято: indexed lookup сохраняет классификацию/ссылки; focused regression и manifests согласованы. Производительность 10k/20k не перемерялась. |
| ENG-14a | Принято: оба fallback требуют pitch; Python/TS focused checks. |
| ENG-14b | Принято: dependency exceptions не скрываются, focused Python regression. |
| ENG-14c | Принято как явно документированная precision/collision policy, не как исправление алгоритма. |
| ENG-14d | Принято в проверенной области: ceiling применяется к roll onset и top reach, поздняя исходная нота не сдвигается назад. Helper regressions и исторический wide-chord parity PASS; отдельного полного planner/browser сценария здесь не запускали. |
| ENG-14f | Принято как format decision о совместимости коротких markers, не как устранение коллизии формата. |
| ENG-14g | Принято: numeric tuple comparator соответствует Python reverse ordering. |
| ENG-14h | Принято для допустимых DTO: exact scalar equality; типы полей ограничены контрактом. |
| DEP-6 | Не закрыто полностью: B6. |
| DEP-1 follow-up | Проверка текущего dist PASS; сам validator неполон, B5. Равенство локально протестированного и remote-rebuilt artifact по-прежнему не обеспечено. |
| DEP-2 follow-up | Разумное дополнительное ограничение framed startup, по коду и helper test. Это не HTTP frame-ancestors/XFO/nosniff; browser framing attack matrix не запускался. Статус Partially fixed сохранить. |
| CI-local scoped timeout | vi.setConfig действует в двух тяжёлых test files, глобальный timeout не меняется. В имеющемся static.log есть engine test с длительностью 15 528ms; timeout не считать performance budget или доказательством скорости ядра. |

## Проверки и точные границы evidence

### Повторено независимо

- `npm run verify:release` → exit 0, build `ec5e57230bcc005c4c3ef29e`, **258 manifest entries / 74 124 523 bytes**. Это размер/число manifest asset set, а не всех служебных файлов дерева dist.
- Все **12** actual Python source SHA-256 совпали с source_manifest. Канонический engine hash, EMBEDDED_MANIFEST, packaged core manifest и offline manifest engineVersion согласованы: `b54581cb07a377d24fdb762198c76d0c40b3e8be018ff2db5f022c1f5e00c23e`.
- Chrome на отдельном test port 4286: `midi-permission.spec.ts` + `practice-bookmark-focus.spec.ts` → **2/2 PASS, 29.4s**. WebGL precision warnings присутствовали; assertions не падали.
- Release-assets/frameGuard focused: **2 files / 3 tests PASS**. Наличие PASS этих позитивных/пустой-root тестов не опровергает negative probes B5/B6.
- UI/MIDI focused: **3 files / 37 tests PASS** (playAlongEngine, debugGlobals, webMidiInput).
- Client lifecycle/autosave/recovery/base64/export/editor focused: **6 files / 43 tests PASS**. Дополнительно storage.test.ts целиком: **26 PASS**; попытка npm `-t` не была проброшена, поэтому не выдаётся за filtered run.
- Engine focused: **7 TS files / 13 tests PASS**, **6 Python tests PASS** в отдельной `.venv-test`.
- Negative probes B2/B4/B5/B6 воспроизведены без изменений пользовательских данных. В B5/B6 создавалась отдельная папка системного temp; удалена только после проверки разрешённого абсолютного пути и собственного prefix.
- `git diff --check` → exit 0. Предупреждение Git о будущей CRLF-конвертации raw-source-pitch test не является diff-check failure.

### Сверено по существующим логам, не повторялось

`static.log`: **92 files / 716 unit PASS**, **38 Python PASS / 1 skipped**, все 13 native parity scenarios PASS, typecheck/lint в static sequence. Python в этом логе — **3.12.4**, это не прогон CPython 3.14/Pyodide.

`smoke.log`: **11/11 PASS**. `build.log`: завершён release ec5e57230bcc005c4c3ef29e. Отдельный исходный process exit `GATE=0` не записан в доступные group logs; подтверждён их успешный terminal output, а не повторный полный gate. Локальные Git refs показывают ahead 3; фактическое состояние remote без fetch не проверялось.

Полный gate/build/full unit/Python suite, weak-device, hardware MIDI, audio listening и codec matrix не повторялись. Browser warning для ENG-3 из предыдущего этапа отдельно не запускался. Stage/commit/push/deploy не выполнялись.

## Следующий шаг

Сначала устранить B1/B2 (delete/recovery ownership), затем B3/B4 и negative validation B5/B6. Добавить regressions именно через реальные интеграционные пути и boundary inputs. Исправления подтвердить focused-проверками; повторять весь gate только после новых кодовых изменений. До этого не считать весь накопленный пакет независимо принятым по зелёному логу.
