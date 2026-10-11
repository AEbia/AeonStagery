export interface TimelineRowSize {
  id: string;
  measurementKey: string;
  estimatedHeight: number;
}

/** Prefix sums let an animated row update geometry without scanning the whole script. */
export class TimelineRowLayout {
  readonly indexById = new Map<string, number>();
  private readonly indexByKey = new Map<string, number>();
  private readonly heights: Float64Array;
  private readonly sums: Float64Array;
  totalHeight = 0;

  constructor(rows: readonly TimelineRowSize[], measured: ReadonlyMap<string, number>) {
    this.heights = new Float64Array(rows.length);
    this.sums = new Float64Array(rows.length + 1);
    rows.forEach((row, index) => {
      this.indexById.set(row.id, index);
      this.indexByKey.set(row.measurementKey, index);
      const height = measured.get(row.measurementKey) ?? row.estimatedHeight;
      this.heights[index] = height;
      this.totalHeight += height;
      const node = index + 1;
      this.sums[node] += height;
      const parent = node + (node & -node);
      if (parent < this.sums.length) this.sums[parent] += this.sums[node];
    });
  }

  setHeight(key: string, height: number) {
    const index = this.indexByKey.get(key);
    if (index === undefined) return;
    const delta = height - this.heights[index];
    this.heights[index] = height;
    this.totalHeight += delta;
    for (let node = index + 1; node < this.sums.length; node += node & -node) this.sums[node] += delta;
  }

  getOffset = (index: number): number => {
    let offset = 0;
    for (let node = index; node > 0; node -= node & -node) offset += this.sums[node];
    return offset;
  };

  findRow(position: number): number {
    let index = 0;
    let offset = 0;
    // Find the largest prefix whose sum does not exceed the scroll position.
    for (let step = 2 ** Math.floor(Math.log2(this.heights.length || 1)); step > 0; step >>= 1) {
      const next = index + step;
      if (next < this.sums.length && offset + this.sums[next] <= position) {
        index = next;
        offset += this.sums[next];
      }
    }
    return Math.max(0, Math.min(index, this.heights.length - 1));
  }
}
