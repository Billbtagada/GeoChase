import type { SavedProjectHistory } from '@/services/historyStorage';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureHistorySnapshot, createHistoryStep } from '@/services/historyDelta';
import {
  deleteProjectHistory,
  HISTORY_LIMIT,
  openHistoryStorage,
  projectHistoryHash,
} from '@/services/historyStorage';

function snapshot(name: string) {
  return captureHistorySnapshot(
    {
      routes: [],
      circles: [],
      lineSegments: [],
      polygons: [],
      notes: [],
      elementGroups: [],
      points: [{ id: 'p', name, coordinates: { lat: 48, lon: 2 } }],
    },
    'mercator',
    {}
  );
}
function history(names: string[], position = names.length - 1): SavedProjectHistory {
  return {
    stateHash: `state-${names[position]}`,
    steps: names
      .slice(1)
      .map((name, index) => createHistoryStep(snapshot(names[index]!), snapshot(name))!),
    position,
    visibility: {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe('local project history storage', () => {
  it('fingerprints project content and projection without retaining attachments or view state', async () => {
    const project = {
      data: { circles: [], lineSegments: [], points: [], polygons: [], notes: [] },
      projection: 'mercator' as const,
      viewData: { topPanelOpen: true, sidePanelOpen: true },
      pdfData: 'large attachment',
      updatedAt: 1,
    };
    const hash = await projectHistoryHash(project);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await projectHistoryHash({ ...project, projection: undefined })).toBe(hash);
    const metadataChanged = { ...project, pdfData: 'other', viewData: undefined, updatedAt: 2 };
    expect(await projectHistoryHash(metadataChanged)).toBe(hash);
    expect(await projectHistoryHash({ ...project, projection: 'geodesic' })).not.toBe(hash);
    expect(
      await projectHistoryHash({
        ...project,
        data: {
          ...project.data,
          points: [{ id: 'a', name: 'A', coordinates: { lat: 1, lon: 2 } }],
        },
      })
    ).not.toBe(hash);
  });

  it('persists both branches and the cursor, independently for each project', async () => {
    const storage = await openHistoryStorage();
    const first = history(['A', 'B', 'C'], 1);
    const second = history(['Other']);
    await storage.write('history-first', first);
    await storage.write('history-second', second);
    expect(await storage.read('history-first')).toEqual(first);
    expect(await storage.read('history-second')).toEqual(second);
    await deleteProjectHistory('history-first');
    expect(await storage.read('history-first')).toBeNull();
    expect(await storage.read('history-second')).toEqual(second);
  });

  it('retains all 1,000 steps and captures values before a later mutation', async () => {
    const storage = await openHistoryStorage();
    const first = history(
      Array.from({ length: HISTORY_LIMIT + 1 }, (_, i) => String(i)),
      512
    );
    const expected = first.steps.slice();
    const writing = storage.write('history-limit', first);
    first.position = 0;
    first.steps.length = 0;
    await writing;
    const saved = (await storage.read('history-limit'))!;
    expect(saved.steps).toEqual(expected);
    expect(saved.position).toBe(512);
  });

  it('commits rapid writes in order and only writes each immutable step once', async () => {
    const storage = await openHistoryStorage();
    const first = history(['Before', 'After']);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await Promise.all([
      storage.write('history-rapid', first),
      storage.write('history-rapid', { ...first, position: 0 }),
    ]);
    expect((await storage.read('history-rapid'))?.position).toBe(0);
    expect(put.mock.calls.filter(([value]) => typeof value === 'string')).toHaveLength(1);
  });

  it('deletes unreachable steps when branching or deleting a project', async () => {
    const storage = await openHistoryStorage();
    const first = history(['A', 'B', 'C']);
    await storage.write('history-branch', first);
    const remove = vi.spyOn(IDBObjectStore.prototype, 'delete');
    const second = { ...first, steps: [first.steps[0]!, ...history(['B', 'D']).steps] };
    await storage.write('history-branch', second);
    expect(remove).toHaveBeenCalledWith(['history-branch', first.steps[1]!.id]);
    await storage.remove('history-branch');
    for (const step of second.steps)
      expect(remove).toHaveBeenCalledWith(['history-branch', step.id]);
  });

  it('retries quota failures with fewer steps while retaining the present visibility', async () => {
    const storage = await openHistoryStorage();
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(
      new Proxy(originalPut, {
        apply(target, store: IDBObjectStore, args: Parameters<typeof originalPut>) {
          const [value] = args;
          if (store.name === 'histories' && value.steps.length > 1)
            throw new DOMException('Full', 'QuotaExceededError');
          return Reflect.apply(target, store, args);
        },
      })
    );
    const first = { ...history(['A', 'B', 'C', 'D', 'E']), visibility: { point_p: false } };
    const saved = await storage.write('history-quota', first);
    expect(saved.steps).toEqual(first.steps.slice(-1));
    expect(saved.position).toBe(1);
    expect(saved.visibility).toEqual(first.visibility);
    expect(await storage.read('history-quota')).toEqual(saved);
    expect(first.steps).toHaveLength(4);
  });
});
