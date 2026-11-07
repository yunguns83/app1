// IndexedDB 래퍼 — 모든 일기는 기기 안에만 저장됩니다.
const DB_NAME = 'diary-db';
const STORE = 'entries';
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('date', 'date');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  all: () => tx('readonly', (s) => s.getAll()),
  get: (id) => tx('readonly', (s) => s.get(id)),
  put: (entry) => tx('readwrite', (s) => s.put(entry)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  bulkPut: (entries) => tx('readwrite', (s) => { entries.forEach((e) => s.put(e)); })
};
