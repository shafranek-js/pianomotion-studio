import * as THREE from "three";

export type TestingThumbReachInvalidReason = "degenerate-segment" | "non-finite";

export interface TestingThumbReachMeasure {
  /** Original MCP-to-IP segment length in the supplied frame. */
  mcpToIpLength: number | null;
  /** Original IP-to-controlled-bone-tip segment length in the supplied frame. */
  ipToTipLength: number | null;
  /** Sum of the two original segment lengths. */
  totalReach: number | null;
  /** MCP-to-target distance; target is the desired controlled bone-tip point. */
  distance: number | null;
  /** Signed excess distance: distance - totalReach (positive means unreachable). */
  signedReachDeficit: number | null;
  /** Positive-only unreachable distance: max(0, signedReachDeficit). */
  reachDeficit: number | null;
  /** Null for a usable measurement; otherwise identifies the invalid chain/data. */
  invalid: TestingThumbReachInvalidReason | null;
}

const MIN_SEGMENT_LENGTH = 1e-8;

const invalidNonFinite: TestingThumbReachMeasure = {
  mcpToIpLength: null,
  ipToTipLength: null,
  totalReach: null,
  distance: null,
  signedReachDeficit: null,
  reachDeficit: null,
  invalid: "non-finite",
};

/**
 * Measures whether a target can be reached by the Testing thumb's MCP-to-IP-to-tip
 * chain. All points must already be expressed in the same frame. `controlledTip`
 * is the IK/bone endpoint, not a skinned contact-pad vertex; skin deformation and
 * pad offsets do not contribute to the chain lengths or target distance.
 *
 * This is a read-only geometric measure; it does not apply a pose or mutate any
 * of the supplied vectors. A positive signed deficit means the target is beyond
 * the straightened chain's maximum reach.
 */
export function measureTestingThumbControlledTipReach(
  mcp: THREE.Vector3,
  ip: THREE.Vector3,
  controlledTip: THREE.Vector3,
  targetControlledTip: THREE.Vector3,
): TestingThumbReachMeasure {
  if (![mcp, ip, controlledTip, targetControlledTip].every((point) =>
    point.toArray().every(Number.isFinite))) {
    return { ...invalidNonFinite };
  }

  const mcpToIpLength = mcp.distanceTo(ip);
  const ipToTipLength = ip.distanceTo(controlledTip);
  const totalReach = mcpToIpLength + ipToTipLength;
  const distance = mcp.distanceTo(targetControlledTip);
  const signedReachDeficit = distance - totalReach;
  const reachDeficit = Math.max(0, signedReachDeficit);
  const measurements = [mcpToIpLength, ipToTipLength, totalReach, distance, signedReachDeficit, reachDeficit];

  if (!measurements.every(Number.isFinite)) return { ...invalidNonFinite };

  return {
    mcpToIpLength,
    ipToTipLength,
    totalReach,
    distance,
    signedReachDeficit,
    reachDeficit,
    invalid: mcpToIpLength <= MIN_SEGMENT_LENGTH || ipToTipLength <= MIN_SEGMENT_LENGTH
      ? "degenerate-segment"
      : null,
  };
}
