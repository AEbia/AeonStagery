export interface TimelinePoint {
  x: number;
  y: number;
}

export interface TimelineBlockGeometry {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TimelineMarqueeRect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export function resolveMarqueeRect(start: TimelinePoint, end: TimelinePoint): TimelineMarqueeRect {
  return {
    xMin: Math.min(start.x, end.x),
    xMax: Math.max(start.x, end.x),
    yMin: Math.min(start.y, end.y),
    yMax: Math.max(start.y, end.y),
  };
}

export function blockIntersectsMarquee(block: TimelineBlockGeometry, rect: TimelineMarqueeRect): boolean {
  return block.x2 > rect.xMin && block.x1 < rect.xMax && block.y2 > rect.yMin && block.y1 < rect.yMax;
}

export function resolveMarqueeSelection(input: {
  start: TimelinePoint;
  end: TimelinePoint;
  blocks: ReadonlyArray<TimelineBlockGeometry>;
}): string[] {
  const rect = resolveMarqueeRect(input.start, input.end);
  return input.blocks.filter((block) => blockIntersectsMarquee(block, rect)).map((block) => block.id);
}
