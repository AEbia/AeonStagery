import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { CustomMotionEditTarget } from './CustomMotionEditingTypes';
import type { CustomMotionEditing } from './CustomMotionEditing';
import {
  CustomMotionConversionCommand,
  type CustomMotionConversionPorts,
  type CustomMotionConversionReceipt,
} from './CustomMotionConversionCommand';
import type { CustomMotionDensity } from '../../engine/live2d/customMotionConversion';

/** Confirmed conversion is a short transaction; its lease can transfer directly to an editor session. */
export class CustomMotionConversion {
  private readonly pending = new Map<AbortController, Promise<CustomMotionConversionReceipt>>();
  private disposed = false;

  constructor(private readonly options: Omit<CustomMotionConversionPorts, 'authority'> & {
    store: DocumentStore;
    editing: CustomMotionEditing;
  }) {}

  convert(target: CustomMotionEditTarget, density: CustomMotionDensity, openEditor = true): Promise<CustomMotionConversionReceipt> {
    if (this.disposed || this.pending.size) return Promise.reject(new Error('动作转换正在进行或已关闭'));
    const controller = new AbortController();
    const reservation = this.options.editing.reserveConversion(() => controller.abort());
    const scene = this.options.store.getCurrentSceneDocumentView()?.sceneId;
    const path = this.options.store.filePath;
    const unsubscribe = this.options.store.subscribe(() => {
      if (scene !== this.options.store.getCurrentSceneDocumentView()?.sceneId || path !== this.options.store.filePath) controller.abort();
    });
    const task = this.run(target, density, openEditor, controller.signal, reservation);
    this.pending.set(controller, task);
    void task.finally(() => { unsubscribe(); reservation.complete(); this.pending.delete(controller); }).catch(() => {});
    return task;
  }

  async cancel(): Promise<void> {
    for (const controller of this.pending.keys()) controller.abort();
    await Promise.allSettled(this.pending.values());
  }

  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); }

  private async run(target: CustomMotionEditTarget, density: CustomMotionDensity, openEditor: boolean, signal: AbortSignal,
    reservation: { ready: Promise<void>; complete: () => void }): Promise<CustomMotionConversionReceipt> {
    const action = 'actionId' in target
      ? this.options.store.getCompiledSceneSnapshot()?.actions.find((item) => item.id === target.actionId)
      : undefined;
    const source = 'actionId' in target ? action?.source : target;
    if (!source) throw new Error('自定义动作的源实体已不存在');
    const locator = source.companionId
      ? { kind: 'companion' as const, statementId: source.statementId, companionId: source.companionId }
      : { kind: 'statement' as const, statementId: source.statementId };
    const document = this.options.store.getCurrentSceneDocumentView();
    const path = this.options.store.filePath;
    await reservation.ready;
    if (signal.aborted) throw new Error('动作转换已取消');
    const current = this.options.store.getCurrentSceneDocumentView();
    if (!document || !current || current.sceneId !== document.sceneId || path !== this.options.store.filePath) {
      throw new Error('动作转换的场景已切换');
    }
    const authority = this.options.editing.getAuthority();
    const command = new CustomMotionConversionCommand({
      authoring: this.options.authoring,
      getFps: this.options.getFps,
      ...(this.options.sampleMotion ? { sampleMotion: this.options.sampleMotion } : {}),
      ...(this.options.sampler ? { sampler: this.options.sampler } : {}), authority,
    });
    return command.convert({ locator, density, origin: 'timeline-editor', signal }, openEditor
      ? async (lease) => {
        if (signal.aborted) return false;
        reservation.complete();
        return this.options.editing.adoptLease(locator, authority, lease);
      }
      : undefined);
  }
}
