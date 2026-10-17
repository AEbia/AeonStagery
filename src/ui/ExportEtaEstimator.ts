interface ProgressSample {
  readonly timestampMs: number;
  readonly progress: number;
}

const SAMPLE_WINDOW_MS = 12_000;
const MIN_SAMPLE_SPAN_MS = 4_000;
const MIN_SAMPLE_COUNT = 5;
const STALLED_PROGRESS_RESET_MS = 4_000;
const ETA_SMOOTHING = 0.25;

export class ExportEtaEstimator {
  private readonly samples: ProgressSample[] = [];
  private smoothedRemainingSeconds: number | null = null;
  private lastEstimateAtMs: number | null = null;
  private lastProgressChangeAtMs: number | null = null;
  private lastObservedProgress: number | null = null;

  reset(): void {
    this.samples.length = 0;
    this.smoothedRemainingSeconds = null;
    this.lastEstimateAtMs = null;
    this.lastProgressChangeAtMs = null;
    this.lastObservedProgress = null;
  }

  update(progress: number, timestampMs: number): number | null {
    if (!Number.isFinite(progress) || !Number.isFinite(timestampMs)) {
      return this.smoothedRemainingSeconds;
    }

    const normalizedProgress = Math.min(100, Math.max(0, progress));
    if (normalizedProgress >= 100) {
      this.smoothedRemainingSeconds = 0;
      this.lastEstimateAtMs = timestampMs;
      return 0;
    }

    const previousSample = this.samples.at(-1);
    if (previousSample && (
      timestampMs < previousSample.timestampMs
      || this.lastObservedProgress !== null
        && normalizedProgress < this.lastObservedProgress
    )) {
      this.reset();
    }

    if (
      this.lastProgressChangeAtMs !== null
      && timestampMs - this.lastProgressChangeAtMs >= STALLED_PROGRESS_RESET_MS
    ) {
      this.reset();
    }

    if (
      this.lastObservedProgress === null
      || normalizedProgress > this.lastObservedProgress
    ) {
      this.lastProgressChangeAtMs = timestampMs;
    }
    this.lastObservedProgress = normalizedProgress;

    const latestSample = this.samples.at(-1);
    if (!latestSample || timestampMs > latestSample.timestampMs) {
      this.samples.push({ timestampMs, progress: normalizedProgress });
    }

    const windowStartMs = timestampMs - SAMPLE_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[1].timestampMs < windowStartMs) {
      this.samples.shift();
    }

    const firstSample = this.samples[0];
    const lastSample = this.samples.at(-1);
    if (
      this.samples.length < MIN_SAMPLE_COUNT
      || !firstSample
      || !lastSample
      || lastSample.timestampMs - firstSample.timestampMs < MIN_SAMPLE_SPAN_MS
    ) {
      return this.smoothedRemainingSeconds;
    }

    const progressRate = this.calculateProgressRate();
    if (progressRate <= 0 || !Number.isFinite(progressRate)) {
      if (this.smoothedRemainingSeconds !== null && this.lastEstimateAtMs !== null) {
        const stalledSeconds = Math.max(0, timestampMs - this.lastEstimateAtMs) / 1000;
        this.smoothedRemainingSeconds += stalledSeconds;
        this.lastEstimateAtMs = timestampMs;
      }
      return this.smoothedRemainingSeconds;
    }

    const rawEstimate = (100 - normalizedProgress) / progressRate;
    if (!Number.isFinite(rawEstimate)) return this.smoothedRemainingSeconds;

    this.smoothedRemainingSeconds = this.smoothedRemainingSeconds === null
      ? rawEstimate
      : this.smoothedRemainingSeconds
        + ETA_SMOOTHING * (rawEstimate - this.smoothedRemainingSeconds);
    this.lastEstimateAtMs = timestampMs;
    return this.smoothedRemainingSeconds;
  }

  private calculateProgressRate(): number {
    const firstTimestamp = this.samples[0]?.timestampMs;
    if (firstTimestamp === undefined) return 0;

    const times = this.samples.map((sample) => (sample.timestampMs - firstTimestamp) / 1000);
    const meanTime = times.reduce((sum, time) => sum + time, 0) / times.length;
    const meanProgress = this.samples.reduce((sum, sample) => sum + sample.progress, 0) / this.samples.length;

    let covariance = 0;
    let timeVariance = 0;
    this.samples.forEach((sample, index) => {
      const timeDelta = (times[index] ?? 0) - meanTime;
      covariance += timeDelta * (sample.progress - meanProgress);
      timeVariance += timeDelta * timeDelta;
    });

    return timeVariance > 0 ? covariance / timeVariance : 0;
  }
}
