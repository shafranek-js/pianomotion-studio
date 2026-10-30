/**
 * Reject a Testing IK candidate that introduces excessive penetration for any
 * sampled pad vertex over the target key. Units are scene inches. This does
 * not measure unsampled skin or collision with other keys.
 */
export function permitsTestingContactCandidate(
  beforeMinGap: number | null,
  afterMinGap: number | null,
  toleranceInches = 0.02,
): boolean {
  if (afterMinGap === null || !Number.isFinite(afterMinGap) ||
      !Number.isFinite(toleranceInches) || toleranceInches < 0) return false;
  if (beforeMinGap !== null && !Number.isFinite(beforeMinGap)) return false;
  const floor = beforeMinGap === null ? -toleranceInches : Math.min(-toleranceInches, beforeMinGap);
  return afterMinGap >= floor - 1e-5;
}
