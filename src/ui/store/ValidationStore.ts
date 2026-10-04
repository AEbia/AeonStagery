import type { ValidationIssue } from '../../api/types/validation';

/**
 * Producers of validation issues. Each source updates *its* slice only; the
 * store merges all sources so a slow async scan can never clobber results
 * produced by a different, faster source.
 */
export type ValidationIssueSource = 'structure' | 'scene-assets' | 'project-dependencies';

const SOURCE_ORDER: ValidationIssueSource[] = ['structure', 'scene-assets', 'project-dependencies'];

export class ValidationStore {
  private _issues: ValidationIssue[] = [];
  private _structure: ValidationIssue[] = [];
  private readonly _sourceIssues = new Map<ValidationIssueSource, ValidationIssue[]>();
  private _loading: boolean = false;
  private _errorsCount: number = 0;
  private _warningsCount: number = 0;
  private _severityMap: Map<string, 'error' | 'warning' | null> = new Map();
  private _messageMap: Map<string, string | null> = new Map();
  readonly _listeners: Set<() => void> = new Set();

  get issues(): ValidationIssue[] { return this._issues; }
  get loading(): boolean { return this._loading; }

  get errorsCount(): number {
    return this._errorsCount;
  }

  get warningsCount(): number {
    return this._warningsCount;
  }

  private _notify(): void {
    this._listeners.forEach(fn => fn());
  }

  /** Replace the issues contributed by one source and re-merge all sources. */
  _setSourceIssues(source: ValidationIssueSource, issues: ValidationIssue[]): void {
    if (source === 'structure') {
      this._structure = issues;
    } else {
      this._sourceIssues.set(source, issues);
    }
    this._merge();
  }

  /**
   * Compatibility entry point used by the synchronous structure stage:
   * replaces the `structure` slice only — dependency and scene-asset slices
   * survive so a fast sync pass cannot erase them.
   */
  _setIssues(issues: ValidationIssue[]): void {
    this._setSourceIssues('structure', issues);
  }

  /** Drop every contribution (project close/switch). */
  _clearAllSources(): void {
    this._structure = [];
    this._sourceIssues.clear();
    this._merge();
  }

  private _merge(): void {
    this._issues = this._structure;
    for (const source of SOURCE_ORDER) {
      if (source === 'structure') continue;
      const slice = this._sourceIssues.get(source);
      if (slice && slice.length > 0) this._issues = this._issues.concat(slice);
    }
    this._rebuildDerived();
  }

  /** Pre-build O(1) dictionaries after every merged update. */
  private _rebuildDerived(): void {
    const issues = this._issues;
    this._errorsCount = 0;
    this._warningsCount = 0;

    // Synchronously rebuild Map dictionaries for O(1) getSnapshot queries
    const newSeverityMap = new Map<string, 'error' | 'warning' | null>();
    const newMessageMap = new Map<string, string | null>();

    issues.forEach(issue => {
      if (issue.severity === 'error') this._errorsCount += 1;
      if (issue.severity === 'warning') this._warningsCount += 1;

      if (issue.actionId) {
        // Errors have precedence over warnings for visual highlighting
        const existing = newSeverityMap.get(issue.actionId);
        if (existing !== 'error') {
          newSeverityMap.set(issue.actionId, issue.severity);
        }

        // Aggregate messages if multiple issues exist for a single Action
        const existingMsg = newMessageMap.get(issue.actionId);
        const prefix = issue.severity === 'error' ? '[错误] ' : '[警告] ';
        const formattedMsg = `${prefix}${issue.message}`;
        if (existingMsg) {
          newMessageMap.set(issue.actionId, `${existingMsg}\n${formattedMsg}`);
        } else {
          newMessageMap.set(issue.actionId, formattedMsg);
        }
      }
    });

    this._severityMap = newSeverityMap;
    this._messageMap = newMessageMap;

    this._notify();
  }

  _setLoading(loading: boolean): void {
    if (this._loading === loading) return;
    this._loading = loading;
    this._notify();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  // ─── Non-reactive O(1) Fast Query APIs ──────────────────────────

  getSeverityByActionId(actionId: string): 'error' | 'warning' | null {
    return this._severityMap.get(actionId) || null;
  }

  getIssueMessageByActionId(actionId: string): string | null {
    return this._messageMap.get(actionId) || null;
  }
}
