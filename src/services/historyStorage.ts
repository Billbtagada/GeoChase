import type { HistoryStep, ProjectHistory } from './historyDelta';
import type { ProjectData } from '@/types/project';
import { HISTORY_LIMIT, trimHistory } from './historyDelta';

export { HISTORY_LIMIT, HISTORY_MAX_BYTES } from './historyDelta';
export type { HistoryStep, ProjectHistory } from './historyDelta';

interface StoredHistory {
  version: 2;
  stateHash: string;
  steps: string[];
  position: number;
  visibility: Record<string, boolean>;
}
export interface SavedProjectHistory extends ProjectHistory {
  stateHash: string;
}
export interface HistoryStorage {
  read: (id: string) => Promise<SavedProjectHistory | null>;
  write: (id: string, history: SavedProjectHistory) => Promise<SavedProjectHistory>;
  remove: (id: string) => Promise<void>;
}

export async function projectHistoryHash(project: Pick<ProjectData, 'data' | 'projection'>) {
  // Capture the saved content synchronously, before any edits during hashing.
  // View state, timestamps and attachments do not affect undo/redo compatibility.
  const bytes = new TextEncoder().encode(
    JSON.stringify([project.data, project.projection ?? 'mercator'])
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let connection: Promise<HistoryStorage> | null = null;

export function openHistoryStorage(): Promise<HistoryStorage> {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('geochase_project_history', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      // The snapshot format was never deployed. Start fresh rather than migrate it.
      if (db.objectStoreNames.contains('histories')) db.deleteObjectStore('histories');
      db.createObjectStore('histories');
      db.createObjectStore('steps');
    };
    request.addEventListener('error', () => {
      connection = null;
      reject(request.error);
    });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      let pending: Promise<unknown> = Promise.resolve();
      function serialize<T>(action: () => Promise<T>): Promise<T> {
        const result = pending.catch(() => {}).then(action);
        pending = result;
        return result;
      }
      function mutate(id: string, history?: SavedProjectHistory): Promise<void> {
        return new Promise((done, fail) => {
          const transaction = db.transaction(['histories', 'steps'], 'readwrite');
          const histories = transaction.objectStore('histories');
          const steps = transaction.objectStore('steps');
          const read = histories.get(id);
          let failure: unknown;
          read.onsuccess = () => {
            try {
              const previous = new Set<string>((read.result as StoredHistory | undefined)?.steps);
              const current = new Set(history?.steps.map((step) => step.id));
              for (const key of previous) if (!current.has(key)) steps.delete([id, key]);
              if (history) {
                for (const step of history.steps) {
                  // Immutable steps are written once. Undo/redo only updates metadata.
                  if (!previous.has(step.id)) steps.put(step.delta, [id, step.id]);
                }
                const metadata: StoredHistory = {
                  version: 2,
                  stateHash: history.stateHash,
                  steps: history.steps.map((step) => step.id),
                  position: history.position,
                  visibility: history.visibility,
                };
                histories.put(metadata, id);
              } else histories.delete(id);
            } catch (error) {
              failure = error;
              transaction.abort();
            }
          };
          transaction.oncomplete = () => done();
          transaction.addEventListener('abort', () => fail(failure ?? transaction.error));
        });
      }
      async function write(id: string, history: SavedProjectHistory): Promise<SavedProjectHistory> {
        const retained = trimHistory(history);
        for (;;) {
          try {
            await mutate(id, retained);
            return retained;
          } catch (error) {
            if (
              !(error instanceof Error || error instanceof DOMException) ||
              error.name !== 'QuotaExceededError' ||
              retained.steps.length === 0
            )
              throw error;
            // A PDF/image or other projects may leave less than our normal budget.
            // Retry with less undo/redo without ever removing project content.
            const keep = Math.floor(retained.steps.length / 2);
            while (retained.steps.length > keep) {
              if (retained.position > 0) {
                retained.steps.shift();
                retained.position--;
              } else retained.steps.pop();
            }
          }
        }
      }
      resolve({
        read: (id) =>
          serialize(
            () =>
              new Promise((done, fail) => {
                const transaction = db.transaction(['histories', 'steps']);
                const read = transaction.objectStore('histories').get(id);
                read.onsuccess = () => {
                  const metadata = read.result as StoredHistory | undefined;
                  if (!metadata) {
                    done(null);
                    return;
                  }
                  if (
                    metadata.version !== 2 ||
                    typeof metadata.stateHash !== 'string' ||
                    !Array.isArray(metadata.steps) ||
                    metadata.steps.length > HISTORY_LIMIT ||
                    !Number.isInteger(metadata.position) ||
                    metadata.position < 0 ||
                    metadata.position > metadata.steps.length
                  ) {
                    fail(new Error('Invalid project history'));
                    return;
                  }
                  const steps: HistoryStep[] = [];
                  const requests = metadata.steps.map(
                    (key, index) =>
                      new Promise<void>((resolveStep, rejectStep) => {
                        const step = transaction.objectStore('steps').get([id, key]);
                        step.onsuccess = () => {
                          if (typeof step.result !== 'string') {
                            rejectStep(new Error('Missing history step'));
                            return;
                          }
                          steps[index] = { id: key, delta: step.result };
                          resolveStep();
                        };
                        step.addEventListener('error', () => rejectStep(step.error));
                      })
                  );
                  void Promise.all(requests)
                    .then(() =>
                      trimHistory({
                        stateHash: metadata.stateHash,
                        steps,
                        position: metadata.position,
                        visibility: metadata.visibility,
                      })
                    )
                    .then(done, fail);
                };
                read.addEventListener('error', () => fail(read.error));
                transaction.addEventListener('abort', () => fail(transaction.error));
              })
          ),
        write: (id, history) => {
          // Capture the request immediately, before the caller records its next edit.
          const copy = {
            ...history,
            steps: history.steps.slice(),
            visibility: { ...history.visibility },
          };
          return serialize(() => write(id, copy));
        },
        remove: (id) => serialize(() => mutate(id)),
      });
    };
  });
  return connection;
}

export async function deleteProjectHistory(id: string): Promise<void> {
  const storage = await openHistoryStorage();
  await storage.remove(id);
}
