import type { ProjectLayerData } from '@/types/project';
import { describe, expect, it } from 'vitest';
import {
  applyHistoryStep,
  captureHistorySnapshot,
  createHistoryStep,
  HISTORY_MAX_BYTES,
  historyBytes,
  historyLayers,
  trimHistory,
} from '@/services/historyDelta';

function state(points: ProjectLayerData['points'], visibility = {}) {
  return captureHistorySnapshot(
    {
      points,
      routes: [],
      circles: [],
      lineSegments: [],
      polygons: [],
      notes: [],
      elementGroups: [],
    },
    'mercator',
    visibility
  );
}
const point = (id: string) => ({ id, name: id, coordinates: { lat: 48, lon: 2 } });

describe('field-level history', () => {
  it('undoes an addition even when loading has added default fields to the element', () => {
    const before = state([]);
    const created = state([point('a')]);
    const step = createHistoryStep(before, created)!;
    const loaded = state([{ ...point('a'), createdAt: 123 }]);
    const undone = applyHistoryStep(loaded, step, false);
    expect(undone).toEqual(before);
    expect(createHistoryStep(undone, state([]))).toBeNull();
    expect(applyHistoryStep(undone, step, true)).toEqual(created);
  });

  it('preserves addition, deletion, reorder, missing fields and false visibility in both directions', () => {
    const a = state([{ ...point('a'), color: 'red' }, point('b'), point('c')], { point_a: false });
    const b = state([point('c'), point('a'), point('d')], { point_d: false });
    b.projection = 'geodesic';
    const step = createHistoryStep(a, b)!;
    expect(applyHistoryStep(a, step, true)).toEqual(b);
    expect(applyHistoryStep(b, step, false)).toEqual(a);
    expect(historyLayers(applyHistoryStep(a, step, true)).points).toEqual([
      point('c'),
      point('a'),
      point('d'),
    ]);
  });

  it('stores only the changed field among 1,000 large routes', () => {
    const data = {
      ...historyLayers(state([])),
      routes: Array.from({ length: 1000 }, (_, i) => ({
        id: `route-${i}`,
        name: `Route ${i}`,
        start: { lat: 48, lon: 2 },
        end: { lat: 49, lon: 3 },
        coordinates: Array.from({ length: 100 }, (_, n): [number, number] => [
          2 + n / 100,
          48 + n / 100,
        ]),
        distance: 1000,
        duration: 1000,
        profile: 'pedestrian' as const,
        optimization: 'shortest' as const,
      })),
    };
    const a = captureHistorySnapshot(data, 'mercator', {});
    data.routes[500]!.name = 'Renamed';
    const b = captureHistorySnapshot(data, 'mercator', {});
    const step = createHistoryStep(a, b)!;
    expect(step.delta).not.toContain('coordinates');
    expect(step.delta).not.toContain('route-499');
    expect(step.delta.length).toBeLessThan(200);
    expect(historyLayers(applyHistoryStep(b, step, false))).toEqual(historyLayers(a));
  });

  it('retains all 1,000 small steps well below the byte budget', () => {
    let current = state([point('a')]);
    const steps = [];
    for (let i = 0; i < 1000; i++) {
      const next = state([{ ...point('a'), name: String(i) }]);
      steps.push(createHistoryStep(current, next)!);
      current = next;
    }
    const history = trimHistory({ steps, position: 1000, visibility: {} });
    expect(history.steps).toHaveLength(1000);
    expect(historyBytes(history)).toBeLessThan(1024 * 1024);
  });

  it('trims by bytes even below 1,000 steps and keeps the current state reachable', () => {
    let current = state([point('a')]);
    const steps = [];
    for (let i = 0; i < 8; i++) {
      const next = state([{ ...point('a'), name: String(i).repeat(400_000) }]);
      steps.push(createHistoryStep(current, next)!);
      current = next;
    }
    const history = trimHistory({ steps, position: steps.length, visibility: {} });
    expect(history.steps.length).toBeGreaterThan(0);
    expect(history.steps.length).toBeLessThan(steps.length);
    expect(historyBytes(history)).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    expect(history.position).toBe(history.steps.length);
    const previous = applyHistoryStep(current, history.steps.at(-1)!, false);
    expect(applyHistoryStep(previous, history.steps.at(-1)!, true)).toEqual(current);
    const redo = trimHistory({ steps, position: 0, visibility: {} });
    expect(redo.steps[0]).toBe(steps[0]);
    expect(redo.position).toBe(0);
    expect(historyBytes(redo)).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  });

  it('drops an oversized edit and preceding undo instead of exceeding the budget', () => {
    const a = state([point('a')]);
    const b = state([{ ...point('a'), name: 'B' }]);
    const c = state([{ ...point('a'), name: 'x'.repeat(HISTORY_MAX_BYTES) }]);
    const history = trimHistory({
      steps: [createHistoryStep(a, b)!, createHistoryStep(b, c)!],
      position: 2,
      visibility: {},
    });
    expect(history.steps).toEqual([]);
    expect(history.position).toBe(0);
  });
});
