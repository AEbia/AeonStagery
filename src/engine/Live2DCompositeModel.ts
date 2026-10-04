import * as PIXI from 'pixi.js';
import { CUBISM2_DEFAULT_PARAMS } from './Live2DConfig';

export class Live2DCompositeModel extends PIXI.Container {
  public mainModel: any;
  public subModels: any[] = [];
  public internalModel: any;
  public idleSnapshot: any;
  public _modelUrl?: string; // Used for recycling and identification

  private _anchor = new PIXI.ObservablePoint({
    _onUpdate: () => this.onAnchorChanged(),
  }, 0, 0);

  public get anchor(): PIXI.ObservablePoint {
    return this._anchor;
  }

  public set anchor(value: PIXI.ObservablePoint) {
    this._anchor.copyFrom(value);
  }

  private onAnchorChanged(): void {
    const bounds = this.getLocalBounds();
    this.pivot.x = bounds.x + this._anchor.x * bounds.width;
    this.pivot.y = bounds.y + this._anchor.y * bounds.height;
  }

  constructor(mainModel: any, subModels: any[]) {
    super();
    this.mainModel = mainModel;
    this.subModels = subModels;

    // Set name for debugging
    this.name = `composed-model-${mainModel.name || 'unnamed'}`;

    // Reset visibility and alpha to avoid being trapped in preloaded state (alpha=0, visible=false)
    if (this.mainModel) {
      this.mainModel.visible = true;
      this.mainModel.alpha = 1;
    }

    // Crucial DI: Expose main model's internalModel to delegate motions, expressions,
    // physics, and focus controller seamlessly to the underlying torso model
    this.internalModel = mainModel.internalModel;

    // Add torso as the base child
    this.addChild(mainModel);

    // Add sub-models (face, arms) as children
    for (const sub of subModels) {
      sub.visible = true;
      sub.alpha = 1;
      this.addChild(sub);
    }

    // Hook loadParam on sub-models to automatically synchronize parameters from main torso model
    // right after the sub-model resets its parameters to defaults at the start of its update sequence.
    // This ensures sub-model physics (e.g., hair sways, clothing sways) calculates using fresh torso inputs.
    for (const sub of subModels) {
      if (sub.internalModel) {
        // Neutralize sub-model independent eye blinking so eyes are driven 100% by synchronized torso parameters
        if (sub.internalModel.eyeBlink) {
          sub.internalModel.eyeBlink.update = () => {};
        }
      }

      const subCore = sub.internalModel?.coreModel;
      if (subCore && typeof subCore.loadParam === 'function') {
        const originalLoadParam = subCore.loadParam.bind(subCore);
        subCore.loadParam = () => {
          originalLoadParam();
          this.syncSubModelParameters(sub);
        };
      }
    }
  }

  /**
   * Enumerate all concrete Live2D model instances managed by this composite.
   */
  public getAllModels(): any[] {
    return [this.mainModel, ...this.subModels].filter(Boolean);
  }

  /**
   * Delegate expressions cleanly to all constituent models.
   */
  public expression(name: string): void {
    for (const model of this.getAllModels()) {
      if (typeof model?.expression === 'function') {
        model.expression(name);
      }
    }
  }

  /**
   * Propagates updates with strict temporal hierarchy and clamped delta times
   */
  public update(dt: number): void {
    // 1. Clamp virtual dt strictly to prevent Euler integration NaN collapse
    const clampedDt = Math.min(50, Math.max(0.001, dt));

    // 2. Step main model first to calculate torso posture and sways
    if (this.mainModel) {
      this.mainModel.update(clampedDt);
      // Flush main model physics/calculations to ensure parameter values are fresh (only if WebGL is bound)
      if (this.mainModel.internalModel?.gl && this.mainModel.internalModel?.coreModel?.update) {
        this.mainModel.internalModel.coreModel.update();
      }
    }

    // 3. Immediately synchronize standard input parameters to sub-models BEFORE they update
    // This ensures sub-model's natural movements/blink multipliers have access to current torso state
    this.syncInputParameters();

    // 4. Step sub-models so their physics engines calculate sways using the fresh torso inputs (Zero Lag!)
    for (const sub of this.subModels) {
      sub.update(clampedDt);
      if (sub.internalModel?.gl && sub.internalModel?.coreModel?.update) {
        sub.internalModel.coreModel.update();
      }
    }
  }

  /**
   * Public synchronizer interface called from both internal updates and external real-time parameter injectors
   */
  public syncInputParameters(): void {
    for (const sub of this.subModels) {
      this.syncSubModelParameters(sub);
    }
  }

  public syncSubModelParameters(subModel: any): void {
    const mainCore = this.mainModel?.internalModel?.coreModel;
    const subCore = subModel?.internalModel?.coreModel;
    if (!mainCore || !subCore) return;

    // Cache the parameter mappings on the subModel to guarantee sub-microsecond O(N) performance
    if (!subModel._paramMappings) {
      subModel._paramMappings = [];
      const paramNames = new Set<string>(Object.keys(CUBISM2_DEFAULT_PARAMS));

      // Native Cubism 2.1 SDK parameter discovery (if supported by ALive2DModel)
      if (typeof mainCore.getParamCount === 'function' && typeof mainCore.getParamId === 'function') {
        try {
          const count = mainCore.getParamCount();
          for (let i = 0; i < count; i++) {
            const id = mainCore.getParamId(i);
            if (id) paramNames.add(id);
          }
        } catch (e) { /* ignore */ }
      }

      for (const name of paramNames) {
        // CRITICAL: Protect physics calculations. Only sync standard INPUT parameters.
        // Explicitly ignore physics output sways (like front/side/back hair or fluffy clothes)
        const upper = name.toUpperCase();
        if (upper.includes('HAIR') || upper.includes('PHYSICS') || upper.includes('FLUFFY') || upper.includes('SWAY')) {
          continue;
        }

        const mainIndex = mainCore.getParamIndex(name);
        if (mainIndex !== -1) {
          const subIndex = subCore.getParamIndex(name);
          if (subIndex !== -1) {
            subModel._paramMappings.push({
              mainIndex: mainIndex,
              subIndex: subIndex
            });
          }
        }
      }
    }

    // 1. Fast sync loop for standard cached parameters
    for (const mapping of subModel._paramMappings) {
      const val = mainCore.getParamFloat(mapping.mainIndex);
      subCore.setParamFloat(mapping.subIndex, val);
    }

    // 2. Dynamic sync loop for real-time injected parameter overrides (e.g. lip sync, custom sways)
    const entry = (this as any)._characterEntry;
    if (entry && entry.injectedParams) {
      for (const key in entry.injectedParams) {
        const subIndex = subCore.getParamIndex(key);
        if (subIndex !== -1) {
          const mainIndex = mainCore.getParamIndex(key);
          if (mainIndex !== -1) {
            const val = mainCore.getParamFloat(mainIndex);
            subCore.setParamFloat(subIndex, val);
          }
        }
      }
    }
  }

  /**
   * Safely destroys both the composite container and all constituent models
   */
  public destroy(options?: any): void {
    // 1. Remove all children from this container first to prevent double-destruction
    this.removeChildren();

    // 2. Safe-destroy torso
    if (this.mainModel) {
      try {
        this.mainModel.destroy({ children: true, texture: false, textureSource: false });
      } catch (e) {}
    }

    // 3. Safe-destroy submodels
    for (const sub of this.subModels) {
      try {
        sub.destroy({ children: true, texture: false, textureSource: false });
      } catch (e) {}
    }

    super.destroy(options);
  }
}
