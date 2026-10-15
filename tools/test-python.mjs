import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const localPython = path.resolve(process.platform === "win32" ? ".venv-test/Scripts/python.exe" : ".venv-test/bin/python");
const python = process.env.PIANOMOTION_TEST_PYTHON || (existsSync(localPython) ? localPython : "python");
const child = spawn(python, ["-B", "-m", "pytest", "-p", "no:cacheprovider", "python-core/tests/", ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", error => { console.error(`Cannot run the separate Python test environment: ${error.message}`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
