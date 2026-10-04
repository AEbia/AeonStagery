import { isExplicitResourcePath, parseResourceKey } from './ResourceKeyParser';
import { ResourceIndex } from './ResourceIndex';
import type { ResourceKey, ResourceResolution, ResourceResolutionContext } from './ResourceAuthoringTypes';

const OWNER_CONTEXT_KINDS = new Set(['live2dModel', 'live2dMotion', 'live2dExpression', 'voice']);

export class ResourceAuthoringResolver {
  constructor(private readonly index: ResourceIndex) {}

  resolve(input: string, context: ResourceResolutionContext): ResourceResolution {
    if (isExplicitResourcePath(input)) {
      return {
        status: 'resolved',
        input,
        key: { kind: context.kind, name: input },
        candidate: {
          key: { kind: context.kind, name: input },
          namespace: 'path',
          portablePath: input,
          source: 'explicit',
        },
      };
    }

    let parsed: ResourceKey;
    try {
      parsed = parseResourceKey(input, context.kind);
    } catch (error) {
      return { status: 'not-found', input, diagnostics: [{ code: 'invalid-input', message: error instanceof Error ? error.message : String(error) }] };
    }
    const key: ResourceKey = {
      ...parsed,
      ownerId: parsed.ownerId ?? context.ownerId,
      outfitId: context.outfitId,
    };
    if (OWNER_CONTEXT_KINDS.has(context.kind) && !key.ownerId) {
      return { status: 'not-found', input, key, diagnostics: [{ code: 'missing-owner', message: `Resource kind ${context.kind} requires owner context or owner:name input` }] };
    }
    const candidates = this.index.find(key, key.namespace ? undefined : context.enabledNamespaces);
    if (candidates.length === 0) {
      return { status: 'not-found', input, key, diagnostics: [{ code: 'not-found', message: `No ${context.kind} resource matches "${input}"` }] };
    }
    if (candidates.length > 1) {
      return { status: 'ambiguous', input, key, candidates, diagnostics: [{ code: 'ambiguous', message: `Resource "${input}" has ${candidates.length} equally ranked candidates` }] };
    }
    return { status: 'resolved', input, key, candidate: candidates[0] };
  }
}
