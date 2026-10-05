import type * as HistoryStorageModule from '@/services/historyStorage';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { getAllProjects } from '@/services/storage';
import { HISTORY_LIMIT, useHistoryStore } from '@/stores/history';
import { useLayersStore } from '@/stores/layers';
import { useProjectsStore } from '@/stores/projects';
import { useUIStore } from '@/stores/ui';

const persistence = vi.hoisted(() => ({
  read: vi.fn<(id: string) => Promise<HistoryStorageModule.SavedProjectHistory | null>>(),
  write:
    vi.fn<
      (
        id: string,
        history: HistoryStorageModule.SavedProjectHistory
      ) => Promise<HistoryStorageModule.SavedProjectHistory>
    >(),
}));

// Exercise history semantics without repeatedly writing 1,000 states to disk.
// Persistence itself is covered by historyStorage tests and actual app reloads.
vi.mock('@/services/historyStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof HistoryStorageModule>();
  return {
    ...actual,
    openHistoryStorage: async () => ({
      read: persistence.read,
      write: persistence.write,
      remove: async () => {},
    }),
  };
});

describe('project history', () => {
  let pinia: ReturnType<typeof createPinia>;
  let history: ReturnType<typeof useHistoryStore>;
  let layers: ReturnType<typeof useLayersStore>;
  let projects: ReturnType<typeof useProjectsStore>;
  let ui: ReturnType<typeof useUIStore>;

  beforeEach(async () => {
    persistence.read.mockReset().mockResolvedValue(null);
    persistence.write.mockReset().mockImplementation(async (_id, history) => history);
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    projects = useProjectsStore();
    layers = useLayersStore();
    ui = useUIStore();
    projects.createAndSwitchProject('First');
    layers.addPoint({ id: 'a', name: 'A', coordinates: { lat: 48, lon: 2 } });
    history = useHistoryStore();
    await nextTick();
    await history.start();
  });

  afterEach(async () => {
    await history.flush();
    disposePinia(pinia);
    vi.restoreAllMocks();
  });

  it('keeps writes ordered when fingerprints finish in reverse order', async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const releases: (() => Promise<void>)[] = [];
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args) => {
      const result = digest(...args);
      return new Promise<ArrayBuffer>((resolve) =>
        releases.push(async () => resolve(await result))
      );
    });
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    layers.updatePoint('a', { name: 'C' });
    await nextTick();
    expect(releases).toHaveLength(2);
    await releases[1]!();
    await nextTick();
    expect(persistence.write).not.toHaveBeenCalled();
    await releases[0]!();
    await history.flush();
    expect(persistence.write.mock.calls.map(([, saved]) => saved.position)).toEqual([1, 2]);
    const saved = persistence.write.mock.calls[1]![1];
    expect(saved.steps).toHaveLength(2);
    expect(saved.stateHash).not.toBe(persistence.write.mock.calls[0]![1].stateHash);
  });

  it('waits for an in-flight fingerprint before reopening the same project', async () => {
    const saved = new Map<string, HistoryStorageModule.SavedProjectHistory>();
    persistence.write.mockImplementation(async (id, history) => {
      saved.set(id, history);
      return history;
    });
    persistence.read.mockImplementation(async (id) => saved.get(id) ?? null);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((...args) => {
      const result = digest(...args);
      return new Promise<ArrayBuffer>((resolve) => {
        release = () => resolve(result);
      });
    });
    const firstId = projects.activeProjectId!;
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    projects.createAndSwitchProject('Second');
    layers.clearLayers();
    await nextTick();
    projects.setActiveProject(firstId);
    layers.loadLayers(projects.activeProject!.data);
    await nextTick();
    release();
    await history.flush();
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(layers.points[0]?.name).toBe('A');
  });

  it('does not recreate deleted project history after an in-flight fingerprint', async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((...args) => {
      const result = digest(...args);
      return new Promise<ArrayBuffer>((resolve) => {
        release = () => resolve(result);
      });
    });
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    projects.deleteProject(0);
    release();
    await history.flush();
    expect(persistence.write).not.toHaveBeenCalled();
  });

  for (const editDuringLoad of [false, true]) {
    it(`restores persisted references after load normalization (concurrent edit: ${editDuringLoad})`, async () => {
      layers.addLineSegment({
        id: 'line',
        name: 'Line',
        mode: 'coordinate',
        center: { lat: 48, lon: 2 },
        endpoint: { lat: 49, lon: 3 },
      });
      await history.flush();
      const beforeMove = getAllProjects()[0]!.data;
      layers.updatePoint('a', { coordinates: { lat: 48.5, lon: 2.5 } });
      await history.flush();
      const moved = getAllProjects()[0]!.data;
      const saved = persistence.write.mock.calls.at(-1)![1];
      history.stop();
      projects.loadProjects();
      layers.loadLayers(projects.activeProject!.data);
      expect(projects.activeProject!.data.lineSegments[0]!.startPointId).toBeUndefined();
      expect(getAllProjects()[0]!.data.lineSegments[0]!.startPointId).toBe('a');
      persistence.read.mockResolvedValue(saved);

      if (editDuringLoad) {
        let finishRead!: (history: HistoryStorageModule.SavedProjectHistory) => void;
        persistence.read.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRead = resolve;
            })
        );
        const loading = history.start();
        await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
        layers.updatePoint('a', { name: 'Edited during loading' });
        await nextTick();
        finishRead(saved);
        await loading;
        expect(history.undoCount).toBe(3);
        expect(layers.points[0]!.name).toBe('Edited during loading');
        history.undo();
      } else {
        await history.start();
      }
      expect(history.undoCount).toBe(2);
      expect(layers.exportLayers()).toEqual(moved);
      history.undo();
      expect(layers.exportLayers()).toEqual(beforeMove);
      history.redo();
      expect(layers.exportLayers()).toEqual(moved);
    });
  }

  it('restores isolated copies and ignores no-op edits', async () => {
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    expect(history.undoCount).toBe(1);
    history.undo();
    expect(layers.points[0]?.name).toBe('A');
    expect(history.canUndo).toBe(false);
    await nextTick();
    expect(history.redoCount).toBe(1);
    history.redo();
    expect(layers.points[0]?.name).toBe('B');
    expect(history.canRedo).toBe(false);
    history.undo();
    expect(layers.points[0]?.name).toBe('A');
  });

  it('restores a cascading deletion and its linked note as a single step', async () => {
    layers.addPoint({ id: 'b', name: 'B', coordinates: { lat: 49, lon: 2 } });
    layers.addPoint({ id: 'c', name: 'C', coordinates: { lat: 48, lon: 3 } });
    layers.addPolygon({ id: 'triangle', name: 'Triangle', pointIds: ['a', 'b', 'c'] });
    layers.addNote({
      id: 'clue',
      title: 'Clue',
      content: 'Here',
      linkedElementType: 'point',
      linkedElementId: 'a',
    });
    await nextTick();
    await history.start();
    const original = JSON.stringify(layers.exportLayers());
    layers.deleteNote('clue');
    layers.deletePoint('a');
    await nextTick();
    expect(layers.polygons).toHaveLength(0);
    expect(history.undoCount).toBe(1);
    history.undo();
    expect(JSON.stringify(layers.exportLayers())).toBe(original);
    history.redo();
    expect(layers.points.map((point) => point.id)).toEqual(['b', 'c']);
    expect(layers.polygons).toHaveLength(0);
    expect(layers.notes).toHaveLength(0);
  });

  it('restores groups, ordering, colors and visibility together', async () => {
    const group = layers.createElementGroup('Hypothesis');
    layers.setElementGroup('point', 'a', group.id);
    layers.updatePoint('a', { color: '#123456', listOrder: 3 });
    ui.setElementVisibility('point', 'a', false);
    await nextTick();
    const grouped = JSON.stringify(layers.exportLayers());
    expect(history.undoCount).toBe(1);
    history.undo();
    expect(layers.elementGroups).toHaveLength(0);
    expect(layers.points[0]?.groupId).toBeUndefined();
    expect(layers.points[0]?.color).toBeUndefined();
    expect(ui.isElementVisible('point', 'a')).toBe(true);
    history.redo();
    expect(JSON.stringify(layers.exportLayers())).toBe(grouped);
    expect(ui.isElementVisible('point', 'a')).toBe(false);
  });

  it('keeps exactly 1,000 undo steps and discards only the oldest', async () => {
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++) {
      layers.updatePoint('a', { name: String(i) });
      await nextTick();
    }
    expect(history.undoCount).toBe(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT + 1; i++) history.undo();
    expect(layers.points[0]?.name).toBe('5');
    expect(history.undoCount).toBe(0);
    expect(history.redoCount).toBe(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT; i++) history.redo();
    expect(layers.points[0]?.name).toBe(String(HISTORY_LIMIT + 5));
  });

  it('discards redo after an edit, including one made before the watcher flushes', async () => {
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    history.undo();
    layers.updatePoint('a', { name: 'C' });
    history.redo();
    expect(layers.points[0]?.name).toBe('C');
    expect(history.canRedo).toBe(false);
    history.undo();
    expect(layers.points[0]?.name).toBe('A');
  });

  it('starts a fresh baseline when switching projects in either loading order', async () => {
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    projects.createAndSwitchProject('Second');
    layers.clearLayers();
    await history.flush();
    expect(history.undoCount).toBe(0);
    layers.addPoint({ id: 'second', name: 'Second', coordinates: { lat: 1, lon: 1 } });
    await nextTick();
    history.undo();
    expect(layers.points).toHaveLength(0);
    layers.loadLayers(projects.projects[0]!.data);
    projects.setActiveProject(projects.projects[0]!.id!);
    await nextTick();
    await history.flush();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    history.undo();
    expect(layers.points[0]?.name).toBe('B');
  });

  it('clears inherited visibility for a new project without adding an undo step', async () => {
    ui.setElementVisibility('point', 'a', false);
    await nextTick();
    projects.createAndSwitchProject('Imported copy');
    // Imported projects can contain the exact same element IDs.
    await nextTick();
    await history.flush();
    expect(ui.isElementVisible('point', 'a')).toBe(true);
    expect(history.undoCount).toBe(0);
    expect(history.redoCount).toBe(0);
    layers.updatePoint('a', { name: 'Renamed' });
    await nextTick();
    history.undo();
    expect(layers.points[0]?.name).toBe('A');
    expect(ui.isElementVisible('point', 'a')).toBe(true);
  });

  it('restores projection and layer geometry in the same step', async () => {
    projects.activeProject!.projection = 'geodesic';
    layers.updatePoint('a', { coordinates: { lat: 47, lon: 3 } });
    await nextTick();
    history.undo();
    expect(projects.activeProjection).toBe('mercator');
    expect(layers.points[0]?.coordinates).toEqual({ lat: 48, lon: 2 });
    history.redo();
    expect(projects.activeProjection).toBe('geodesic');
    expect(layers.points[0]?.coordinates).toEqual({ lat: 47, lon: 3 });
  });

  it('waits for asynchronous project creation to finish clearing the old layers', async () => {
    layers.updatePoint('a', { name: 'Old project' });
    await nextTick();
    // Same ordering as creating an image project: set ID, then resume the caller.
    await Promise.resolve().then(() => projects.createAndSwitchProject('New image project'));
    layers.clearLayers();
    await nextTick();
    await history.flush();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    history.undo();
    expect(layers.points).toHaveLength(0);
  });

  it('does not undo while a form or a drawing preview is open', async () => {
    layers.updatePoint('a', { name: 'B' });
    await nextTick();
    ui.openModal('pointModal');
    history.undo();
    expect(layers.points[0]?.name).toBe('B');
    ui.closeModal('pointModal');
    ui.startFreeHandDrawing(null, undefined, 'Preview');
    history.undo();
    expect(layers.points[0]?.name).toBe('B');
    ui.stopFreeHandDrawing();
    history.undo();
    expect(layers.points[0]?.name).toBe('A');
  });
});
