import { describe, it, expect, beforeEach } from 'vitest';
import { TimelineAdapter } from '../api/adapters/TimelineAdapter';
import { EditorStore } from '../ui/store/EditorStore';

describe('TimelineAdapter', () => {
  let editorStore: EditorStore;
  let adapter: TimelineAdapter;

  beforeEach(() => {
    editorStore = new EditorStore();
    adapter = new TimelineAdapter(editorStore);
  });

  // ── Constructor ────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts an EditorStore instance', () => {
      expect(adapter).toBeDefined();
      expect(() => new TimelineAdapter(editorStore)).not.toThrow();
    });

    it('requires an EditorStore argument', () => {
      expect(() => new TimelineAdapter(null as any)).toThrow();
    });
  });

  // ── select() ───────────────────────────────────────────────

  describe('select()', () => {
    it('calls editorStore._setSelectedIds to set selected action ids', () => {
      adapter.select({ 'a1': true, 'a2': true });
      expect(editorStore.selectedActionIds).toEqual({ 'a1': true, 'a2': true });
    });

    it('handles single-element selection', () => {
      adapter.select({ 'a7': true });
      expect(editorStore.selectedActionIds).toEqual({ 'a7': true });
    });
  });

  // ── clearSelection() ───────────────────────────────────────

  describe('clearSelection()', () => {
    it('clears selection in editorStore', () => {
      adapter.select({ 'a1': true, 'a2': true });
      adapter.clearSelection();
      expect(editorStore.selectedActionIds).toEqual({});
    });

    it('is idempotent — calling clearSelection on empty selection does not throw', () => {
      expect(() => adapter.clearSelection()).not.toThrow();
      expect(editorStore.selectedActionIds).toEqual({});
    });
  });

  // ── getSelectedIds() ───────────────────────────────────

  describe('getSelectedIds()', () => {
    it('returns the value from editorStore', () => {
      adapter.select({ 'a2': true, 'a4': true });
      const ids = adapter.getSelectedIds();
      expect(ids).toEqual({ 'a2': true, 'a4': true });
      expect(ids).toEqual(editorStore.selectedActionIds);
    });

    it('returns empty object when nothing selected', () => {
      adapter.clearSelection();
      const ids = adapter.getSelectedIds();
      expect(ids).toEqual({});
    });
  });
});
