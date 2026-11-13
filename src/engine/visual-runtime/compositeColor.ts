export type ColorStopSet = [number, number, number, number];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseColor(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(Math.round(value), 0x000000, 0xffffff);
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return parseInt(normalized, 16);
}

export function averageColor(stops: ColorStopSet): number {
  const channels = stops.reduce(
    (sum, color) => {
      sum.r += (color >> 16) & 0xff;
      sum.g += (color >> 8) & 0xff;
      sum.b += color & 0xff;
      return sum;
    },
    { r: 0, g: 0, b: 0 },
  );
  const r = Math.round(channels.r / stops.length);
  const g = Math.round(channels.g / stops.length);
  const b = Math.round(channels.b / stops.length);
  return (r << 16) | (g << 8) | b;
}

export function colorChannels(value: number): { r: number; g: number; b: number } {
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

export function packColor(r: number, g: number, b: number): number {
  return (clamp(Math.round(r), 0, 255) << 16)
    | (clamp(Math.round(g), 0, 255) << 8)
    | clamp(Math.round(b), 0, 255);
}

export function mixColor(a: number, b: number, alpha: number): number {
  const mixAmount = clamp(alpha, 0, 1);
  const ca = colorChannels(a);
  const cb = colorChannels(b);
  return packColor(
    ca.r + (cb.r - ca.r) * mixAmount,
    ca.g + (cb.g - ca.g) * mixAmount,
    ca.b + (cb.b - ca.b) * mixAmount,
  );
}

export function scaleColor(value: number, factor: number): number {
  const { r, g, b } = colorChannels(value);
  return packColor(r * factor, g * factor, b * factor);
}

export function saturateColor(value: number, saturationDelta: number): number {
  const amount = clamp(saturationDelta, -1, 1);
  const { r, g, b } = colorChannels(value);
  const avg = (r + g + b) / 3;
  return packColor(
    avg + (r - avg) * (1 + amount),
    avg + (g - avg) * (1 + amount),
    avg + (b - avg) * (1 + amount),
  );
}

export function luminanceOfColor(value: number): number {
  const { r, g, b } = colorChannels(value);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function saturationOfColor(value: number): number {
  const { r, g, b } = colorChannels(value);
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  return max <= 0 ? 0 : (max - min) / max;
}

export function cloneColorStops(stops: ColorStopSet): ColorStopSet {
  return [stops[0], stops[1], stops[2], stops[3]];
}
