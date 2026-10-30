export type RiggedPoseEditTimepoint = Readonly<{
  id: string;
  kind: "sampled" | "lead-in-held";
  displayedTransportTimeSeconds: number;
  sourcePoseTimeSeconds: number;
}>;

const TIME_EPSILON_SECONDS = 0;

/** Lists only transport times present in a plan or the current motion buffer. */
export function collectRiggedPoseEditTimepoints(
  motionPlanTimes: readonly number[],
  motionBufferTimes: readonly number[],
  leadIn?: { displayedTransportTimeSeconds: number; sourcePoseTimeSeconds: number } | null,
): RiggedPoseEditTimepoint[] {
  const times = [...motionPlanTimes, ...motionBufferTimes]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const distinctTimes: number[] = [];
  for (const time of times) {
    if (distinctTimes.length === 0 || time !== distinctTimes[distinctTimes.length - 1]!) {
      distinctTimes.push(time);
    }
  }

  const sampled = distinctTimes.map((time): RiggedPoseEditTimepoint => ({
    id: `sample:${time.toPrecision(15)}`,
    kind: "sampled",
    displayedTransportTimeSeconds: time,
    sourcePoseTimeSeconds: time,
  }));
  if (!leadIn || !Number.isFinite(leadIn.displayedTransportTimeSeconds) || !Number.isFinite(leadIn.sourcePoseTimeSeconds)) {
    return sampled;
  }

  const leadInPoint: RiggedPoseEditTimepoint = {
    id: `lead-in:${leadIn.displayedTransportTimeSeconds.toPrecision(15)}:${leadIn.sourcePoseTimeSeconds.toPrecision(15)}`,
    kind: "lead-in-held",
    displayedTransportTimeSeconds: leadIn.displayedTransportTimeSeconds,
    sourcePoseTimeSeconds: leadIn.sourcePoseTimeSeconds,
  };
  return [leadInPoint, ...sampled.filter(point =>
    Math.abs(point.displayedTransportTimeSeconds - leadInPoint.displayedTransportTimeSeconds) > TIME_EPSILON_SECONDS,
  )];
}

export function findRiggedPoseEditTimepointIndex(
  timepoints: readonly RiggedPoseEditTimepoint[],
  displayedTransportTimeSeconds: number,
): number {
  return timepoints.findIndex(point =>
    Math.abs(point.displayedTransportTimeSeconds - displayedTransportTimeSeconds) <= TIME_EPSILON_SECONDS,
  );
}
