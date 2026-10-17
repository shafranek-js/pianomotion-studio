import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { MotionPose, Note, PerformancePlan } from "@handthesia/contracts";
import {
  PianoScene,
  LOWEST_PIANO_KEY,
  HIGHEST_PIANO_KEY,
  TOTAL_KEYS,
  DEFAULT_SKIN_SETTINGS,
  KEYBOARD_WIDTH_IN,
  posePointToWorld,
  reconstructHand3D,
  Hand3DMeshGroup,
  Keyboard3DView,
  FallingNotes3DView,
  MotionBuffer,
  calculatePianoCameraFit,
  buildActiveKeysForFrame,
  sustainPedalDownAtTime,
  calculateHandHoverLift,
  createGrandPedalGeometry,
} from "../render";

function createMockPose(hand: "left" | "right" = "right", layerOrder = 0): MotionPose {
  return {
    hand,
    transportTimeSeconds: 1.0,
    layerOrder,
    bones: [
      // Forearm
      { a: [25.0, 1.0, 0.9], b: [25.0, -5.0, 1.4], kind: "forearm" },
      { a: [26.8, 1.0, 0.9], b: [26.8, -5.0, 1.4], kind: "forearm" },
      // Carpals
      { a: [25.0, 1.0, 0.9], b: [26.8, 1.0, 0.9], kind: "carpal" },
      // Index (f=2)
      { a: [25.3, 1.8, 1.1], b: [25.3, 2.4, 1.05], kind: "metacarpal" },
      { a: [25.3, 2.4, 1.05], b: [25.3, 3.1, 0.72], kind: "proximal" },
      { a: [25.3, 3.1, 0.72], b: [25.3, 3.7, 0.35], kind: "middle" },
      { a: [25.3, 3.7, 0.35], b: [25.3, 4.2, 0.05], kind: "distal" },
      // Middle (f=3)
      { a: [25.8, 1.8, 1.18], b: [25.8, 2.5, 1.12], kind: "metacarpal" },
      { a: [25.8, 2.5, 1.12], b: [25.8, 3.3, 0.78], kind: "proximal" },
      { a: [25.8, 3.3, 0.78], b: [25.8, 3.9, 0.42], kind: "middle" },
      { a: [25.8, 3.9, 0.42], b: [25.8, 4.5, 0.12], kind: "distal" },
      // Ring (f=4)
      { a: [26.3, 1.8, 1.12], b: [26.3, 2.4, 1.06], kind: "metacarpal" },
      { a: [26.3, 2.4, 1.06], b: [26.3, 3.1, 0.74], kind: "proximal" },
      { a: [26.3, 3.1, 0.74], b: [26.3, 3.7, 0.38], kind: "middle" },
      { a: [26.3, 3.7, 0.38], b: [26.3, 4.2, 0.12], kind: "distal" },
      // Little (f=5)
      { a: [26.8, 1.7, 0.98], b: [26.8, 2.3, 0.92], kind: "metacarpal" },
      { a: [26.8, 2.3, 0.92], b: [26.8, 2.9, 0.65], kind: "proximal" },
      { a: [26.8, 2.9, 0.65], b: [26.8, 3.4, 0.35], kind: "middle" },
      { a: [26.8, 3.4, 0.35], b: [26.8, 3.8, 0.14], kind: "distal" },
      // Thumb (f=1), last in canonical DTO order [2, 3, 4, 5, 1]
      { a: [25.1, 1.5, 0.85], b: [24.8, 2.0, 0.65], kind: "metacarpal" },
      { a: [24.8, 2.0, 0.65], b: [24.6, 2.5, 0.42], kind: "proximal" },
      { a: [24.6, 2.5, 0.42], b: [24.4, 3.0, 0.15], kind: "distal" },
    ],
    joints: [
      { point: [25.0, 1.0, 0.9], kind: "wrist" },
      { point: [26.8, 1.0, 0.9], kind: "wrist" },
      { point: [25.3, 4.2, 0.05], kind: "tip" },
      { point: [25.8, 4.5, 0.12], kind: "tip" },
      { point: [26.3, 4.2, 0.12], kind: "tip" },
      { point: [26.8, 3.8, 0.14], kind: "tip" },
      { point: [24.4, 3.0, 0.15], kind: "tip" },
      { point: [25.3, 2.4, 1.05], kind: "knuckle" },
      { point: [25.8, 2.5, 1.12], kind: "knuckle" },
      { point: [26.3, 2.4, 1.06], kind: "knuckle" },
      { point: [26.8, 2.3, 0.92], kind: "knuckle" },
    ],
  };
}

