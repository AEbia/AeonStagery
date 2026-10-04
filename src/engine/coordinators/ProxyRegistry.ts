import type { TransformationProxy } from '../actions/types';

const DEFAULTS: TransformationProxy = {
  x: 960,
  y: 540,
  scale: 1,
  rotation: 0,
  opacity: 1,
  z: 0,
};

export class ProxyRegistry extends Map<string, TransformationProxy> {
  override set(id: string, value: Partial<TransformationProxy>): this {
    const existing = super.get(id);
    if (existing) {
      Object.assign(existing, value);
    } else {
      super.set(id, { ...DEFAULTS, ...value } as TransformationProxy);
    }
    return this;
  }

  patch(id: string, values: Partial<TransformationProxy>): void {
    this.set(id, values);
  }
}
