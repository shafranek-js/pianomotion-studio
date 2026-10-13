import { describe, expect, it } from "vitest";
import {
  ArtifactCacheKeySchema,
  EngineRequestSchema,
  EngineResponseSchema,
  M1AnalyzeMidiRequestSchema,
  M1AnalyzeMidiResultSchema,
  M1ReplanDocumentRequestSchema,
  M1ReplanDocumentResultSchema,
  M1EngineErrorSchema,
  M1EngineLifecycleSchema,
  M1EngineLoadRequestSchema,
  M1EngineLoadResultSchema,
  M1EngineProgressSchema,
  MotionPlanSchema,
  PerformancePlanSchema,
  ProjectPackageSchema,
  SongDocumentSchema,
  validateEngineResponseForRequest,
  validateM1AnalyzeMidiResultForRequest,
  validateM1ReplanDocumentResultForRequest,
  fingeringPlanForSong,
  performancePlanForSong,
} from "../src/index";

const note = (noteId: string, patch: Record<string, unknown> = {}) => ({
  noteId,
  trackId: "track-0",
  pitch: 60,
  velocity: 80,
  startSeconds: 0,
  endSeconds: 1,
  hand: "right",
  finger: null,
  glissando: false,
  ...patch,
});

const song = (patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  projectId: "project-a",
  revision: 3,
  title: "Untitled",
  durationSeconds: 2,
  tracks: [{ trackId: "track-0", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
  notes: [note("n1")],
  tempoMap: [],
  pedalControls: [],
  ...patch,
});

const profile = {
  schemaVersion: 1,
  profileId: "pianist-a",
  revision: 2,
  name: "Default",
  colorRgb: [12, 12, 14],
  anatomy: { wrist: 1 },
  behavior: { finger_curve: 0.4 },
  skin: { style: "skeleton" },
  weights: { stretch: 1 },
  createdAtUnixSeconds: 0,
  modifiedAtUnixSeconds: 1,
};

const planBase = {
  schemaVersion: 1,
  planId: "plan-a",
  projectId: "project-a",
  inputRevision: 3,
  profileId: "pianist-a",
  profileRevision: 2,
  engineVersion: "engine-0.1",
  diagnostics: [],
};

describe("SongDocument runtime validation", () => {
  it("allows distinct repeated/unison notes at the same pitch and time", () => {
    expect(SongDocumentSchema.parse(song({ notes: [note("n1"), note("n2")] })).notes).toHaveLength(2);
    expect(SongDocumentSchema.parse(song({ notes: [note("normalized", { sourceNoteIds: ["source-a", "source-b"] })] })).notes).toHaveLength(1);
  });

  it("rejects duplicate stable note IDs and unknown track references", () => {
    expect(SongDocumentSchema.safeParse(song({ notes: [note("same"), note("same")] })).success).toBe(false);
    expect(SongDocumentSchema.safeParse(song({ notes: [note("n1", { trackId: "missing" })] })).success).toBe(false);
    expect(SongDocumentSchema.safeParse(song({ notes: [
      note("n1", { sourceNoteIds: ["source-a"] }), note("n2", { sourceNoteIds: ["source-a"] }),
    ] })).success).toBe(false);
  });

  it("rejects negative, non-finite, and reversed source note times", () => {
    for (const bad of [
      note("n1", { startSeconds: -0.01 }),
      note("n1", { startSeconds: Number.NaN }),
      note("n1", { endSeconds: Number.POSITIVE_INFINITY }),
      note("n1", { endSeconds: 0 }),
    ]) expect(SongDocumentSchema.safeParse(song({ notes: [bad] })).success).toBe(false);
  });

  it("rejects an unsupported schema revision and unordered source events", () => {
    expect(SongDocumentSchema.safeParse(song({ schemaVersion: 2 })).success).toBe(false);
    expect(SongDocumentSchema.safeParse(song({ unexpectedField: true })).success).toBe(false);
    const tempoMap = [
      { timeSeconds: 1, microsecondsPerQuarterNote: 500000, eventOrdinal: 1 },
      { timeSeconds: 0, microsecondsPerQuarterNote: 600000, eventOrdinal: 2 },
    ];
    expect(SongDocumentSchema.safeParse(song({ tempoMap })).success).toBe(false);
  });
});

describe("derived plan and worker envelope validation", () => {
  const fingering = {
    ...planBase,
    kind: "fingering",
    profileId: "pianist-a",
    profileRevision: 2,
    assignments: [{ noteId: "n1", hand: "right", finger: 3, disposition: "played" }],
  };

  it("checks note references and the source revision in a fingering plan", () => {
    expect(fingeringPlanForSong(SongDocumentSchema.parse(song())).safeParse(fingering).success).toBe(true);
    expect(fingeringPlanForSong(SongDocumentSchema.parse(song())).safeParse({
      ...fingering, inputRevision: 2, assignments: [{ ...fingering.assignments[0], noteId: "missing" }],
    }).success).toBe(false);
  });

  it("requires each performed note to have one ordered press/release pair and valid source refs", () => {
    const performance = {
      ...planBase,
      kind: "performance",
      fingeringPlanId: "plan-a",
      events: [
        { type: "press", timeSeconds: 0.25, noteId: "n1", pitch: 60, velocity: 80 },
        { type: "release", timeSeconds: 0.75, noteId: "n1" },
      ],
    };
    const parsedSong = SongDocumentSchema.parse(song());
    expect(performancePlanForSong(parsedSong).safeParse(performance).success).toBe(true);
    expect(performancePlanForSong(parsedSong).safeParse({ ...performance, events: [{ ...performance.events[0], noteId: "missing" }, performance.events[1]] }).success).toBe(false);
    expect(PerformancePlanSchema.safeParse({ ...performance, events: [performance.events[1], performance.events[0]] }).success).toBe(false);
    expect(PerformancePlanSchema.safeParse({ ...performance, events: [performance.events[0]] }).success).toBe(false);
  });

  it("matches explicit marked gliss runs and source-note hand assignments", () => {
    const document = SongDocumentSchema.parse(song({ notes: [
      note("n1", { pitch: 60, startSeconds: 0.1, endSeconds: 0.3, glissando: true }),
      note("n2", { pitch: 62, startSeconds: 0.2, endSeconds: 0.4, glissando: true }),
      note("n3", { pitch: 64, startSeconds: 0.5, endSeconds: 0.8 }),
    ] }));
    const fingeringPlan = {
      ...planBase,
      kind: "fingering",
      assignments: [
        { noteId: "n1", hand: "right", finger: null, disposition: "glissando" },
        { noteId: "n2", hand: "right", finger: null, disposition: "glissando" },
        { noteId: "n3", hand: "right", finger: null, disposition: "unplayable" },
      ],
    };
    const request = {
      schemaVersion: 1, requestId: "req-2", operation: "motion", projectId: "project-a",
      inputRevision: 3, profileId: "pianist-a", profileRevision: 2, engineVersion: "engine-0.1",
      document, profile, options: {}, fingeringPlan,
      performancePlan: {
        ...planBase, kind: "performance", fingeringPlanId: fingeringPlan.planId,
        events: [
          { type: "press", timeSeconds: 0.1, noteId: "n1", pitch: 60, velocity: 80 },
          { type: "press", timeSeconds: 0.2, noteId: "n2", pitch: 62, velocity: 80 },
          { type: "release", timeSeconds: 0.7, noteId: "n2" },
          { type: "release", timeSeconds: 0.8, noteId: "n1" },
        ],
      },
    };
    expect(EngineRequestSchema.safeParse(request).success).toBe(true);
    const playedMarkedRun = {
      ...fingeringPlan,
      assignments: [
        { noteId: "n1", hand: "right", finger: 3, disposition: "played" },
        { noteId: "n2", hand: "right", finger: 3, disposition: "played" },
        fingeringPlan.assignments[2],
      ],
    };
    expect(fingeringPlanForSong(document).safeParse(playedMarkedRun).success).toBe(false);
    const wrongHandPlan = {
      ...fingeringPlan,
      assignments: [{ ...fingeringPlan.assignments[0], hand: "left" }, ...fingeringPlan.assignments.slice(1)],
    };
    expect(fingeringPlanForSong(document).safeParse(wrongHandPlan).success).toBe(false);
    expect(EngineRequestSchema.safeParse({
      ...request,
      fingeringPlan: wrongHandPlan,
    }).success).toBe(false);
    const solitaryMarkedSong = SongDocumentSchema.parse(song({ notes: [note("n1", { glissando: true })] }));
    expect(fingeringPlanForSong(solitaryMarkedSong).safeParse(fingering).success).toBe(true);
    expect(EngineRequestSchema.safeParse({
      ...request,
      performancePlan: { ...request.performancePlan, events: [
        ...request.performancePlan.events,
        { type: "press", timeSeconds: 0.5, noteId: "n3", pitch: 64, velocity: 80 },
        { type: "release", timeSeconds: 0.6, noteId: "n3" },
      ] },
    }).success).toBe(false);
  });

  it("requires the exact source pedal switch sequence in requests and responses", () => {
    const document = SongDocumentSchema.parse(song({ pedalControls: [
      { timeSeconds: 0, controller: 64, value: 63, eventOrdinal: 0 },
      { timeSeconds: 0.2, controller: 64, value: 64, eventOrdinal: 1 },
      { timeSeconds: 0.25, controller: 64, value: 100, eventOrdinal: 2 },
      { timeSeconds: 0.3, controller: 66, value: 64, eventOrdinal: 3 },
      { timeSeconds: 0.4, controller: 64, value: 63, eventOrdinal: 4 },
      { timeSeconds: 0.5, controller: 66, value: 0, eventOrdinal: 5 },
    ] }));
    const fingeringPlan = { ...planBase, kind: "fingering", assignments: [
      { noteId: "n1", hand: "right", finger: 3, disposition: "played" },
    ] };
    const performancePlan = {
      ...planBase, planId: "performance-a", kind: "performance", fingeringPlanId: fingeringPlan.planId,
      events: [
        { type: "press", timeSeconds: 0.1, noteId: "n1", pitch: 60, velocity: 80 },
        { type: "pedal", timeSeconds: 0.2, controller: 64, value: 127 },
        { type: "pedal", timeSeconds: 0.3, controller: 66, value: 127 },
        { type: "pedal", timeSeconds: 0.4, controller: 64, value: 0 },
        { type: "pedal", timeSeconds: 0.5, controller: 66, value: 0 },
        { type: "release", timeSeconds: 0.75, noteId: "n1" },
      ],
    };
    expect(performancePlanForSong(document).safeParse(performancePlan).success).toBe(true);
    const requestBase = {
      schemaVersion: 1, requestId: "pedal-request", projectId: "project-a",
      inputRevision: 3, profileId: "pianist-a", profileRevision: 2, engineVersion: "engine-0.1",
      document, profile, options: {}, fingeringPlan, performancePlan,
    };
    const motionRequest = { ...requestBase, operation: "motion" };
    expect(EngineRequestSchema.safeParse(motionRequest).success).toBe(true);
    const { performancePlan: _performancePlan, ...performanceRequestBase } = requestBase;
    void _performancePlan;
    const parsedPerformanceRequest = EngineRequestSchema.parse({ ...performanceRequestBase, operation: "performance" });
    const response = {
      schemaVersion: 1, ok: true, requestId: requestBase.requestId, operation: "performance", projectId: "project-a",
      inputRevision: 3, profileId: "pianist-a", profileRevision: 2, engineVersion: "engine-0.1",
      result: performancePlan,
    };
    expect(validateEngineResponseForRequest(parsedPerformanceRequest, response)).toEqual(response);
    const omitted = performancePlan.events.filter((event) => !(event.type === "pedal" && event.timeSeconds === 0.3));
    expect(performancePlanForSong(document).safeParse({ ...performancePlan, events: omitted }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...motionRequest, performancePlan: { ...performancePlan, events: omitted } }).success).toBe(false);
    const fabricated = [
      ...performancePlan.events.slice(0, -1),
      { type: "pedal", timeSeconds: 0.6, controller: 67, value: 127 },
      performancePlan.events[performancePlan.events.length - 1],
    ];
    expect(() => validateEngineResponseForRequest(parsedPerformanceRequest, { ...response, result: { ...performancePlan, events: fabricated } })).toThrow();
  });

  it("enforces release → pedal → press ordering at equal timestamps", () => {
    const prefix = { ...planBase, kind: "performance", fingeringPlanId: "plan-a" };
    const initialPress = { type: "press", timeSeconds: 0, noteId: "n1", pitch: 60, velocity: 80 };
    const release = { type: "release", timeSeconds: 1, noteId: "n1" };
    const pedal = { type: "pedal", timeSeconds: 1, controller: 64, value: 0 };
    const press = { type: "press", timeSeconds: 1, noteId: "n2", pitch: 60, velocity: 70 };
    const laterRelease = { type: "release", timeSeconds: 2, noteId: "n2" };
    expect(PerformancePlanSchema.safeParse({ ...prefix, events: [initialPress, release, pedal, press, laterRelease] }).success).toBe(true);
    expect(PerformancePlanSchema.safeParse({ ...prefix, events: [initialPress, pedal, release, press, laterRelease] }).success).toBe(false);
    expect(PerformancePlanSchema.safeParse({ ...prefix, events: [initialPress, release, press, pedal, laterRelease] }).success).toBe(false);
  });

  it("rejects stale request/response revisions and bad cache identities", () => {
    const request = {
      schemaVersion: 1, requestId: "req-1", operation: "fingering", projectId: "project-a", engineVersion: "engine-0.1",
      inputRevision: 2, profileId: "pianist-a", profileRevision: 2,
      document: song(), profile, options: {},
    };
    expect(EngineRequestSchema.safeParse(request).success).toBe(false);
    const response = {
      schemaVersion: 1, ok: true, requestId: "req-1", operation: "fingering",
      projectId: "project-a", inputRevision: 3, profileId: "pianist-a", profileRevision: 2,
      engineVersion: "engine-0.1", result: fingering,
    };
    expect(EngineResponseSchema.safeParse(response).success).toBe(true);
    expect(EngineResponseSchema.safeParse({ ...response, inputRevision: 4 }).success).toBe(false);
    const parsedRequest = EngineRequestSchema.parse({ ...request, inputRevision: 3 });
    expect(validateEngineResponseForRequest(parsedRequest, response)).toEqual(response);
    expect(() => validateEngineResponseForRequest(parsedRequest, {
      ...response,
      result: { ...fingering, assignments: [{ noteId: "missing", hand: "right", finger: 3, disposition: "played" }] },
    })).toThrow();
    expect(() => validateEngineResponseForRequest(parsedRequest, { ...response, requestId: "old-request" })).toThrow();
    expect(() => validateEngineResponseForRequest(parsedRequest, { ...response, profileRevision: 7 })).toThrow();
    const validFingering = { ...fingering, assignments: [{ noteId: "n1", hand: "right", finger: 3, disposition: "played" }] };
    const performanceRequest = {
      ...request,
      operation: "performance",
      inputRevision: 3,
      fingeringPlan: validFingering,
    };
    expect(EngineRequestSchema.safeParse(performanceRequest).success).toBe(true);
    const parsedPerformanceRequest = EngineRequestSchema.parse(performanceRequest);
    const invalidPerformanceResponse = {
      schemaVersion: 1, ok: true, requestId: performanceRequest.requestId, operation: "performance",
      projectId: "project-a", inputRevision: 3, profileId: "pianist-a", profileRevision: 2,
      engineVersion: "engine-0.1",
      result: {
        ...planBase, kind: "performance", fingeringPlanId: validFingering.planId,
        events: [
          { type: "press", timeSeconds: 0.25, noteId: "missing", pitch: 60, velocity: 80 },
          { type: "release", timeSeconds: 0.75, noteId: "missing" },
        ],
      },
    };
    expect(EngineResponseSchema.safeParse(invalidPerformanceResponse).success).toBe(true);
    expect(() => validateEngineResponseForRequest(parsedPerformanceRequest, invalidPerformanceResponse)).toThrow();
    expect(EngineRequestSchema.safeParse({
      ...performanceRequest,
      fingeringPlan: { ...validFingering, inputRevision: 2, assignments: [{ noteId: "unknown", hand: "right", finger: 3, disposition: "played" }] },
    }).success).toBe(false);
    const validMotionRequest = {
      ...performanceRequest,
      operation: "motion",
      performancePlan: {
        ...planBase,
        kind: "performance",
        fingeringPlanId: validFingering.planId,
        events: [
          { type: "press", timeSeconds: 0.25, noteId: "n1", pitch: 60, velocity: 80 },
          { type: "release", timeSeconds: 0.75, noteId: "n1" },
        ],
      },
    };
    expect(EngineRequestSchema.safeParse(validMotionRequest).success).toBe(true);
    expect(EngineRequestSchema.safeParse({
      ...validMotionRequest,
      performancePlan: { ...validMotionRequest.performancePlan, fingeringPlanId: "other-plan" },
    }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({
      ...validMotionRequest,
      performancePlan: { ...validMotionRequest.performancePlan, engineVersion: "old-engine" },
    }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({
      ...validMotionRequest,
      fingeringPlan: { ...validFingering, profileRevision: 1 },
    }).success).toBe(false);
    const parsedMotionRequest = EngineRequestSchema.parse(validMotionRequest);
    const motionResponse = {
      schemaVersion: 1, ok: true, requestId: "req-1", operation: "motion", projectId: "project-a",
      inputRevision: 3, profileId: "pianist-a", profileRevision: 2, engineVersion: "engine-0.1",
      result: {
        ...planBase, kind: "motion", performancePlanId: "plan-a", coordinateFrame: "keyboard-local-inches-v1",
        poses: [{
          transportTimeSeconds: -2, hand: "left", layerOrder: 1,
          bones: [{ a: [0, 0, 0], b: [1, 0, 0], kind: "forearm" }],
          joints: [{ point: [0, 0, 0], kind: "wrist" }],
        }],
      },
    };
    expect(validateEngineResponseForRequest(parsedMotionRequest, motionResponse)).toEqual(motionResponse);
    expect(() => validateEngineResponseForRequest(parsedMotionRequest, {
      ...motionResponse, result: { ...motionResponse.result, performancePlanId: "other-plan" },
    })).toThrow();
    expect(ArtifactCacheKeySchema.safeParse({
      projectId: "project-a", inputRevision: 3, profileId: "pianist-a", profileRevision: 2,
      engineVersion: "engine-0.1", operation: "fingering", parameterDigest: "a".repeat(64),
    }).success).toBe(true);
    expect(ArtifactCacheKeySchema.safeParse({
      projectId: "project-a", inputRevision: -1, profileId: "pianist-a", profileRevision: 2,
      engineVersion: "engine-0.1", operation: "fingering", parameterDigest: "bad",
    }).success).toBe(false);
  });

  it("keeps motion coordinates finite, typed, ordered, and in a named frame", () => {
    const pose = {
      transportTimeSeconds: -2,
      hand: "left",
      layerOrder: 1,
      bones: [{ a: [0, 0, 0], b: [1, 0, 0], kind: "forearm" }],
      joints: [{ point: [0, 0, 0], kind: "wrist" }],
    };
    const plan = {
      ...planBase, kind: "motion", profileId: "pianist-a", profileRevision: 2,
      performancePlanId: "performance-a", coordinateFrame: "keyboard-local-inches-v1", poses: [pose],
    };
    expect(MotionPlanSchema.safeParse(plan).success).toBe(true);
    expect(MotionPlanSchema.safeParse({ ...plan, poses: [{ ...pose, transportTimeSeconds: -2.01 }] }).success).toBe(false);
    expect(MotionPlanSchema.safeParse({ ...plan, poses: [{ ...pose, bones: [{ ...pose.bones[0], b: [Infinity, 0, 0] }] }] }).success).toBe(false);
    expect(MotionPlanSchema.safeParse({ ...plan, poses: [pose, { ...pose, hand: "right" }] }).success).toBe(true);
    expect(MotionPlanSchema.safeParse({ ...plan, poses: [pose, { ...pose, hand: "right", layerOrder: 0 }] }).success).toBe(true);
    expect(MotionPlanSchema.safeParse({ ...plan, poses: [{ ...pose, hand: "right" }, pose] }).success).toBe(false);
    expect(MotionPlanSchema.safeParse({ ...plan, poses: [{ ...pose, layerOrder: 0 }, { ...pose, hand: "right", layerOrder: 0 }] }).success).toBe(true);
    expect(MotionPlanSchema.safeParse({ ...plan, poses: [pose, { ...pose, layerOrder: 2 }] }).success).toBe(false);
  });

  it("validates package resource references and paths", () => {
    const descriptor = { resourceId: "midi-1", purpose: "source-midi", mediaType: "audio/midi", byteLength: 1, sha256: "a".repeat(64), path: "resources/source.mid" };
    const project = {
      packageVersion: 1,
      projectId: "project-a",
      document: song({ sourceMidiResourceId: "midi-1" }),
      profiles: [profile],
      resources: [descriptor],
      resourcePayloads: { "resources/source.mid": "AA==" },
    };
    expect(ProjectPackageSchema.safeParse(project).success).toBe(true);
    expect(ProjectPackageSchema.safeParse({ ...project, resources: [{ ...descriptor, path: "../source.mid" }] }).success).toBe(false);
    expect(ProjectPackageSchema.safeParse({ ...project, resources: [] }).success).toBe(false);
  });
});

describe("M1 binary worker protocol", () => {
  const engineVersion = "b".repeat(64);
  const baselineHash = "a".repeat(64);
  const sourceMidiResourceId = "source-midi/test-fixture";
  const request = M1AnalyzeMidiRequestSchema.parse({
    type: "analyze-midi",
    requestId: "m1-request-1",
    projectId: "project-a",
    revision: 3,
    engineVersion,
    midiBytes: new Uint8Array([0x4d, 0x54, 0x68]).buffer,
    profile,
    options: {
      fixtureId: "test-fixture",
      keyStyle: "realistic",
      keyboardRect: [0, 0, 1400, 150],
      sampleTimes: [0],
    },
  });
  const document = song({
    sourceMidiResourceId,
    notes: [note("n1", { sourceNoteIds: ["source-a"] })],
  });
  const fingeringPlan = {
    ...planBase,
    planId: "m1-fingering",
    engineVersion,
    kind: "fingering",
    assignments: [{ noteId: "n1", hand: "right", finger: 3, disposition: "played" }],
  };
  const performancePlan = {
    ...planBase,
    planId: "m1-performance",
    engineVersion,
    kind: "performance",
    fingeringPlanId: fingeringPlan.planId,
    events: [
      { type: "press", timeSeconds: 0.1, noteId: "n1", pitch: 60, velocity: 80 },
      { type: "release", timeSeconds: 0.9, noteId: "n1" },
    ],
  };
  const motionPlan = {
    ...planBase,
    planId: "m1-motion",
    engineVersion,
    kind: "motion",
    performancePlanId: performancePlan.planId,
    coordinateFrame: "keyboard-local-inches-v1",
    poses: [{
      transportTimeSeconds: 0,
      hand: "right",
      layerOrder: 0,
      bones: [{ a: [0, 0, 0], b: [1, 0, 0], kind: "forearm" }],
      joints: [{ point: [0, 0, 0], kind: "wrist" }],
    }],
  };
  const rawBaseline = {
    fixtureId: "test-fixture",
    inputSha256: baselineHash,
    status: "loaded",
    duration: 2,
    sourceNotes: [{
      noteId: "source-a", sourceInstrument: 0, sourceOrdinal: 0,
      pitch: 60, velocity: 80, start: 0, end: 1,
    }],
    sourcePedals: [],
    sourceParseErrors: [],
    desktopNotes: [{
      noteId: "n1", sourceNoteIds: ["source-a"], track: 0, pitch: 60, velocity: 80,
      start: 0, end: 1, hand: "R", manualFinger: null, gliss: false,
    }],
    assignments: [{
      noteId: "n1", sourceNoteIds: ["source-a"], hand: "R", finger: 3, manualFinger: null, gliss: false,
    }],
    performanceEvents: [{
      noteId: "n1", sourceNoteIds: ["source-a"], hand: "R", press: 0.1, release: 0.9,
    }],
    pedals: [],
    rawPedals: [],
    selectedPoses: [{
      hand: "R",
      time: 0,
      layer: 0,
      coordinateFrame: {
        units: "screen pixels",
        keyboardRect: [0, 0, 1400, 150],
        origin: "top-left of keyboardRect",
        axes: { x: "right", y: "down", z: "up toward viewer" },
        pixelsPerInch: 28.99,
        frontY: 150,
      },
      armEnd: [0, 1, 2],
      boneCount: 1,
      bones: [{ start: [0, 0, 0], end: [1, 0, 0], type: "forearm" }],
      fingerTips: { "1": [0, 0, 0], "2": [0, 0, 0], "3": [0, 0, 0], "4": [0, 0, 0], "5": [0, 0, 0] },
      fingerChains: { "1": [[0, 0, 0]], "2": [[0, 0, 0]], "3": [[0, 0, 0]], "4": [[0, 0, 0]], "5": [[0, 0, 0]] },
      jointCount: 1,
      joints: [{ position: [0, 0, 0], type: "wrist" }],
      wristJoints: [[0, 0, 0]],
      wristPose: { positionPx: [0, 0], headingRadians: 0 },
    }],
    cleanup: [],
    unmappedSourceNoteIds: [],
    tracks: [{ index: 0, name: "Piano", program: 0, noteCount: 1, declaredHand: "R" }],
    hands: [{ hand: "R", assignedCount: 1, rolledChords: 0, glissRuns: [] }],
    crossingEpisodes: [],
    identityLosses: [],
    identityMappings: [{
      noteId: "source-a", sourceInstrument: 0, sourceOrdinal: 0,
      rawEvents: [{ midiTrackIndex: 0, channel: 0, noteOnOrdinal: 0, noteOffOrdinal: 1 }],
      normalizedNoteId: "n1", status: "exact",
    }],
    sourceNoteIdentitySemantics: "IDs are decoded instrument/note ordinals; raw locators are observed only when unique.",
    provenance: {
      profile: "explicit per-job PianistProfile DTO",
      engineVersion,
      desktopSourceCommit: "f".repeat(40),
      desktopVersion: "v26.1.20",
      adaptedFiles: { "api.py": "c".repeat(64) },
      keyStyle: "realistic",
      rawEventCount: 2,
    },
    goldenTrust: "desktop observation fixture for protocol tests",
  };
  const resource = {
    resourceId: sourceMidiResourceId,
    purpose: "source-midi",
    mediaType: "audio/midi",
    byteLength: 3,
    sha256: baselineHash,
    path: "resources/source.mid",
  };
  const result = {
    type: "analysis-result",
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    engineVersion,
    status: "loaded",
    profile,
    resource,
    document,
    fingeringPlan,
    performancePlan,
    motionPlan,
    diagnostics: [],
    rawBaseline,
  };
  const replanRequest = M1ReplanDocumentRequestSchema.parse({
    type: "replan-document",
    requestId: "m1-replan-request-1",
    projectId: request.projectId,
    revision: request.revision,
    engineVersion,
    midiBytes: request.midiBytes,
    document,
    fingeringPlan,
    profile,
    resource,
    rawBaseline,
    options: { fixtureId: "test-fixture", keyStyle: "realistic" },
  });
  const replanResult = {
    ...result,
    type: "replan-document-result",
    requestId: "m1-replan-request-1",
    keyStyle: "realistic",
  };

  it("requires a real ArrayBuffer and validates ordered analysis options", () => {
    expect(M1AnalyzeMidiRequestSchema.safeParse(request).success).toBe(true);
    expect(M1AnalyzeMidiRequestSchema.safeParse({ ...request, midiBytes: "TWho" }).success).toBe(false);
    expect(M1AnalyzeMidiRequestSchema.safeParse({ ...request, midiBytes: new Uint8Array([1, 2, 3]) }).success).toBe(false);
    expect(M1AnalyzeMidiRequestSchema.safeParse({ ...request, options: { ...request.options, keyboardRect: [0, 0, 0, 150] } }).success).toBe(false);
    expect(M1AnalyzeMidiRequestSchema.safeParse({ ...request, options: { ...request.options, sampleTimes: [1, 0] } }).success).toBe(false);
  });

  it("validates loaded and repaired typed artifacts against the request", () => {
    expect(validateM1AnalyzeMidiResultForRequest(request, result)).toEqual(result);
    const repaired = {
      ...result,
      status: "repaired",
      rawBaseline: { ...rawBaseline, status: "repaired", cleanup: ["repaired a malformed track event"] },
    };
    expect(M1AnalyzeMidiResultSchema.safeParse(repaired).success).toBe(true);
    expect(validateM1AnalyzeMidiResultForRequest(request, repaired)).toEqual(repaired);
  });

  it("validates a complete typed-document replan result and request references", () => {
    expect(M1ReplanDocumentResultSchema.safeParse(replanResult).success).toBe(true);
    expect(validateM1ReplanDocumentResultForRequest(replanRequest, replanResult)).toEqual(replanResult);
    expect(() => validateM1ReplanDocumentResultForRequest(replanRequest, {
      ...replanResult,
      keyStyle: "equal",
    })).toThrow();
    expect(() => validateM1ReplanDocumentResultForRequest(replanRequest, {
      ...replanResult,
      document: { ...document, notes: [note("renamed-note")] },
    })).toThrow();
  });

  it("keeps explicit manual fingers pinned to the edited document across replanning", () => {
    const pinnedDocument = { ...document, notes: [{ ...document.notes[0]!, finger: 4 }] };
    const pinnedPlan = {
      ...fingeringPlan,
      assignments: [{ ...fingeringPlan.assignments[0]!, finger: 4, fingerMode: "manual" as const }],
    };
    const pinnedRequest = M1ReplanDocumentRequestSchema.parse({
      ...replanRequest,
      document: pinnedDocument,
      fingeringPlan: pinnedPlan,
    });
    const pinnedResult = {
      ...replanResult,
      document: pinnedDocument,
      fingeringPlan: pinnedPlan,
    };
    expect(validateM1ReplanDocumentResultForRequest(pinnedRequest, pinnedResult)).toEqual(pinnedResult);
    expect(M1ReplanDocumentRequestSchema.safeParse({
      ...pinnedRequest,
      document: { ...pinnedDocument, notes: [{ ...pinnedDocument.notes[0]!, finger: 3 }] },
    }).success).toBe(false);
    expect(() => validateM1ReplanDocumentResultForRequest(pinnedRequest, {
      ...pinnedResult,
      fingeringPlan: {
        ...pinnedPlan,
        assignments: [{ ...pinnedPlan.assignments[0]!, finger: 3 }],
      },
    })).toThrow();
  });

  it("rejects stale identities, wrong source references, and incomplete alias mapping", () => {
    expect(() => validateM1AnalyzeMidiResultForRequest(request, { ...result, revision: 4 })).toThrow();
    expect(() => validateM1AnalyzeMidiResultForRequest(request, {
      ...result,
      performancePlan: { ...performancePlan, fingeringPlanId: "stale-plan" },
    })).toThrow();
    expect(() => validateM1AnalyzeMidiResultForRequest(request, {
      ...result,
      rawBaseline: { ...rawBaseline, identityMappings: [] },
    })).toThrow();
    expect(() => validateM1AnalyzeMidiResultForRequest(request, {
      ...result,
      motionPlan: { ...motionPlan, performancePlanId: "stale-performance" },
    })).toThrow();
    expect(() => validateM1AnalyzeMidiResultForRequest(request, {
      ...result,
      resource: { ...resource, byteLength: 2 },
    })).toThrow();
    expect(() => validateM1AnalyzeMidiResultForRequest(request, {
      ...result,
      rawBaseline: { ...rawBaseline, provenance: { ...rawBaseline.provenance, engineVersion: "d".repeat(64) } },
    })).toThrow();
    expect(() => validateM1AnalyzeMidiResultForRequest(request, {
      ...result,
      rawBaseline: {
        ...rawBaseline,
        sourceNotes: [{ ...rawBaseline.sourceNotes[0]!, sourceEvent: rawBaseline.identityMappings[0]!.rawEvents[0] },
        ],
        identityMappings: [{ ...rawBaseline.identityMappings[0]!, status: "decoded-only", rawEvents: [] }],
      },
    })).toThrow();
  });

  it("keeps ambiguous source-event identity explicit without inventing a raw locator", () => {
    const ambiguous = {
      ...result,
      diagnostics: [{ severity: "warning", code: "source-event-ambiguous", message: "source identity cannot be attributed uniquely", noteIds: ["n1"] }],
      rawBaseline: {
        ...rawBaseline,
        sourceNotes: [{ ...rawBaseline.sourceNotes[0]!, sourceEvent: undefined }],
        identityMappings: [{ ...rawBaseline.identityMappings[0]!, rawEvents: [], status: "ambiguous" }],
      },
    };
    expect(validateM1AnalyzeMidiResultForRequest(request, ambiguous).rawBaseline.identityMappings[0]?.status).toBe("ambiguous");
    expect(() => validateM1AnalyzeMidiResultForRequest(request, {
      ...ambiguous,
      rawBaseline: {
        ...ambiguous.rawBaseline,
        sourceNotes: [{ ...ambiguous.rawBaseline.sourceNotes[0]!, sourceEvent: rawBaseline.identityMappings[0]!.rawEvents[0] },
        ],
      },
    })).toThrow();
  });

  it("represents rejected MIDI as an invalid result with observed loader diagnostics", () => {
    const invalid = {
      ...result,
      status: "invalid",
      document: null,
      fingeringPlan: null,
      performancePlan: null,
      motionPlan: null,
      diagnostics: [{ severity: "error", code: "midi-load-failed", message: "MThd not found" }],
      rawBaseline: {
        ...rawBaseline,
        status: "invalid-or-rejected",
        duration: undefined,
        sourceNotes: [],
        sourceParseErrors: [{ message: "MThd not found", phase: "mido source inventory", type: "OSError" }],
        loadError: { message: "MThd not found", type: "OSError" },
        desktopNotes: [],
        assignments: [],
        performanceEvents: [],
        selectedPoses: [],
        tracks: [],
        hands: [],
        crossingEpisodes: [],
        identityLosses: [],
        identityMappings: [],
        unmappedSourceNoteIds: [],
      },
      resource: { ...resource, byteLength: 3 },
    };
    expect(M1AnalyzeMidiResultSchema.safeParse(invalid).success).toBe(true);
    expect(validateM1AnalyzeMidiResultForRequest(request, invalid).status).toBe("invalid");
    expect(M1AnalyzeMidiResultSchema.safeParse({ ...invalid, rawBaseline: { ...invalid.rawBaseline, loadError: undefined } }).success).toBe(false);
    expect(M1AnalyzeMidiResultSchema.safeParse({ ...invalid, document }).success).toBe(false);
  });

  it("keeps Worker lifecycle stages and identities typed", () => {
    const identity = {
      requestId: request.requestId,
      projectId: request.projectId,
      revision: request.revision,
      engineVersion,
    };
    expect(M1EngineLoadRequestSchema.safeParse({ type: "engine-load", ...identity }).success).toBe(true);
    expect(M1EngineProgressSchema.safeParse({ type: "progress", ...identity, stage: "load", progress: 0.5 }).success).toBe(true);
    expect(M1EngineLoadResultSchema.safeParse({
      type: "engine-loaded", ...identity, runtime: "pyodide", runtimeVersion: "0.29.3",
      pythonVersion: "3.14.0", packageVersions: { numpy: "2.4.6", mido: "1.3.3" },
    }).success).toBe(true);
    expect(M1EngineErrorSchema.safeParse({
      type: "worker-error", ...identity, stage: "init",
      error: { code: "PYODIDE_INIT", message: "runtime failed", retryable: true },
    }).success).toBe(true);
    expect(M1EngineLifecycleSchema.safeParse({ type: "cancelled", ...identity, stage: "compute" }).success).toBe(true);
    expect(M1EngineProgressSchema.safeParse({ type: "progress", ...identity, stage: "unknown" }).success).toBe(false);
    expect(M1EngineProgressSchema.safeParse({ type: "progress", ...identity, stage: "load", progress: 1.2 }).success).toBe(false);
  });
});
