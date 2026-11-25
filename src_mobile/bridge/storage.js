// ============================================================================
// MintPy Mobile Storage Engine (IndexedDB + RAM Cache + localStorage Migration)
// Eliminates the 5 MB localStorage ceiling & synchronous JSON serialization lag.
// ============================================================================
(function () {
  'use strict';

  const DB_NAME = 'mintpy_mobile_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const MIGRATION_FLAG = 'mintpy_idb_migrated_v1';

  const KEYS = {
    SETTINGS: 'mintpy_settings',
    HISTORY: 'mintpy_history',
    FAVORITES: 'mintpy_favorites',
    PLAYLISTS: 'mintpy_playlists',
    QUEUE: 'mintpy_queue',
    LIBRARY: 'mintpy_library'
  };

  const memCache = new Map();
  const pendingWrites = new Map();
  let dbInstance = null;
  let flushTimer = null;

  // Seed initial RAM cache from legacy localStorage immediately for 0ms boot,
  // then hydrate/override from IndexedDB asynchronously once opened.
  for (const key of Object.values(KEYS)) {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        memCache.set(key, JSON.parse(raw));
      }
    } catch {}
  }

  function openDatabase() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);

    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = (e) => {
          dbInstance = e.target.result;
          resolve(dbInstance);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  const readyPromise = (async () => {
    const db = await openDatabase();
    if (!db) return;

    // Load all existing keys from IndexedDB into RAM cache
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (!pendingWrites.has(cursor.key)) {
              memCache.set(cursor.key, cursor.value);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });

    // One-time seamless migration from legacy localStorage -> IndexedDB
    try {
      if (!localStorage.getItem(MIGRATION_FLAG)) {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const [k, v] of memCache.entries()) {
          store.put(v, k);
        }
        tx.oncomplete = () => {
          try {
            localStorage.setItem(MIGRATION_FLAG, '1');
            // Free large localStorage collections while keeping tiny settings mirror
            for (const heavyKey of [KEYS.HISTORY, KEYS.FAVORITES, KEYS.PLAYLISTS, KEYS.QUEUE, KEYS.LIBRARY]) {
              localStorage.removeItem(heavyKey);
            }
          } catch {}
        };
      }
    } catch {}
  })();

  function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingWrites.size) return;

    const entries = Array.from(pendingWrites.entries());
    pendingWrites.clear();

    if (dbInstance) {
      try {
        const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const [k, v] of entries) {
          store.put(v, k);
        }
      } catch {
        fallbackLocalWrite(entries);
      }
    } else {
      openDatabase().then((db) => {
        if (!db) {
          fallbackLocalWrite(entries);
          return;
        }
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          for (const [k, v] of entries) {
            store.put(v, k);
          }
        } catch {
          fallbackLocalWrite(entries);
        }
      });
    }

    // Keep lightweight settings mirrored in localStorage for instant theme boot
    for (const [k, v] of entries) {
      if (k === KEYS.SETTINGS) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
      }
    }
  }

  function fallbackLocalWrite(entries) {
    for (const [k, v] of entries) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    }
  }

  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushNow();
  });

  function getSync(key, def) {
    return memCache.has(key) ? memCache.get(key) : def;
  }

  async function getAsync(key, def) {
    await readyPromise;
    return memCache.has(key) ? memCache.get(key) : def;
  }

  function set(key, val) {
    memCache.set(key, val);
    pendingWrites.set(key, val);
    if (!flushTimer) {
      flushTimer = setTimeout(flushNow, 120);
    }
  }

  window.MintPyMobileStorage = {
    KEYS,
    ready: readyPromise,
    getSync,
    getAsync,
    set,
    flushNow
  };
})();
