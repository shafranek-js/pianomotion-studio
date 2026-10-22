/** Trusted staging inventory for the release preflight/verifier. */
export const PINNED_PYODIDE_VERSION = "314.0.7";
export const PINNED_PYTHON_VERSION = "3.14.2";
export const PINNED_ABI_VERSION = "2026_0";
export const PINNED_PLATFORM = "emscripten_5_0_3";

export const PINNED_PYODIDE_FILES = [
  "pyodide/pyodide.mjs",
  "pyodide/pyodide.asm.mjs",
  "pyodide/pyodide.asm.wasm",
  "pyodide/python_stdlib.zip",
  "pyodide/pyodide-lock.json",
  "pyodide/micropip-0.11.1-py3-none-any.whl",
  "pyodide/numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  "pyodide/packaging-26.1-py3-none-any.whl",
  "pyodide/six-1.17.0-py2.py3-none-any.whl",
  "pyodide/wheels/pretty_midi-0.2.11.post0-py3-none-any.whl",
  "pyodide/wheels/mido-1.3.3-py3-none-any.whl",
  "pyodide/wheels/importlib_resources-7.1.0-py3-none-any.whl",
];

export const PINNED_PYTHON_WHEELS = [
  "pretty_midi-0.2.11.post0-py3-none-any.whl",
  "mido-1.3.3-py3-none-any.whl",
  "importlib_resources-7.1.0-py3-none-any.whl",
];

export const PINNED_CORE_MODULES = [
  "handthesia_core/__init__.py",
  "handthesia_core/api.py",
  "handthesia_core/figures.py",
  "handthesia_core/fingering.py",
  "handthesia_core/geometry.py",
  "handthesia_core/glissando.py",
  "handthesia_core/hand_split.py",
  "handthesia_core/hands.py",
  "handthesia_core/identity.py",
  "handthesia_core/midi_loader.py",
  "handthesia_core/pianist.py",
  "handthesia_core/progress.py",
];
