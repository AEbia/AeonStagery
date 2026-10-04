export type HookEvent =
  | 'scene:load'
  | 'scene:play'
  | 'scene:pause'
  | 'scene:seek'
  | 'scene:end'
  | 'character:add'
  | 'character:remove'
  | 'character:motion'
  | 'character:expression'
  | 'dialogue:show'
  | 'dialogue:hide'
  | 'camera:move'
  | 'camera:shake'
  | 'animation:custom'
  | 'export:start'
  | 'export:stop'
  | string; // Allow custom events

export interface HookContext {
  event: string;
  timestamp: number;
  data?: any;
  /** Cancel the default behavior (if applicable) */
  preventDefault(): void;
  prevented: boolean;
}
