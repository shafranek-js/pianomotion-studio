import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze_midi, _engine_version } from "../src/api.ts";
import { _within, build_hands } from "../src/hands.ts";
import { load_midi } from "../src/midiLoader.ts";

const fixtureDir = resolve(__dirname, "../../../tests/fixtures/midi");
const builtinMidiDir = resolve(__dirname, "../../../builtin_melodies/midi");

function analyze(path: string, fixtureId: string) {
  const midiBytes = new Uint8Array(readFileSync(path));
  return analyze_midi(midiBytes, {
    fixtureId,
    projectId: "native-hands-regression",
    revision: 0,
    requestId: `native-hands/${fixtureId}`,
    engineVersion: _engine_version(),
    keyStyle: "realistic",
  });
}

function rightHandPoseAtZero(result: ReturnType<typeof analyze>): any {
  return result.rawBaseline.selectedPoses.find((pose: any) => pose.hand === "R" && pose.time === 0);
}

function expectNear(actual: number, expected: number, tolerance = 0.05) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe("native hand kinematics", () => {
  it("pulls a resting target inward using Python's Euclidean distance semantics", () => {
    expect(_within([0, 0, 0], [3, 4, 0], 2)).toEqual([1.2, 1.6, 0]);
    expect(_within([0, 0, 0], [1, 0, 0], 2)).toEqual([1, 0, 0]);
  });

  it("plans fingering when build_hands receives an empty options object", () => {
    const midiBytes = new Uint8Array(readFileSync(resolve(builtinMidiDir, "Chopsticks.mid")));
    const song = load_midi(midiBytes, { fixture_id: "builtin-chopsticks" });
    const animators = build_hands(song, {});

    expect(animators.R).toBeDefined();
    expect(Object.keys(animators.R.fingering).length).toBeGreaterThan(0);
    expect(animators.R.groups.length).toBeGreaterThan(0);
  });

  it("keeps the built-in Chopsticks lead-in pose finite and on its Python hand layout", () => {
    const result = analyze(resolve(builtinMidiDir, "Chopsticks.mid"), "builtin-chopsticks");
    const pose = rightHandPoseAtZero(result);

    expect(result.status).toBe("loaded");
    expect(pose).toBeDefined();
    expect(result.rawBaseline.selectedPoses.length).toBeGreaterThan(1);
    for (const selectedPose of result.rawBaseline.selectedPoses) {
      for (const chain of Object.values(selectedPose.fingerChains) as number[][][]) {
        for (const point of chain) {
          expect(point.every(Number.isFinite)).toBe(true);
          expect(point).not.toEqual([0, 0, 0]);
        }
      }
    }

    // Values captured from python-core/handthesia_core/hands.py with the
    // same MIDI, default pianist profile, and keyboard geometry.
    expectNear(pose.wristPose.positionPx[0], 731.97901534);
    expectNear(pose.wristPose.positionPx[1], -95.36218198);
    expectNear(pose.fingerChains["3"][0][0], 727.37236679, 0.15);
    expectNear(pose.fingerChains["3"][0][1], -76.18135983, 0.15);
    expectNear(pose.fingerChains["3"][4][0], 713.00000002, 0.15);
    expectNear(pose.fingerChains["3"][4][1], 56.53846132, 0.15);
  });

  it("matches the tracked-right-hand Python pose anchors at its first attack", () => {
    const result = analyze(resolve(fixtureDir, "tracked-right-hand.mid"), "tracked-right-hand");
    const pose = rightHandPoseAtZero(result);
    const golden = JSON.parse(readFileSync(resolve(__dirname, "../../../tests/fixtures/golden/tracked-right-hand.json"), "utf8"));
    const expected = golden.selectedPoses.find((item: any) => item.hand === "R" && item.time === 0);

    expect(result.status).toBe("loaded");
    expect(pose).toBeDefined();
    expectNear(pose.wristPose.positionPx[0], expected.wristPose.positionPx[0]);
    expectNear(pose.wristPose.positionPx[1], expected.wristPose.positionPx[1]);
    for (const finger of ["1", "2", "3", "4", "5"]) {
      const actualChain = pose.fingerChains[finger] as number[][];
      const expectedChain = expected.fingerChains[finger] as number[][];
      expect(actualChain).toHaveLength(expectedChain.length);
      for (let point = 0; point < actualChain.length; point += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          expectNear(actualChain[point]![axis]!, expectedChain[point]![axis]!);
        }
      }
    }
  });

  it("applies the Python crossing layer and wrist lift for the mismatched-label fixture", () => {
    const fixtureId = "synthetic-mismatched-track-labels";
    const result = analyze(resolve(fixtureDir, `${fixtureId}.mid`), fixtureId);
    const pose = result.rawBaseline.selectedPoses.find((item: any) => item.hand === "R" && item.time === 0);
    const golden = JSON.parse(readFileSync(resolve(__dirname, `../../../tests/fixtures/golden/${fixtureId}.json`), "utf8"));
    const expected = golden.selectedPoses.find((item: any) => item.hand === "R" && item.time === 0);

    expect(pose).toBeDefined();
    expect(pose.layer).toBe(1);
    expectNear(pose.wristJoints[0][2], expected.wristJoints[0][2], 0.01);
  });
});
