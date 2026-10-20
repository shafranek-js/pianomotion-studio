#!/usr/bin/env node
/**
 * Run the verification jobs locally, mirroring .github/workflows/verify.yml.
 *
 * The CI runner is a clean Windows machine; this script reuses the same working
 * tree, so it is a fast pre-flight, not a replacement for the hosted workflow.
 * Jobs get separate ports so they can run at the same time on one machine.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = new Map();
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
  if (match) options.set(match[1], match[2] ?? "true");
}

const allGroups = ["static", "build", "ui", "gpu", "worker", "audio", "soundfont", "pwa", "media"];
const requested = (options.get("groups") ?? allGroups.join(","))
  .split(",").map(group => group.trim()).filter(Boolean);
const unknown = requested.filter(group => !allGroups.includes(group));
if (unknown.length > 0) {
  console.error(`Unknown groups: ${unknown.join(", ")}. Available: ${allGroups.join(", ")}`);
  process.exit(2);
}
const groups = new Set(requested);
if (groups.has("pwa") || groups.has("media")) groups.add("build");

const shards = Math.max(1, Number(options.get("shards") ?? 3));
const concurrency = Math.max(1, Number(options.get("concurrency") ?? 2));
const channel = options.get("channel") ?? "chrome";
const ciMode = options.has("ci");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".ci-local", stamp);

const tasks = new Map();
const add = task => tasks.set(task.id, task);

add({
  id: "prepare",
  deps: [],
  commands: ["node tools/ensure-test-assets.mjs"],
});

if (groups.has("static")) {
  add({
    id: "static",
    deps: ["prepare"],
    commands: [
      "npm run test:python",
      // The assets are already staged; skip the npm pre-script that would race
      // the build job for the same generated files.
      "npm run test:catalog --ignore-scripts",
      "npm run typecheck",
      "npm run lint",
      "npm run test:unit",
      "npm run test:native-parity",
    ],
  });
}

if (groups.has("build")) {
  add({
    id: "build",
    deps: ["prepare"],
    // prebuild repeats prepare:m1:assets, which the prepare job already ran.
    commands: ["npm run build --ignore-scripts"],
  });
}

for (let shard = 1; shard <= shards; shard += 1) {
  if (!groups.has("ui")) break;
  add({
    id: `ui-${shard}`,
    deps: ["prepare"],
    port: 4180 + shard - 1,
    commands: [`npx --no-install playwright test --config playwright.config.ts --shard=${shard}/${shards}`],
  });
}

const browserGroups = [
  ["gpu", "playwright.gpu.config.ts", 4190],
  ["worker", "playwright.worker.config.ts", 4191],
  ["audio", "playwright.audio.config.ts", 4192],
  ["soundfont", "playwright.soundfont.config.ts", 4193],
];
for (const [id, config, port] of browserGroups) {
  if (!groups.has(id)) continue;
  add({ id, deps: ["prepare"], port, commands: [`npx --no-install playwright test --config ${config}`] });
}

if (groups.has("pwa")) {
  add({ id: "pwa", deps: ["build"], port: 4194, commands: ["npx --no-install playwright test --config playwright.preview.config.ts"] });
}
if (groups.has("media")) {
  add({ id: "media", deps: ["build"], port: 4195, commands: ["npx --no-install playwright test --config playwright.media.config.ts"] });
}

if (options.has("list")) {
  for (const task of tasks.values()) {
    const deps = task.deps.length > 0 ? ` <- ${task.deps.join(", ")}` : "";
    console.log(`${task.id}${deps}`);
  }
  process.exit(0);
}

mkdirSync(runDir, { recursive: true });
const baseEnvironment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  PIANOMOTION_BROWSER_CHANNEL: channel,
  PLAYWRIGHT_HTML_OPEN: "never",
};
if (ciMode) baseEnvironment.CI = "1";

const activeChildren = new Set();
const semaphore = { active: 0, waiters: [] };
async function acquire() {
  if (semaphore.active < concurrency) {
    semaphore.active += 1;
    return;
  }
  await new Promise(resolve => semaphore.waiters.push(resolve));
  semaphore.active += 1;
}
function release() {
  semaphore.active -= 1;
  semaphore.waiters.shift()?.();
}

const startedAt = Date.now();
const started = new Map();
async function execute(task, command) {
  const logPath = join(runDir, `${task.id}.log`);
  const fd = openSync(logPath, "a");
  const environment = { ...baseEnvironment };
  if (task.port) environment.PIANOMOTION_TEST_PORT = String(task.port);
  const child = spawn(command, {
    cwd: root,
    env: environment,
    shell: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  activeChildren.add(child);
  const code = await new Promise(resolve => {
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 1)));
  });
  activeChildren.delete(child);
  closeSync(fd);
  return code;
}

const results = new Map();
const promises = new Map();
function run(id) {
  if (promises.has(id)) return promises.get(id);
  const task = tasks.get(id);
  const promise = (async () => {
    const dependencies = await Promise.all(task.deps.map(run));
    if (dependencies.some(dependency => !dependency.ok)) {
      const result = { ok: false, skipped: true, ms: 0 };
      results.set(id, result);
      console.log(`- ${id}: skipped (dependency failed)`);
      return result;
    }
    await acquire();
    started.set(id, Date.now());
    console.log(`▶ ${id} started`);
    let ok = true;
    for (const command of task.commands) {
      const code = await execute(task, command);
      if (code !== 0) {
        ok = false;
        break;
      }
    }
    release();
    const ms = Date.now() - (started.get(id) ?? Date.now());
    const result = { ok, skipped: false, ms };
    results.set(id, result);
    const minutes = (ms / 60_000).toFixed(1);
    console.log(`${ok ? "✓" : "✗"} ${id} ${ok ? "passed" : "failed"} in ${minutes} min`);
    if (!ok) {
      const tail = readFileSync(join(runDir, `${id}.log`), "utf8").trimEnd().split(/\r?\n/).slice(-30);
      console.log(`  --- ${id}.log (tail) ---`);
      for (const line of tail) console.log(`  ${line}`);
    }
    return result;
  })();
  promises.set(id, promise);
  return promise;
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  for (const child of activeChildren) child.kill();
  process.exit(130);
});

const ordered = [...tasks.keys()];
const outcomes = await Promise.all(ordered.map(run));
const failed = ordered.filter((id, index) => !outcomes[index].ok);
const totalMinutes = ((Date.now() - startedAt) / 60_000).toFixed(1);

console.log(`\nlocal verification finished in ${totalMinutes} min (${channel}, concurrency ${concurrency})`);
console.log(`logs: ${runDir}`);
for (let index = 0; index < ordered.length; index += 1) {
  const id = ordered[index];
  const outcome = outcomes[index];
  const minutes = (outcome.ms / 60_000).toFixed(1);
  const status = outcome.skipped ? "skipped" : outcome.ok ? "passed" : "failed";
  console.log(`  ${status.padEnd(8)} ${id.padEnd(12)} ${minutes.padStart(6)} min`);
}
if (interrupted) process.exit(130);
process.exit(failed.length === 0 ? 0 : 1);
