#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";

/**
 * PianoMotion Studio CI Verification Pipeline.
 * Runs core, client, production PWA and decoded-media acceptance in sequence.
 */

const steps = [
  {
    name: "Python Core and Frozen Goldens",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "test:python"],
  },
  {
    name: "TypeScript Typecheck",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "typecheck"],
  },
  {
    name: "ESLint Scoped Lint",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "lint"],
  },
  {
    name: "Vitest Unit Test Suite",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "test:unit"],
  },
  {
    name: "Production Build",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "build"],
  },
  {
    name: "Browser, Worker, PWA and Media",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "test:browser:all"],
  },
];

async function runStep(step) {
  const start = performance.now();
  console.log(`\n======================================================`);
  console.log(`▶ Running: ${step.name}`);
  console.log(`  Command: ${step.command} ${step.args.join(" ")}`);
  console.log(`======================================================`);

  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("close", (code) => {
      const durationMs = Math.round(performance.now() - start);
      resolve({
        name: step.name,
        command: `${step.command} ${step.args.join(" ")}`,
        exitCode: code ?? 1,
        durationMs,
      });
    });
  });
}

async function main() {
  const pipelineStart = performance.now();
  console.log("=== Starting PianoMotion Studio CI Pipeline ===");

  const results = [];
  let allPassed = true;

  for (const step of steps) {
    const result = await runStep(step);
    results.push(result);
    if (result.exitCode !== 0) {
      console.error(`\n❌ Step failed: ${step.name} (exit code ${result.exitCode})`);
      allPassed = false;
      break;
    } else {
      console.log(`✔ Step passed in ${result.durationMs} ms`);
    }
  }

  const totalDurationMs = Math.round(performance.now() - pipelineStart);

  console.log(`\n======================================================`);
  console.log(`               CI PIPELINE SUMMARY                   `);
  console.log(`======================================================`);
  for (const r of results) {
    const status = r.exitCode === 0 ? "PASS" : "FAIL";
    console.log(`  [${status}] ${r.name.padEnd(28)} ${(r.durationMs + " ms").padStart(10)}`);
  }
  console.log(`------------------------------------------------------`);
  console.log(`Total duration: ${totalDurationMs} ms`);
  console.log(`Overall status: ${allPassed ? "SUCCESS (PASS)" : "FAILED (FAIL)"}`);
  console.log(`======================================================\n`);

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error in CI pipeline:", err);
  process.exit(1);
});
