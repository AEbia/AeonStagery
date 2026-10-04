import type {
  CurrentSceneDocument,
  SemanticSceneBundle,
} from '../../api/types/semantic-scene';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type {
  ProjectionDurationSink,
  SemanticDocumentProjectionRuntimePort,
} from './DocumentProjectionPorts';
import type { SemanticScenePipeline } from '../semantic-scene';

type BatchEntry = {
  prepare: () => Promise<SemanticSceneBundle>;
  path?: string;
  resolve: (bundle: SemanticSceneBundle) => void;
  reject: (error: unknown) => void;
};

export interface SemanticDocumentCommitOptions {
  /**
   * Merge this commit into an open batch (latest-wins, see class contract).
   * Pass `false` when the document MUST be prepared and projected on its own,
   * even if a local burst is in flight — collaborative remote applies use this
   * so a peer's state change can never be absorbed and dropped by coalescing.
   */
  coalesce?: boolean;
}

export class SemanticDocumentCoordinator {
  private applyChain: Promise<void> = Promise.resolve();
  /**
   * Coalescing batch. While a batch is open (leading projection in flight or
   * members draining) new coalescable commits join it instead of being
   * scheduled individually; only the LAST member of a batch is actually
   * prepared and projected. Every caller's promise settles with the batch
   * outcome, so a burst of rapid edits under document projection pays at most
   * two full pipeline runs (leading + final drain) instead of one per commit.
   *
   * EXTERNAL CONTRACT (latest-wins): within an open batch, every coalescable
   * caller's promise resolves with the outcome of the LAST member of the
   * batch, and the intermediate documents of the burst are neither projected
   * into the runtime nor stored. Callers that require strict 1:1 projection
   * (each commit must be reflected independently) must either await each
   * applyDocument before issuing the next — sequential callers always take
   * the leading-commit path and are unaffected — or pass `{ coalesce: false }`
   * to opt that commit out of batch absorption.
   */
  private batch: { leading: BatchEntry; members: BatchEntry[] } | null = null;
  /**
   * FIFO of non-coalescable commits (e.g. collaborative remote applies) that
   * arrived while a batch was open. Each one is re-opened as the LEADING entry
   * of its own batch once the current batch closes, so its document is always
   * prepared and projected — it can never be absorbed by a batch's latest-wins
   * drain. FIFO order preserves the arrival order of remote state changes.
   */
  private exclusiveQueue: BatchEntry[] = [];

  constructor(
    private readonly documentStore: DocumentStore,
    private readonly pipeline: SemanticScenePipeline,
    private readonly runtime: SemanticDocumentProjectionRuntimePort,
    private readonly durationSink?: ProjectionDurationSink,
    private readonly beforeProject?: (bundle: SemanticSceneBundle) => Promise<void> | void,
  ) {}

  applyRawJson(rawJson: string, path?: string): Promise<SemanticSceneBundle> {
    return this.enqueue(() => this.pipeline.processRawJson(rawJson), path);
  }

  applyDocument(
    document: CurrentSceneDocument,
    path?: string,
    options: SemanticDocumentCommitOptions = {},
  ): Promise<SemanticSceneBundle> {
    return this.enqueue(() => this.pipeline.processDocument(document), path, options);
  }

  private enqueue(
    prepare: () => Promise<SemanticSceneBundle>,
    path?: string,
    options: SemanticDocumentCommitOptions = {},
  ): Promise<SemanticSceneBundle> {
    return new Promise((resolve, reject) => {
      const entry: BatchEntry = { prepare, path, resolve, reject };
      const coalesce = options.coalesce !== false;
      if (this.batch !== null) {
        // A batch is already open.
        if (coalesce) {
          // Coalesce into its final drain (latest-wins).
          this.batch.members.push(entry);
        } else {
          // Wait for the batch to close, then run as its own leading batch.
          this.exclusiveQueue.push(entry);
        }
        return;
      }
      // No batch in flight: this entry opens one, whether coalescable or not —
      // an isolated commit is always projected immediately (no added latency).
      this.openBatch(entry);
    });
  }

  private openBatch(leading: BatchEntry): void {
    if (this.batch !== null) {
      throw new Error('SemanticDocumentCoordinator: cannot open a batch while one is active');
    }
    this.batch = { leading, members: [] };
    this.applyChain = this.applyChain
      .catch(() => undefined)
      .then(async () => {
        try {
          const bundle = await this.runEntry(leading);
          leading.resolve(bundle);
        } catch (error) {
          leading.reject(error);
        }
        await this.drainMembersAndClose();

        // A non-coalescable commit queued behind this batch gets its own
        // leading batch now (FIFO). It can never be absorbed by this batch's
        // latest-wins drain.
        const nextExclusive = this.exclusiveQueue.shift();
        if (nextExclusive) {
          this.openBatch(nextExclusive);
        }
      });
  }

  private async drainMembersAndClose(): Promise<void> {
    while (this.batch && this.batch.members.length > 0) {
      const members = this.batch.members;
      // Swap the live members before running so commits that arrive while the
      // drain runs join the next iteration instead of a settled batch.
      this.batch.members = [];
      const latest = members[members.length - 1];
      try {
        const bundle = await this.runEntry(latest);
        for (const entry of members) entry.resolve(bundle);
      } catch (error) {
        for (const entry of members) entry.reject(error);
      }
    }
    // Close the batch synchronously at the end of this call (not after an
    // await boundary): a commit that lands in the microtask gap after the
    // leading entry resolved must open a FRESH batch instead of joining one
    // whose drain loop already checked an empty member list. Otherwise it
    // would be orphaned and its promise would never settle.
    if (this.batch && this.batch.members.length === 0) {
      this.batch = null;
    }
  }

  private async runEntry(entry: BatchEntry): Promise<SemanticSceneBundle> {
    const previousPrepared = this.documentStore.getPreparedSceneSnapshot();
    const bundle = await entry.prepare();
    try {
      await this.beforeProject?.(bundle);
      await this.runtime.projectPreparedScene(bundle.prepared);
      this.documentStore._replaceSemanticScene(bundle, entry.path);
      this.durationSink?.setDuration(bundle.prepared.durationSeconds);
      return bundle;
    } catch (error) {
      if (previousPrepared) {
        await this.runtime.projectPreparedScene(previousPrepared).catch(() => undefined);
      }
      throw error;
    }
  }
}