import * as THREE from "three";
import type { StageAppearance } from "../settings/stageAppearance";

export const STAGE_LIGHT_SHAFT = Object.freeze({
  x: 0,
  y: 17,
  z: -52,
  height: 72,
  bottomRadius: 12,
  topRadius: 15,
  outerTopRadius: 22,
});

const SHAFT_SHELLS = [
  { name: "piano-stage-light-shaft-core", bottomRadius: 12, topRadius: 15, opacity: 0.12 },
  { name: "piano-stage-light-shaft-soft", bottomRadius: 14, topRadius: 18, opacity: 0.07 },
  { name: "piano-stage-light-shaft-haze", bottomRadius: 17, topRadius: 22, opacity: 0.035 },
] as const;

function getVisibleShellCount(quality: StageAppearance["quality"], viewportWidth: number): number {
  if (quality === "low") return 2;
  if (quality === "high") return SHAFT_SHELLS.length;
  return viewportWidth <= 900 ? 2 : SHAFT_SHELLS.length;
}

const SHAFT_VERTEX_SHADER = /* glsl */ `
  varying float vHeightProgress;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vHeightProgress = clamp((position.y + 36.0) / 72.0, 0.0, 1.0);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    #include <logdepthbuf_vertex>
  }
`;

const SHAFT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uBlue;
  uniform float uOpacity;
  varying float vHeightProgress;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float facing = clamp(dot(normalize(vWorldNormal), viewDirection), 0.0, 1.0);
    float softEdge = pow(facing, 4.0);
    float baseFade = smoothstep(0.0, 0.26, vHeightProgress);
    float topFade = 1.0 - smoothstep(0.73, 1.0, vHeightProgress);
    float scatter = 0.97 + 0.03 * sin(vWorldPosition.y * 0.18 + sin(vWorldPosition.z * 0.04) * 1.5);
    float alpha = uOpacity * softEdge * baseFade * topFade * scatter;
    gl_FragColor = vec4(uBlue, alpha);
    #include <colorspace_fragment>
  }
`;

const PERIMETER_VERTEX_SHADER = /* glsl */ `
  varying vec2 vStagePosition;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vStagePosition = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const PERIMETER_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uBlue;
  uniform float uRadius;
  uniform float uOpacity;
  varying vec2 vStagePosition;

  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    float radiusProgress = length(vStagePosition) / uRadius;
    float broadBand = smoothstep(0.36, 0.70, radiusProgress) *
      (1.0 - smoothstep(0.88, 0.99, radiusProgress));
    float floorFade = 1.0 - smoothstep(0.70, 1.0, radiusProgress);
    float alpha = uOpacity * broadBand * floorFade;
    gl_FragColor = vec4(uBlue, alpha);
    #include <colorspace_fragment>
  }
`;

function makeAdditiveMaterial(
  uniforms: THREE.ShaderMaterialParameters["uniforms"],
  vertexShader: string,
  fragmentShader: string,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

/** Lightweight, depth-tested stage haze made from tapered shells and a radial floor glow. */
export class PianoStageAtmosphere {
  public readonly group = new THREE.Group();
  private readonly shaftGroup = new THREE.Group();
  private readonly perimeterGroup = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private disposed = false;

  public constructor(scene: THREE.Scene, floorY: number, radius: number) {
    try {
      this.group.name = "piano-stage-atmosphere";
      this.shaftGroup.name = "piano-stage-light-shaft";
      this.shaftGroup.position.set(STAGE_LIGHT_SHAFT.x, STAGE_LIGHT_SHAFT.y, STAGE_LIGHT_SHAFT.z);
      this.perimeterGroup.name = "piano-stage-perimeter-glow";

      for (const shell of SHAFT_SHELLS) {
        const geometry = new THREE.CylinderGeometry(
          shell.topRadius,
          shell.bottomRadius,
          STAGE_LIGHT_SHAFT.height,
          64,
          1,
          true,
        );
        geometry.name = `${shell.name}-geometry`;
        this.geometries.push(geometry);
        const material = makeAdditiveMaterial(
          {
            uBlue: { value: new THREE.Color(0x63b8ff) },
            uOpacity: { value: shell.opacity },
          },
          SHAFT_VERTEX_SHADER,
          SHAFT_FRAGMENT_SHADER,
        );
        this.materials.push(material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = shell.name;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.raycast = () => {};
        this.shaftGroup.add(mesh);
      }

      const perimeterGeometry = new THREE.CircleGeometry(radius, 144);
      perimeterGeometry.name = "piano-stage-perimeter-glow-geometry";
      this.geometries.push(perimeterGeometry);
      const perimeterMaterial = makeAdditiveMaterial(
        {
          uBlue: { value: new THREE.Color(0x347eff) },
          uRadius: { value: radius },
          uOpacity: { value: 0.22 },
        },
        PERIMETER_VERTEX_SHADER,
        PERIMETER_FRAGMENT_SHADER,
      );
      this.materials.push(perimeterMaterial);
      const perimeterMesh = new THREE.Mesh(perimeterGeometry, perimeterMaterial);
      perimeterMesh.name = "piano-stage-perimeter-glow-mesh";
      perimeterMesh.rotation.x = -Math.PI * 0.5;
      perimeterMesh.position.set(0, floorY + 0.004, -16);
      perimeterMesh.renderOrder = 2;
      perimeterMesh.castShadow = false;
      perimeterMesh.receiveShadow = false;
      perimeterMesh.raycast = () => {};
      this.perimeterGroup.add(perimeterMesh);
      this.group.add(this.shaftGroup, this.perimeterGroup);
      scene.add(this.group);
      this.setAppearance("concert", 1);
      this.setQuality("auto", 1024);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  public setAppearance(preset: StageAppearance["preset"], brightness: number): void {
    if (this.disposed) return;
    const concert = preset === "concert";
    const intensity = Math.min(1.5, Math.max(0.5, Number.isFinite(brightness) ? brightness : 1));
    this.group.visible = concert;
    this.shaftGroup.visible = concert;
    this.perimeterGroup.visible = concert;
    for (let index = 0; index < SHAFT_SHELLS.length; index += 1) {
      const material = this.materials[index]!;
      material.uniforms.uOpacity!.value = SHAFT_SHELLS[index]!.opacity * intensity;
    }
    const perimeterMaterial = this.materials[this.materials.length - 1]!;
    perimeterMaterial.uniforms.uOpacity!.value = (concert ? 0.22 : 0) * intensity;
  }

  public setQuality(quality: StageAppearance["quality"], viewportWidth: number): void {
    if (this.disposed) return;
    const visibleShellCount = getVisibleShellCount(quality, viewportWidth);
    this.shaftGroup.children.forEach((child, index) => {
      child.visible = index < visibleShellCount;
    });
  }

  public get meshCount(): number {
    return 4;
  }

  public get reflectionExcludedGroups(): readonly THREE.Group[] {
    return [this.shaftGroup, this.perimeterGroup];
  }

  public get visibleShaftShellCount(): number {
    return this.shaftGroup.children.filter((child) => child.visible).length;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.parent?.remove(this.group);
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
