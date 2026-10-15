# Базовое состояние и тестовый стенд перед устранением замечаний аудита

Дата фиксации: **2026-10-14**.  
Рабочий каталог: `C:\Projects\pianomotion-studio`.  
Базовый коммит: `dc7eb963ff793110c586b4e86129cb22282cd452` (с незакоммиченными изменениями студии).

---

## 1. Конфигурация стенда и версии инструментов

- **ОС**: Windows 11 Pro (win32, x64, build 26100+)
- **Node.js**: v24.14.0
- **npm**: 11.11.1
- **Python хоста**: Python 3.14.0 (`C:\Python314\python.exe`)
- **Изолированное тестовое окружение Python**: `.venv-test`
  - Python: 3.14.0
  - pytest: 9.1.1
  - numpy: 2.5.4
  - mido: 1.3.3
  - pretty-midi: 0.2.11.post0
  - pygame-ce: 2.5.8 (для проверки соответствия десктопной геометрии)
  - Desktop `.venv` (`C:\Projects\pygame-piano-animator\.venv`) полностью сохранён и не изменялся
- **Playwright**: 1.64.0
- **Vite**: 8.3.4
- **Vitest**: 5.0.4
- **Engine Hash**: `93bc6a9a9eec06860d78a72234965a68542cdaeb769aa45b422c028ea91f8b69`
- **Pyodide Runtime Assets**: 12 файлов, 21.37 MiB (`apps/client/public/pyodide/`), все хеши верифицированы.

---

## 2. Результаты тестов на момент фиксации базы (Этап 0)

| Проверка | Команда | Результат | Комментарий |
|---|---|---|---|
| TypeScript Typecheck | `npm.cmd run typecheck` | **PASS (0 ошибок)** | 3 проекта: `apps/client`, `packages/contracts`, `tsconfig.tools` |
| ESLint | `npm.cmd run lint` | **PASS (0 ошибок, 0 предупреждений)** | Полный линтинг клиентского кода и контрактов |
| Vitest Unit Tests | `npm.cmd run test:unit` | **PASS: 314/314 тестов (21 файл)** | Время выполнения: ~14.3 с |
| Python Core Tests | `.\.venv-test\Scripts\python.exe -m pytest python-core/tests/` | **PASS: 19/19 тестов (4 файла)** | `test_core.py` (7/7), `test_export.py` (4/4), `test_motion_window.py` (4/4), `test_replan.py` (4/4) |
| Production Build | `npm.cmd run build` | **PASS (878 ms)** | Bundle `index-o20Vg_t8.js` (946.52 kB), Worker `midi-analysis.worker-B9LETEkV.js` (159.84 kB) |

---

## 3. Состояние дефектов A01–A16 на старте работ

- **A01, A02, A07, A08**: Исправлены в ходе перестройки студии. Покрыты тестами `test_replan.py`, `storage.test.ts`, `controller.test.ts`, включены в регрессию.
- **A04, A06, A16**: Функции временно скрыты/отключены в UI для защиты пользователя от некорректного поведения. Внутренняя реализация требует доработки по плану.
- **A09**: Переработано владение Worker, но механизм streaming поз после правок и восстановления сессии подлежит реализации на Этапе 1.
- **A03, A05, A10–A15**: Требуют полноценного ремонта согласно этапам 1–5 плана.

Все дефекты занесены в [AUDIT_REGISTRY.md](../AUDIT_REGISTRY.md) с точными сценариями воспроизведения и критериями сдачи.