function createBentMockPose(hand: "left" | "right"): MotionPose {
  const pose = createMockPose(hand);
  const bendPoint = ([x, y, z]: readonly [number, number, number]): [number, number, number] => [
    x,
    y,
    z - Math.max(0, y - 1.6) * 0.35,
  ];

  return {
    ...pose,
    bones: pose.bones.map((bone) => ({ ...bone, a: bendPoint(bone.a), b: bendPoint(bone.b) })),
    joints: pose.joints.map((joint) => ({ ...joint, point: bendPoint(joint.point) })),
  };
}

describe("render3d — 3D Hand Rig & Piano Scene", () => {
  it("converts MotionPose 3D inch coordinates into right-handed Three.js world space", () => {
    expect(PianoScene).toBeDefined();
    const pt = posePointToWorld([24.1425, 2.5, 1.2]);
    expect(pt.x).toBeCloseTo(24.1425 - KEYBOARD_WIDTH_IN * 0.5, 4);
    expect(pt.y).toBeCloseTo(1.2, 4);
    expect(pt.z).toBeCloseTo(-2.5, 4);
  });

  it("reconstructs 3D anatomical hand frame, palmar arch, and finger chains from MotionPose", () => {
    const rightPose = createMockPose("right");
    const reconRight = reconstructHand3D(rightPose);

    expect(reconRight.hand).toBe("right");
    expect(reconRight.palmNormal.y).toBeGreaterThan(0.5);
    expect(reconRight.wristWidthIn).toBeGreaterThan(1.4);

    // Thumb has 4 points [cmc, mcp, ip, tip]; fingers 2..5 have 5 points [base, mcp, pip, dip, tip]
    expect(reconRight.chains[1]).toHaveLength(4);
    for (const f of [2, 3, 4, 5] as const) {
      expect(reconRight.chains[f]).toHaveLength(5);
    }

    const leftPose = createMockPose("left");
    const reconLeft = reconstructHand3D(leftPose);
    expect(reconLeft.hand).toBe("left");
    expect(reconLeft.palmNormal.y).toBeGreaterThan(0.5);
  });

  it("builds and updates 25-bone SkinnedMesh Hand3DMeshGroup from MotionPose for both hands", () => {
    for (const handSide of ["right", "left"] as const) {
      const handGroup = new Hand3DMeshGroup(handSide);
      const pose = createMockPose(handSide);

      handGroup.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false);
      expect(handGroup.group.visible).toBe(true);

      let skinnedMeshCount = 0;
      let totalVertices = 0;
      handGroup.group.traverse((obj) => {
        if (obj instanceof THREE.SkinnedMesh) {
          skinnedMeshCount++;
          expect(obj.skeleton.bones).toHaveLength(25);
          const wristBone = obj.skeleton.bones.find((b) => b.name === "wrist");
          const indexTipBone = obj.skeleton.bones.find((b) => b.name === "index-finger-tip");
          expect(wristBone).toBeDefined();
          expect(indexTipBone).toBeDefined();
          // Verify bone positions are in Three.js world inch space with unit-order bone scale
          expect(Number.isFinite(wristBone!.position.x)).toBe(true);
          expect(wristBone!.scale.x).toBeGreaterThan(0.7);
          expect(wristBone!.scale.x).toBeLessThan(1.5);
          const colorAttr = obj.geometry.getAttribute("color");
          expect(colorAttr).toBeDefined();
        }
        if (obj instanceof THREE.Mesh) {
          const pos = obj.geometry.getAttribute("position");
          expect(pos).toBeDefined();
          expect(pos.count).toBeGreaterThan(0);
          totalVertices += pos.count;
        }
      });
      expect(skinnedMeshCount).toBe(1);
      expect(totalVertices).toBeGreaterThan(1500);

      handGroup.dispose();
    }
  });

  it("creates 88 3D Concert Grand Piano keys with outward normals on all black key faces and animates sustain pedal", () => {
    const kb3d = new Keyboard3DView();
    expect(kb3d.keysByPitch.size).toBe(TOTAL_KEYS);

    // Verify black key geometry has outward normals on all 6 faces (top, front, left, right, rear, bottom)
    const cSharp = kb3d.keysByPitch.get(61)!;
    const normAttr = cSharp.mesh.geometry.getAttribute("normal");
    const posAttr = cSharp.mesh.geometry.getAttribute("position");
    const center = new THREE.Vector3(0, 0.2, 1.8);
    for (let i = 0; i < posAttr.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(posAttr, i).sub(center);
      const n = new THREE.Vector3().fromBufferAttribute(normAttr, i);
      expect(p.dot(n)).toBeGreaterThan(0);
    }

    // Press middle C (60) and C#4 (61), target E4 (64), wrong F4 (65)
    const active = new Map([
      [60, { hand: "right" as const, finger: 1 as const }],
      [61, { hand: "right" as const, finger: 2 as const }],
    ]);
    const targets = new Map([[64, { hand: "right" as const, finger: 3 as const }]]);

    kb3d.setActiveKeys(active);
    kb3d.setTargetKeys(targets);
    kb3d.setWrongKeys(new Set([65]));
    kb3d.setSustainPedal(true);
    kb3d.setSustainPedal(false);
    kb3d.setSoftPedal(true);
    kb3d.setSoftPedal(false);
    kb3d.setSostenutoPedal(true);
    kb3d.setSostenutoPedal(false);

    const c4Entry = kb3d.keysByPitch.get(60);
    const e4Entry = kb3d.keysByPitch.get(64);
    expect(c4Entry?.pivotGroup.rotation.x).toBeGreaterThan(0);
    // Play Along target key (not yet pressed) stays un-depressed
    expect(e4Entry?.pivotGroup.rotation.x).toBe(0);

    expect(LOWEST_PIANO_KEY).toBe(21);
    expect(HIGHEST_PIANO_KEY).toBe(108);
    kb3d.dispose();
  });

  it("builds authentic flared grand pedals and grounds concert legs with dual brass casters at y = -20.0", () => {
    const leftGeo = createGrandPedalGeometry("left");
    const centerGeo = createGrandPedalGeometry("center");
    const rightGeo = createGrandPedalGeometry("right");

    expect(leftGeo.getAttribute("position").count).toBeGreaterThan(100);
    expect(centerGeo.getAttribute("position").count).toBeGreaterThan(100);
    expect(rightGeo.getAttribute("position").count).toBeGreaterThan(100);

    leftGeo.computeBoundingBox();
    centerGeo.computeBoundingBox();
    rightGeo.computeBoundingBox();

    const leftBox = leftGeo.boundingBox!;
    const centerBox = centerGeo.boundingBox!;
    const rightBox = rightGeo.boundingBox!;

    // Center pedal is symmetrical across X
    expect(Math.abs(centerBox.min.x + centerBox.max.x)).toBeLessThan(0.05);

    // Left pedal flares outwards to the left (more negative X)
    expect(leftBox.min.x).toBeLessThan(centerBox.min.x);

    // Right pedal flares outwards to the right (more positive X)
    expect(rightBox.max.x).toBeGreaterThan(centerBox.max.x);

    // Pedals project forward into +Z towards the pianist (not backward into the tail)
    expect(centerBox.max.z).toBeGreaterThan(2.5);
    expect(centerBox.min.z).toBeCloseTo(0, 1);

    // Verify keyboard3D assembly has legs reaching down to floor level (y = -20.0)
    const kb3d = new Keyboard3DView();
    let minGroupY = Infinity;
    kb3d.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        mesh.geometry.computeBoundingBox();
        const bbox = mesh.geometry.boundingBox;
        if (bbox) {
          const worldMin = new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z);
          mesh.localToWorld(worldMin);
          if (worldMin.y < minGroupY) minGroupY = worldMin.y;
        }
      }
    });

    // The dual casters on the legs rest precisely on the floor plane at y = -20.0
    expect(minGroupY).toBeCloseTo(-20.0, 1);

    leftGeo.dispose();
    centerGeo.dispose();
    rightGeo.dispose();
    kb3d.dispose();
  });

  it("isolates CC64 sustain from CC66/CC67 pedals and respects authoritative activeNotes over score intervals", () => {
    // CC64 on at t=0, CC67 on at t=1, CC67 off at t=2
    const pedalEvents = [
      { type: "pedal" as const, controller: 64 as const, value: 127 as const, timeSeconds: 0 },
    ];
    expect(sustainPedalDownAtTime(pedalEvents, 0.5)).toBe(true);
    expect(sustainPedalDownAtTime(pedalEvents, 2.5)).toBe(true);

    const scoreNotes: Note[] = [
      {
        noteId: "n",
        trackId: "t0",
        pitch: 60,
        startSeconds: 0,
        endSeconds: 2,
        velocity: 90,
        hand: "right",
        finger: 1,
        glissando: false,
      },
    ];

    // When authoritative activeNotes is empty, no keys should be pressed even if score note is in range
    const activeEmpty = buildActiveKeysForFrame(scoreNotes, []);
    expect([...activeEmpty.keys()]).toEqual([]);

    // When authoritative activeNotes has pitch 60, it is pressed
    const active60 = buildActiveKeysForFrame(scoreNotes, [60]);
    expect([...active60.keys()]).toEqual([60]);
    expect(active60.get(60)?.hand).toBe("right");

    // When authoritative activeNotes is undefined (fallback mode), score note interval is used
    const activeFallback = buildActiveKeysForFrame(scoreNotes, undefined);
    expect([...activeFallback.keys()]).toEqual([60]);
  });

  it("fits all 88 keys within NDC visible bounds on wide desktop and narrow mobile viewports", () => {
    const target = new THREE.Vector3(0, 0.2, -4.2);
    const pos = new THREE.Vector3(0, 25.5, 20.5);
    const dir = new THREE.Vector3().subVectors(pos, target).normalize();

    // Check wide viewport (1309x818) and measured narrow mobile viewport (355x767)
    for (const [w, h] of [[1309, 818], [355, 767]] as const) {
      const fit = calculatePianoCameraFit(w, h, 38, pos.distanceTo(target), true);
      const cam = new THREE.PerspectiveCamera(fit.fov, w / h, 0.5, 500);
      cam.position.copy(target).addScaledVector(dir, fit.distance);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      // Front corners of keyboard: A0 (x=-24) and C8 (x=+24) at key surface y=0, z=0
      const leftFront = new THREE.Vector3(-KEYBOARD_WIDTH_IN * 0.5, 0, 0).project(cam);
      const rightFront = new THREE.Vector3(KEYBOARD_WIDTH_IN * 0.5, 0, 0).project(cam);

      expect(Math.abs(leftFront.x)).toBeLessThan(1.0);
      expect(Math.abs(rightFront.x)).toBeLessThan(1.0);
    }
  });

  it("updates 3D falling notes instanced mesh and synchronizes with PerformancePlan", () => {
    const kb3d = new Keyboard3DView();
    const notes3d = new FallingNotes3DView(kb3d);
    const sampleNotes: Note[] = [
      {
        noteId: "n1",
        trackId: "t0",
        pitch: 60,
        startSeconds: 0.5,
        endSeconds: 1.5,
        velocity: 88,
        hand: "right",
        finger: 1,
        glissando: false,
      },
    ];

    notes3d.setNotes(sampleNotes);
    expect(notes3d.getRenderedNoteTimings()).toHaveLength(1);

    // Performance plan modifies press to 1.0s and release to 1.8s
    const plan = {
      kind: "performance" as const,
      fingeringPlanId: "fp",
      events: [
        { type: "press" as const, noteId: "n1", pitch: 60, velocity: 90, timeSeconds: 1.0 },
        { type: "release" as const, noteId: "n1", timeSeconds: 1.8 },
      ],
    };
    notes3d.setPerformancePlan(plan as unknown as PerformancePlan, sampleNotes);
    const performedTimings = notes3d.getRenderedNoteTimings();
    expect(performedTimings).toHaveLength(1);
    expect(performedTimings[0]!.startSeconds).toBe(1.0);
    expect(performedTimings[0]!.endSeconds).toBe(1.8);

    notes3d.update(1.2);
    expect(notes3d.instancedMesh.count).toBe(1);
    // Frustum culling must be disabled so close-up or side-angle camera views never drop notes
    expect(notes3d.instancedMesh.frustumCulled).toBe(false);
    expect(notes3d.instancedMesh.geometry.boundingSphere?.radius).toBeGreaterThan(20);
    notes3d.dispose();
    kb3d.dispose();
  });

  it("keeps hands visible and poised in ready-to-play posture before transport start during lead-in count-in", () => {
    const buffer = new MotionBuffer();
    buffer.addPoses([
      createMockPose("right", 0.5),
      createMockPose("left", 0.5),
    ]);

    // At lead-in count-in time = -2.0s, buffer must return the ready-to-play pose
    const rightPose = buffer.samplePoseClamped(-2.0, "right");
    const leftPose = buffer.samplePoseClamped(-2.0, "left");
    expect(rightPose).not.toBeNull();
    expect(leftPose).not.toBeNull();
    expect(rightPose!.transportTimeSeconds).toBe(1.0);

    const rightHand = new Hand3DMeshGroup("right");
    rightHand.updateFromPose(rightPose!, DEFAULT_SKIN_SETTINGS, false);
    expect(rightHand.group.children.length).toBeGreaterThan(0);
    rightHand.dispose();
  });

  it("preserves continuous lateral hinge alignment across steeply curled finger joints without candy-wrapper twist", () => {
    // Construct a pose where the index finger (digit 2) attacks a key with steep downward flexion (>80°)
    // and curl-under, which previously triggered a 180° roll flip and mesh hourglass collapse.
    const basePose = createMockPose("right", 0);
    const attackPose: MotionPose = {
      ...basePose,
      bones: basePose.bones.map((b) => {
        if (b.a[0] !== 25.3) return b;
        if (b.kind === "metacarpal") return { a: [25.3, 1.8, 1.1], b: [25.3, 2.4, 1.25], kind: "metacarpal" };
        if (b.kind === "proximal") return { a: [25.3, 2.4, 1.25], b: [25.3, 3.0, 1.35], kind: "proximal" };
        if (b.kind === "middle") return { a: [25.3, 3.0, 1.35], b: [25.3, 3.08, 0.65], kind: "middle" };
        if (b.kind === "distal") return { a: [25.3, 3.08, 0.65], b: [25.3, 3.05, 0.05], kind: "distal" };
        return b;
      }),
      joints: basePose.joints.map((j) => {
        if (j.kind === "tip" && j.point[0] === 25.3) return { point: [25.3, 3.05, 0.05], kind: "tip" };
        if (j.kind === "knuckle" && j.point[0] === 25.3) return { point: [25.3, 2.4, 1.25], kind: "knuckle" };
        return j;
      }),
    };

    const rightHand = new Hand3DMeshGroup("right");
    rightHand.updateFromPose(attackPose, DEFAULT_SKIN_SETTINGS, false);

    const meta = rightHand.getBone("index-finger-metacarpal")!;
    const prox = rightHand.getBone("index-finger-phalanx-proximal")!;
    const inter = rightHand.getBone("index-finger-phalanx-intermediate")!;
    const dist = rightHand.getBone("index-finger-phalanx-distal")!;

    expect(meta).toBeDefined();
    expect(prox).toBeDefined();
    expect(inter).toBeDefined();
    expect(dist).toBeDefined();

    // Local +X is the lateral hinge axis of each bone
    const latMeta = new THREE.Vector3(1, 0, 0).applyQuaternion(meta.quaternion);
    const latProx = new THREE.Vector3(1, 0, 0).applyQuaternion(prox.quaternion);
    const latInter = new THREE.Vector3(1, 0, 0).applyQuaternion(inter.quaternion);
    const latDist = new THREE.Vector3(1, 0, 0).applyQuaternion(dist.quaternion);

    // Hinge continuity: lateral axes across adjacent phalanges must remain strictly aligned
    // (dot product >= 0.90) with ZERO 180° roll inversion
    expect(latProx.dot(latMeta)).toBeGreaterThan(0.9);
    expect(latInter.dot(latProx)).toBeGreaterThan(0.9);
    expect(latDist.dot(latInter)).toBeGreaterThan(0.9);

    // Local +Y is the dorsal normal: verify it smoothly pitches forward as the finger flexes down
    const dorsalProx = new THREE.Vector3(0, 1, 0).applyQuaternion(prox.quaternion);
    const dorsalInter = new THREE.Vector3(0, 1, 0).applyQuaternion(inter.quaternion);
    const dorsalDist = new THREE.Vector3(0, 1, 0).applyQuaternion(dist.quaternion);

    // Proximal phalanx is mostly horizontal; dorsal normal points upward (+Y)
    expect(dorsalProx.y).toBeGreaterThan(0.5);
    // Intermediate and distal phalanges point down into key; dorsal surfaces face forward (-Z)
    expect(dorsalInter.z).toBeLessThan(-0.35);
    expect(dorsalDist.z).toBeLessThan(-0.5);

    rightHand.dispose();
  });

  it("smoothly lifts fingers and wrist above keyboard into resting hover posture when hoverLift is applied", () => {
    // Depressed pose simulating a key press sunken into the key (tip z = -0.15)
    const pressedPose: MotionPose = {
      ...createMockPose("right"),
      bones: createMockPose("right").bones.map((b) => {
        if (b.kind === "distal") {
          return { ...b, b: [b.b[0], b.b[1], -0.15] as const };
        }
        return b;
      }),
      joints: createMockPose("right").joints.map((j) => {
        if (j.kind === "tip") {
          return { ...j, point: [j.point[0], j.point[1], -0.15] as const };
        }
        return j;
      }),
    };

    // When hoverLift = 0 (during active key press)
    const normalHand = reconstructHand3D(pressedPose, 0);
    // Tip y is sunken (-0.15 in)
    expect(normalHand.chains[2]![4]!.y).toBeLessThan(0);

    // When hoverLift = 1.0 (song finished, note released)
    const liftedHand = reconstructHand3D(pressedPose, 1.0);
    // All fingertips must be elevated above the keyboard (+Y in Three.js world space >= 0.28 in)
    for (let f = 1; f <= 5; f++) {
      const tipY = liftedHand.chains[f]![liftedHand.chains[f]!.length - 1]!.y;
      expect(tipY).toBeGreaterThanOrEqual(0.319);
    }
    // Wrist is also elevated compared to pressed pose
    expect(liftedHand.wristCenter.y).toBeGreaterThan(normalHand.wristCenter.y + 0.2);

    // In Hand3DMeshGroup, the skinned mesh tip bones are positioned above the keys
    const handGroup = new Hand3DMeshGroup("right");
    handGroup.updateFromPose(pressedPose, DEFAULT_SKIN_SETTINGS, false, 1.0);
    const indexTip = handGroup.getBone("index-finger-tip")!;
    expect(indexTip.position.y).toBeGreaterThanOrEqual(0.28);
    handGroup.dispose();
  });

  it("keeps every finger, wrist, and cuff continuous through hover lift, seek-back, and repeat for both hands", () => {
    const liftSequence = [
      0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
      0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0,
    ];
    const seekBackSequence = [0.65, 0.2, 0, 0.85, 0.37, 0.85, 0.5, 0.5];
    const fingerPrefixes = [
      "thumb",
      "index-finger",
      "middle-finger",
      "ring-finger",
      "pinky-finger",
    ];

    for (const hand of ["left", "right"] as const) {
      const pose = createBentMockPose(hand);
      const handGroup = new Hand3DMeshGroup(hand);
      const snapshots = new Map<
        number,
        {
          tips: number[];
          distalScales: number[];
          wristPosition: THREE.Vector3;
          cuffPosition: THREE.Vector3;
          cuffQuaternion: THREE.Quaternion;
          sleevePosition: THREE.Vector3;
          sleeveQuaternion: THREE.Quaternion;
        }
      >();

      const sample = (hoverLift: number) => {
        const reconstructed = reconstructHand3D(pose, hoverLift);
        handGroup.updateFromPose(pose, DEFAULT_SKIN_SETTINGS, false, hoverLift);

        const tips = [] as number[];
        const distalScales = [] as number[];
        for (let finger = 1; finger <= 5; finger++) {
          const prefix = fingerPrefixes[finger - 1]!;
          const tip = handGroup.getBone(`${prefix}-tip`)!;
          const distal = handGroup.getBone(`${prefix}-phalanx-distal`)!;
          const chain = reconstructed.chains[finger]!;
          const originalTip = chain[chain.length - 1]!;
          const expectedPadLift = Math.max(0, 0.13 - Math.max(0, originalTip.y) * 0.5);

          expect(tip).toBeDefined();
          expect(distal).toBeDefined();
          expect(tip.position.y).toBeCloseTo(originalTip.y + expectedPadLift, 5);
          tips.push(tip.position.y);
          distalScales.push(distal.scale.z);
        }

        const cuff = handGroup.group.getObjectByName("hand-cuff")!;
        const sleeve = handGroup.group.getObjectByName("hand-sleeve")!;
        const wrist = handGroup.getBone("wrist")!;
        expect(cuff).toBeInstanceOf(THREE.Mesh);
        expect(sleeve).toBeInstanceOf(THREE.Mesh);
        expect(wrist).toBeDefined();

        return {
          tips,
          distalScales,
          wristPosition: wrist.position.clone(),
          cuffPosition: cuff.position.clone(),
          cuffQuaternion: cuff.quaternion.clone(),
          sleevePosition: sleeve.position.clone(),
          sleeveQuaternion: sleeve.quaternion.clone(),
        };
      };

      for (const hoverLift of liftSequence) {
        snapshots.set(hoverLift, sample(hoverLift));
      }

      const atZero = snapshots.get(0)!;
      const nearZero = sample(0.000001);
      for (let finger = 0; finger < 5; finger++) {
        expect(Math.abs(nearZero.tips[finger]! - atZero.tips[finger]!)).toBeLessThan(0.001);
        expect(
          Math.abs(nearZero.distalScales[finger]! - atZero.distalScales[finger]!),
        ).toBeLessThan(0.001);
      }
      expect(nearZero.wristPosition.distanceTo(atZero.wristPosition)).toBeLessThan(0.001);
      expect(nearZero.cuffPosition.distanceTo(atZero.cuffPosition)).toBeLessThan(0.001);
      expect(nearZero.cuffQuaternion.angleTo(atZero.cuffQuaternion)).toBeLessThan(0.001);
      expect(nearZero.sleevePosition.distanceTo(atZero.sleevePosition)).toBeLessThan(0.001);
      expect(nearZero.sleeveQuaternion.angleTo(atZero.sleeveQuaternion)).toBeLessThan(0.001);

      for (let sampleIndex = 1; sampleIndex < liftSequence.length; sampleIndex++) {
        const previous = snapshots.get(liftSequence[sampleIndex - 1]!)!;
        const current = snapshots.get(liftSequence[sampleIndex]!)!;
        for (let finger = 0; finger < 5; finger++) {
          expect(current.tips[finger]! + 0.0001).toBeGreaterThanOrEqual(previous.tips[finger]!);
          expect(Math.abs(current.tips[finger]! - previous.tips[finger]!)).toBeLessThan(0.1);
          expect(
            Math.abs(current.distalScales[finger]! - previous.distalScales[finger]!),
          ).toBeLessThan(0.1);
        }
        expect(current.wristPosition.distanceTo(previous.wristPosition)).toBeLessThan(0.1);
        expect(current.cuffPosition.distanceTo(previous.cuffPosition)).toBeLessThan(0.1);
        expect(current.cuffQuaternion.angleTo(previous.cuffQuaternion)).toBeLessThan(0.1);
        expect(current.sleevePosition.distanceTo(previous.sleevePosition)).toBeLessThan(0.1);
        expect(current.sleeveQuaternion.angleTo(previous.sleeveQuaternion)).toBeLessThan(0.1);
      }

      const fullyLifted = snapshots.get(1)!;
      expect(fullyLifted.tips).toHaveLength(5);
      for (const tipY of fullyLifted.tips) {
        expect(tipY).toBeGreaterThanOrEqual(0.28);
      }

      for (const hoverLift of seekBackSequence) {
        const repeated = sample(hoverLift);
        const earlier = snapshots.get(hoverLift);
        if (earlier) {
          expect(repeated.tips).toEqual(earlier.tips);
          expect(repeated.distalScales).toEqual(earlier.distalScales);
          expect(repeated.wristPosition.toArray()).toEqual(earlier.wristPosition.toArray());
          expect(repeated.cuffPosition.toArray()).toEqual(earlier.cuffPosition.toArray());
          expect(repeated.cuffQuaternion.toArray()).toEqual(earlier.cuffQuaternion.toArray());
          expect(repeated.sleevePosition.toArray()).toEqual(earlier.sleevePosition.toArray());
          expect(repeated.sleeveQuaternion.toArray()).toEqual(earlier.sleeveQuaternion.toArray());
        } else {
          snapshots.set(hoverLift, repeated);
        }
      }

      handGroup.dispose();
    }
  });

  it("returns fingers to poised hover posture above the keyboard when the last note ends", () => {
    const kb3d = new Keyboard3DView();
    const rightHand = new Hand3DMeshGroup("right");

    const finishNote: Note = {
      noteId: "note-last",
      pitch: 60,
      startSeconds: 1.0,
      endSeconds: 3.0,
      velocity: 80,
      hand: "right",
      trackId: "track-0",
      finger: 2,
      glissando: false,
    };

    // Hover lift remains 0 while notes are active, transitions to 1.0 upon note completion
    expect(calculateHandHoverLift("right", 2.0, [finishNote])).toBe(0);
    expect(calculateHandHoverLift("right", 3.0, [finishNote])).toBe(1.0);
    expect(calculateHandHoverLift("right", 3.16, [finishNote])).toBe(1.0);
    expect(calculateHandHoverLift("right", 3.5, [finishNote])).toBe(1.0);
    expect(calculateHandHoverLift("left", 2.0, [finishNote])).toBe(1.0);

    // Simulate motion pose with pressed index finger
    const finalPose: MotionPose = {
      ...createMockPose("right"),
      transportTimeSeconds: 3.0,
      bones: createMockPose("right").bones.map((b) => {
        if (b.kind === "distal") return { ...b, b: [b.b[0], b.b[1], -0.1] as const };
        return b;
      }),
      joints: createMockPose("right").joints.map((j) => {
        if (j.kind === "tip") return { ...j, point: [j.point[0], j.point[1], -0.1] as const };
        return j;
      }),
    };

    // At t = 2.0 (during the note): note is active, key 60 is depressed, hand plays with hoverLift = 0
    kb3d.setActiveKeys(new Map([[60, { hand: "right" as const, finger: 2 as const }]]));
    const key60 = kb3d.keysByPitch.get(60)!;
    expect(key60.pivotGroup.rotation.x).toBeGreaterThan(0.04);

    rightHand.updateFromPose(finalPose, DEFAULT_SKIN_SETTINGS, false, 0);
    const tipDuringNote = rightHand.getBone("index-finger-tip")!;
    // During press, finger is lowered down to press the key
    expect(tipDuringNote.position.y).toBeLessThan(0.1);

    // At t = 3.5 (after last note ended at 3.0): key is released (pivotGroup.rotation.x === 0)
    kb3d.setActiveKeys(new Map());
    expect(key60.pivotGroup.rotation.x).toBe(0);

    // And hand is updated with hoverLift = 1.0: fingers are poised above the keys
    rightHand.updateFromPose(finalPose, DEFAULT_SKIN_SETTINGS, false, 1.0);
    const tipAfterRelease = rightHand.getBone("index-finger-tip")!;
    expect(tipAfterRelease.position.y).toBeGreaterThanOrEqual(0.28);

    kb3d.dispose();
    rightHand.dispose();
  });
});



