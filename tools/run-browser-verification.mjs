import { spawn } from "node:child_process";

// These groups are deliberately sequential: Pyodide/MSAA cold starts contend for memory and CPU.
for (const script of ["test:browser", "test:worker", "test:audio", "test:offline", "test:media"]) {
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], {
      stdio: "inherit", shell: process.platform === "win32",
    });
    child.on("error", error => { console.error(error); resolve(1); });
    child.on("close", code => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exit(exitCode);
}
