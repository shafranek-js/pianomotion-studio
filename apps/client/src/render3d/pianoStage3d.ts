import * as THREE from "three";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import {
  DEFAULT_STAGE_APPEARANCE,
  normalizeStageAppearance,
  type StageAppearance,
} from "../settings/stageAppearance";
import { PianoStageAtmosphere } from "./pianoStageAtmosphere";

export const PIANO_STAGE_RADIUS = 80;
export const PIANO_STAGE_FLOOR_Y = -20;

const REFLECTION_RESOLUTIONS = {
  low: 256,
  auto: 512,
  high: 1024,
} as const;

export interface PianoStageDiagnostics {
  readonly appearance: Readonly<StageAppearance>;
  readonly radius: number;
  readonly floorY: number;
  readonly reflectionResolution: number;
  readonly reflectionTargetWidth: number;
  readonly reflectionTargetHeight: number;
  readonly reflectionPassEnabled: boolean;
  readonly atmosphereEnabled: boolean;
  readonly atmosphereMeshCount: number;
  readonly atmosphereShaftShellCount: number;
  readonly disposed: boolean;
}

function makeReflectionShader(resolution: number): object {
  return {
    name: "PianoStageSoftReflector",
    uniforms: {
      color: { value: new THREE.Color(0xd8e5ff) },
      tDiffuse: { value: null },
      textureMatrix: { value: new THREE.Matrix4() },
      stageOpacity: { value: DEFAULT_STAGE_APPEARANCE.reflection },
      floorRadius: { value: PIANO_STAGE_RADIUS },
      texelSize: { value: new THREE.Vector2(1 / resolution, 1 / resolution) },
    },
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      varying vec2 vStagePosition;

      #include <common>
      #include <logdepthbuf_pars_vertex>

      void main() {
        vUv = textureMatrix * vec4(position, 1.0);
        vStagePosition = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform sampler2D tDiffuse;
      uniform float stageOpacity;
      uniform float floorRadius;
      uniform vec2 texelSize;
      varying vec4 vUv;
      varying vec2 vStagePosition;

      #include <logdepthbuf_pars_fragment>

      vec3 sampleReflection(vec2 offset) {
        return texture2DProj(tDiffuse, vUv + vec4(offset * vUv.w, 0.0, 0.0)).rgb;
      }

      void main() {
        #include <logdepthbuf_fragment>

        vec2 blurStep = texelSize * 2.4;
        vec3 reflectedColor = sampleReflection(vec2(0.0)) * 0.36;
        reflectedColor += sampleReflection(vec2(blurStep.x, 0.0)) * 0.16;
        reflectedColor += sampleReflection(vec2(-blurStep.x, 0.0)) * 0.16;
        reflectedColor += sampleReflection(vec2(0.0, blurStep.y)) * 0.16;
        reflectedColor += sampleReflection(vec2(0.0, -blurStep.y)) * 0.16;

        float stageDistance = length(vStagePosition);
        float radialFade = 1.0 - smoothstep(floorRadius * 0.70, floorRadius, stageDistance);
        float distanceFade = 1.0 - smoothstep(floorRadius * 0.40, floorRadius * 1.15, stageDistance);
        float alpha = stageOpacity * radialFade * distanceFade;
        gl_FragColor = vec4(reflectedColor * color, alpha);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  };
}

function createWoodGrainTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const plankPalette = ["#686d73", "#70747a", "#666b71", "#73767b", "#6b7076", "#70747a"];
    const plankWidth = canvas.width / plankPalette.length;
    for (let plank = 0; plank < plankPalette.length; plank += 1) {
      const left = plank * plankWidth;
      context.fillStyle = plankPalette[plank]!;
      context.fillRect(left, 0, plankWidth, canvas.height);

      // Low contrast grain and seams keep the lacquered graphite floor from reading as flat plastic.
      for (let line = 0; line < 18; line += 1) {
        const x = left + ((line * 29 + plank * 11) % Math.floor(plankWidth));
        context.fillStyle = line % 2 === 0
          ? "rgba(255,255,255,0.035)"
          : "rgba(0,0,0,0.035)";
        context.fillRect(x, 0, line % 3 === 0 ? 2 : 1, canvas.height);
      }

      const jointY = (plank * 173 + 241) % 512;
      context.fillStyle = "rgba(5,8,12,0.16)";
      context.fillRect(left + 1, jointY, plankWidth - 2, 2);
      context.fillRect(left + 1, jointY + 512, plankWidth - 2, 2);
    }

    for (let plank = 1; plank < plankPalette.length; plank += 1) {
      const x = plank * plankWidth;
      context.fillStyle = "rgba(0,0,0,0.16)";
      context.fillRect(x - 1, 0, 2, canvas.height);
      context.fillStyle = "rgba(220,230,245,0.035)";
      context.fillRect(x + 1, 0, 1, canvas.height);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(6, 6);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  } catch {
    return null;
  }
}

type RendererWithReflectorState = THREE.WebGLRenderer & {
  state?: { buffers?: { depth?: { setMask?: (enabled: boolean) => void } } };
};

/** Owns the floor, its real reflection pass, and the lighting that shapes the stage. */
export class PianoStage3D {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private viewportWidth: number;
  private floorGeometry: THREE.CircleGeometry | null = null;
  private floorMaterial: THREE.MeshPhysicalMaterial | null = null;
  private floorMesh: THREE.Mesh | null = null;
  private floorTexture: THREE.CanvasTexture | null = null;
  private reflectionGeometry: THREE.CircleGeometry | null = null;
  private reflector: Reflector | null = null;
  private atmosphere: PianoStageAtmosphere | null = null;
  private hemisphereLight: THREE.HemisphereLight | null = null;
  private keyLight: THREE.DirectionalLight | null = null;
  private fillLight: THREE.DirectionalLight | null = null;
  private rimLight: THREE.DirectionalLight | null = null;
  private floorPoolLight: THREE.PointLight | null = null;
  private appearance: StageAppearance = { ...DEFAULT_STAGE_APPEARANCE };
  private isDisposed = false;

  public constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, viewportWidth = 1024) {
    this.scene = scene;
    this.renderer = renderer;
    this.viewportWidth = Math.max(1, viewportWidth);

    try {
      this.createFloor();
      this.createLighting();
      this.setAppearance(DEFAULT_STAGE_APPEARANCE);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private createFloor(): void {
    this.floorTexture = createWoodGrainTexture();
    this.floorGeometry = new THREE.CircleGeometry(PIANO_STAGE_RADIUS, 144);
    this.floorMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x9eafca,
      ...(this.floorTexture ? { map: this.floorTexture } : {}),
      emissive: 0x080d18,
      emissiveIntensity: 0.16,
      roughness: 0.32,
      metalness: 0.08,
      clearcoat: 0.42,
      clearcoatRoughness: 0.25,
      reflectivity: 0.58,
      envMapIntensity: 0.32,
      transparent: true,
      depthWrite: true,
    });
    this.floorMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vStageFloorPosition;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvStageFloorPosition = position.xy;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vStageFloorPosition;\nuniform float uStageFloorRadius;",
        )
        .replace(
          "#include <opaque_fragment>",
          "diffuseColor.a *= 1.0 - smoothstep(uStageFloorRadius * 0.70, uStageFloorRadius, length(vStageFloorPosition));\n#include <opaque_fragment>",
        );
      shader.uniforms.uStageFloorRadius = { value: PIANO_STAGE_RADIUS };
    };

    this.floorMesh = new THREE.Mesh(this.floorGeometry, this.floorMaterial);
    this.floorMesh.name = "piano-concert-stage-floor";
    this.floorMesh.rotation.x = -Math.PI * 0.5;
    this.floorMesh.position.set(0, PIANO_STAGE_FLOOR_Y, -16);
    this.floorMesh.receiveShadow = true;
    this.floorMesh.castShadow = false;
    this.scene.add(this.floorMesh);

    this.atmosphere = new PianoStageAtmosphere(this.scene, PIANO_STAGE_FLOOR_Y, PIANO_STAGE_RADIUS);
    this.reflectionGeometry = new THREE.CircleGeometry(PIANO_STAGE_RADIUS, 144);
    const resolution = this.getTargetResolution();
    this.reflector = new Reflector(this.reflectionGeometry, {
      color: 0xd8e5ff,
      textureWidth: resolution,
      textureHeight: resolution,
      clipBias: 0.001,
      multisample: 0,
      shader: makeReflectionShader(resolution),
    });
    this.reflector.name = "piano-concert-stage-reflection";
    this.reflector.rotation.x = -Math.PI * 0.5;
    this.reflector.position.set(0, PIANO_STAGE_FLOOR_Y + 0.002, -16);
    this.reflector.renderOrder = 1;
    this.reflector.castShadow = false;
    this.reflector.receiveShadow = false;
    const reflectionMaterial = this.reflector.material as THREE.ShaderMaterial;
    reflectionMaterial.transparent = true;
    reflectionMaterial.depthWrite = false;
    reflectionMaterial.depthTest = true;
    this.installReflectionStateGuard(this.reflector);
    this.scene.add(this.reflector);
  }

  private installReflectionStateGuard(reflector: Reflector): void {
    const originalRenderHook = reflector.onBeforeRender;
    reflector.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      const stageFloor = this.floorMesh;
      const floorWasVisible = stageFloor?.visible ?? false;
      const reflectorWasVisible = reflector.visible;
      const reflectionExcludedGroups = this.atmosphere?.reflectionExcludedGroups ?? [];
      const excludedGroupsVisibility = reflectionExcludedGroups.map((atmosphereGroup) => atmosphereGroup.visible);
      const guardedRenderer = renderer as RendererWithReflectorState;
      const canRestoreTarget = typeof renderer.getRenderTarget === "function" &&
        typeof renderer.setRenderTarget === "function";
      const previousTarget = canRestoreTarget ? renderer.getRenderTarget() : null;
      const previousShadowAutoUpdate = renderer.shadowMap?.autoUpdate;
      const previousXrEnabled = renderer.xr?.enabled;

      // The reflection pass renders the piano and performance objects, but not either floor surface.
      if (stageFloor) stageFloor.visible = false;
      for (const atmosphereGroup of reflectionExcludedGroups) atmosphereGroup.visible = false;
      try {
        originalRenderHook.call(reflector, renderer, scene, camera, geometry, material, group);
      } finally {
        if (stageFloor) stageFloor.visible = floorWasVisible;
        reflectionExcludedGroups.forEach((atmosphereGroup, index) => {
          atmosphereGroup.visible = excludedGroupsVisibility[index] ?? true;
        });
        reflector.visible = reflectorWasVisible;
        if (canRestoreTarget) {
          renderer.setRenderTarget(previousTarget);
        }
        if (previousShadowAutoUpdate !== undefined && renderer.shadowMap) {
          renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
        }
        if (previousXrEnabled !== undefined && renderer.xr) renderer.xr.enabled = previousXrEnabled;
        // Reflector enables depth writes before its offscreen render. Restore the normal main-pass state.
        guardedRenderer.state?.buffers?.depth?.setMask?.(true);
      }
    };
  }

  private createLighting(): void {
    this.hemisphereLight = new THREE.HemisphereLight(0xe5efff, 0x10141b, 0.22);
    this.hemisphereLight.position.set(0, 40, 0);
    this.scene.add(this.hemisphereLight);

    this.keyLight = new THREE.DirectionalLight(0xffedda, 1.62);
    this.keyLight.position.set(7, 25, 8);
    this.keyLight.target.position.set(0, 0, -2.5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 2;
    this.keyLight.shadow.camera.far = 72;
    this.keyLight.shadow.camera.left = -30;
    this.keyLight.shadow.camera.right = 30;
    this.keyLight.shadow.camera.top = 18;
    this.keyLight.shadow.camera.bottom = -28;
    this.keyLight.shadow.bias = -0.0002;
    this.keyLight.shadow.normalBias = 0.012;
    this.keyLight.shadow.radius = 2;
    this.scene.add(this.keyLight, this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight(0xe6efff, 0.17);
    this.fillLight.position.set(-18, 12, 14);
    this.fillLight.castShadow = false;
    this.scene.add(this.fillLight);

    this.rimLight = new THREE.DirectionalLight(0x72aaff, 0.44);
    this.rimLight.position.set(-10, 16, -24);
    this.rimLight.castShadow = false;
    this.scene.add(this.rimLight);

    this.floorPoolLight = new THREE.PointLight(0x4c86ec, 76, 78, 2);
    this.floorPoolLight.position.set(0, -8, -42);
    this.floorPoolLight.castShadow = false;
    if (this.atmosphere) this.atmosphere.group.add(this.floorPoolLight);
    else this.scene.add(this.floorPoolLight);
  }

  public setAppearance(input: StageAppearance): void {
    if (this.isDisposed) return;
    const next = normalizeStageAppearance(input);
    this.appearance = next;
    const concert = next.preset === "concert";
    const brightness = next.brightness;

    const background = concert ? 0x090b13 : 0x111214;
    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.FogExp2(background, concert ? 0.0068 : 0.0054);

    this.hemisphereLight?.color.setHex(concert ? 0xe5efff : 0xf2f0ec);
    this.hemisphereLight?.groundColor.setHex(concert ? 0x10141b : 0x181715);
    if (this.hemisphereLight) this.hemisphereLight.intensity = (concert ? 0.22 : 0.30) * brightness;

    this.keyLight?.color.setHex(concert ? 0xffedda : 0xfff8ef);
    if (this.keyLight) this.keyLight.intensity = (concert ? 1.62 : 1.48) * brightness;

    this.fillLight?.color.setHex(concert ? 0xe6efff : 0xf0eee8);
    if (this.fillLight) this.fillLight.intensity = (concert ? 0.17 : 0.22) * brightness;

    this.rimLight?.color.setHex(concert ? 0x72aaff : 0xd4d9e1);
    if (this.rimLight) this.rimLight.intensity = (concert ? 0.44 : 0.12) * brightness;

    this.floorPoolLight?.color.setHex(concert ? 0x4c86ec : 0xc9c8c1);
    if (this.floorPoolLight) this.floorPoolLight.intensity = (concert ? 76 : 0) * brightness;

    if (this.floorMaterial) {
      this.floorMaterial.color.setHex(concert ? 0x9eafca : 0xb4b0a8);
      this.floorMaterial.emissive.setHex(concert ? 0x080d18 : 0x080807);
      this.floorMaterial.emissiveIntensity = (concert ? 0.16 : 0.11) * brightness;
    }
    this.atmosphere?.setAppearance(next.preset, brightness);
    this.atmosphere?.setQuality(next.quality, this.viewportWidth);

    const reflectionMaterial = this.reflector?.material as THREE.ShaderMaterial | undefined;
    if (reflectionMaterial?.uniforms.stageOpacity) {
      reflectionMaterial.uniforms.stageOpacity.value = next.reflection;
    }
    if (this.reflector) this.reflector.visible = next.reflection > 0;
    this.resizeReflectionTarget();
    if (this.reflector) {
      const target = this.reflector.getRenderTarget();
      const resolution = target.width;
      const reflectionMaterial = this.reflector.material as THREE.ShaderMaterial;
      if (reflectionMaterial.uniforms.color) {
        reflectionMaterial.uniforms.color.value.setHex(concert ? 0xd8e5ff : 0xf2f0eb);
      }
      if (reflectionMaterial.uniforms.texelSize) {
        reflectionMaterial.uniforms.texelSize.value.set(1 / resolution, 1 / resolution);
      }
    }
  }

  public setViewportWidth(width: number): void {
    if (this.isDisposed || !Number.isFinite(width) || width <= 0) return;
    const nextWidth = Math.max(1, width);
    if (nextWidth === this.viewportWidth) return;
    this.viewportWidth = nextWidth;
    if (this.appearance.quality === "auto") this.resizeReflectionTarget();
    this.atmosphere?.setQuality(this.appearance.quality, this.viewportWidth);
  }

  private getTargetResolution(): number {
    if (this.appearance.quality === "auto") {
      return this.viewportWidth <= 900 ? REFLECTION_RESOLUTIONS.low : REFLECTION_RESOLUTIONS.auto;
    }
    return REFLECTION_RESOLUTIONS[this.appearance.quality];
  }

  private resizeReflectionTarget(): void {
    if (this.reflector) {
      const target = this.reflector.getRenderTarget();
      const resolution = this.getTargetResolution();
      if (target.width !== resolution || target.height !== resolution) {
        target.setSize(resolution, resolution);
      }
      const reflectionMaterial = this.reflector.material as THREE.ShaderMaterial;
      if (reflectionMaterial.uniforms.texelSize) {
        reflectionMaterial.uniforms.texelSize.value.set(1 / resolution, 1 / resolution);
      }
    }
  }

  public getDiagnostics(): PianoStageDiagnostics {
    const target = this.reflector?.getRenderTarget();
    return {
      appearance: Object.freeze({ ...this.appearance }),
      radius: PIANO_STAGE_RADIUS,
      floorY: PIANO_STAGE_FLOOR_Y,
      reflectionResolution: target?.width ?? this.getTargetResolution(),
      reflectionTargetWidth: target?.width ?? this.getTargetResolution(),
      reflectionTargetHeight: target?.height ?? this.getTargetResolution(),
      reflectionPassEnabled: Boolean(this.reflector?.visible && this.appearance.reflection > 0),
      atmosphereEnabled: Boolean(this.atmosphere?.group.visible),
      atmosphereMeshCount: this.atmosphere?.meshCount ?? 0,
      atmosphereShaftShellCount: this.atmosphere?.visibleShaftShellCount ?? 0,
      disposed: this.isDisposed,
    };
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.floorMesh) this.scene.remove(this.floorMesh);
    if (this.reflector) this.scene.remove(this.reflector);
    for (const light of [this.hemisphereLight, this.keyLight, this.fillLight, this.rimLight, this.floorPoolLight]) {
      if (!light) continue;
      this.scene.remove(light);
      if (light === this.keyLight) this.scene.remove(this.keyLight.target);
    }

    this.keyLight?.shadow.dispose();
    this.atmosphere?.dispose();
    this.reflector?.dispose();
    this.reflectionGeometry?.dispose();
    this.floorGeometry?.dispose();
    this.floorMaterial?.dispose();
    this.floorTexture?.dispose();
  }
}
