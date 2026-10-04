import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { ModelCapabilityPort } from './EnhancementProcessorRunner';

export interface PerformanceCapabilityResourceDiagnostic {
  readonly gate: 'resource';
  readonly severity: 'error';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export function validatePerformanceResourceCapabilities(
  document: CurrentSceneDocument,
  capabilities: ModelCapabilityPort,
): readonly PerformanceCapabilityResourceDiagnostic[] {
  const characters = new Map((document.meta.characters ?? []).map((character) => [character.id, character]));
  const diagnostics: PerformanceCapabilityResourceDiagnostic[] = [];

  for (const statement of document.statements) {
    if (statement.type === 'characterPerformance') {
      validatePerformanceFields({
        params: statement.params as unknown as Record<string, unknown>,
        target: readString(statement.params.target),
        characters,
        capabilities,
        diagnostics,
        path: `statement:${statement.id}.params`,
      });
    }
    if (statement.type !== 'dialogue' || !statement.companions) continue;
    const speakerId = readString(statement.params.speakerId);
    for (const companion of statement.companions) {
      if (companion.type !== 'characterPerformance') continue;
      validatePerformanceFields({
        params: companion.params as unknown as Record<string, unknown>,
        target: readString(companion.params.target),
        speakerId,
        characters,
        capabilities,
        diagnostics,
        path: `statement:${statement.id}.companion:${companion.id}.params`,
      });
    }
  }

  return diagnostics;
}

function validatePerformanceFields(input: {
  readonly params: Readonly<Record<string, unknown>>;
  readonly target?: string;
  readonly speakerId?: string;
  readonly characters: ReadonlyMap<string, NonNullable<CurrentSceneDocument['meta']['characters']>[number]>;
  readonly capabilities: ModelCapabilityPort;
  readonly diagnostics: PerformanceCapabilityResourceDiagnostic[];
  readonly path: string;
}): void {
  const motion = readMotionKey(input.params.motion);
  const expression = readNonEmptyString(input.params.expression);
  if (!motion && !expression) return;

  const targetId = input.target === '$speaker' ? input.speakerId : input.target;
  if (!targetId) {
    input.diagnostics.push({
      gate: 'resource',
      severity: 'error',
      code: 'performance_target_unresolved',
      message: `Performance target cannot be resolved at ${input.path}.target`,
      path: `${input.path}.target`,
    });
    return;
  }

  if (!input.characters.has(targetId)) {
    input.diagnostics.push({
      gate: 'resource',
      severity: 'error',
      code: 'performance_target_missing',
      message: `Performance target "${targetId}" is not present in the scene character directory`,
      path: `${input.path}.target`,
    });
    return;
  }

  if (!input.capabilities.hasModelConfigured(targetId)) {
    if (motion) pushUnavailable(input, 'motion_without_model', `Motion "${motion}" requires a configured model`, `${input.path}.motion`);
    if (expression) pushUnavailable(input, 'expression_without_model', `Expression "${expression}" requires a configured model`, `${input.path}.expression`);
    return;
  }

  if (input.capabilities.capabilitiesReadyForCharacter
    && !input.capabilities.capabilitiesReadyForCharacter(targetId)) {
    pushUnavailable(
      input,
      'model_capabilities_unavailable',
      input.capabilities.capabilityErrorForCharacter?.(targetId)
        ?? `Model capabilities for "${targetId}" are unavailable`,
      input.path,
    );
    return;
  }

  if (motion && !input.capabilities.motionsForCharacter(targetId).includes(motion)) {
    pushUnavailable(input, 'motion_unavailable', `Motion "${motion}" is not available on model "${targetId}"`, `${input.path}.motion`);
  }
  if (expression && !input.capabilities.expressionsForCharacter(targetId).includes(expression)) {
    pushUnavailable(input, 'expression_unavailable', `Expression "${expression}" is not available on model "${targetId}"`, `${input.path}.expression`);
  }
}

function readMotionKey(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (!value || typeof value !== 'object') return undefined;
  const motion = value as { kind?: unknown; key?: unknown; derivedFrom?: { key?: unknown } };
  if (motion.kind === 'resource') return readNonEmptyString(motion.key);
  if (motion.kind === 'custom') return readNonEmptyString(motion.derivedFrom?.key);
  return undefined;
}

function pushUnavailable(
  input: { diagnostics: PerformanceCapabilityResourceDiagnostic[] },
  code: string,
  message: string,
  path: string,
): void {
  input.diagnostics.push({ gate: 'resource', severity: 'error', code, message, path });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return readString(value);
}
