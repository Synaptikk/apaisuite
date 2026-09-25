// modules/sparkrisk/models/index.js
//
// IndexedDB data layer for SparkRisk
// Mirrors the SQLite schema from the standalone tool

const DB_NAME = "sparkrisk";
const DB_VERSION = 4;  // Atomic rebuilds preserve an original-data backup.

// IndexedDB promise wrapper
class SparkRiskDB {
  constructor() {
    this.db = null;
    this.opening = null;
  }

  async open() {
    if (this.db) return this.db;
    // Memoised: the shell page and the SW can both hit this concurrently, and
    // two simultaneous indexedDB.open() calls race their upgrade transactions.
    if (this.opening) return this.opening;

    this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      // Another context still holds an older version open. Surface it instead
      // of hanging forever on a promise that never settles.
      request.onblocked = () => reject(new Error(
        "SparkRisk database upgrade is blocked by another open tab. Close other APAI Suite tabs and reload."
      ));
      request.onsuccess = () => {
        this.db = request.result;
        // A newer version elsewhere must be able to upgrade: drop our handle
        // rather than becoming the thing that blocks it.
        this.db.onversionchange = () => {
          try { this.db.close(); } catch (_) {}
          this.db = null;
          this.opening = null;
        };
        this.db.onclose = () => { this.db = null; this.opening = null; };
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;
        if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id' });

        // Sessions store
        if (!db.objectStoreNames.contains("sessions")) {
          const sessionsStore = db.createObjectStore("sessions", { keyPath: "session_id" });
          sessionsStore.createIndex("driver_id", "driver_id", { unique: false });
          sessionsStore.createIndex("driver_key", "driver_key", { unique: false });  // NEW
          sessionsStore.createIndex("extraction_date", "extraction_date", { unique: false });
          sessionsStore.createIndex("priority_score", "priority_score", { unique: false });
          sessionsStore.createIndex("session_start", "session_start", { unique: false });
        } else if (oldVersion < 3) {
          // Migration: add driver_key index to existing store
          const tx = event.target.transaction;
          const sessionsStore = tx.objectStore("sessions");
          if (!sessionsStore.indexNames.contains("driver_key")) {
            sessionsStore.createIndex("driver_key", "driver_key", { unique: false });
          }
        }

        // Orders store
        if (!db.objectStoreNames.contains("orders")) {
          const ordersStore = db.createObjectStore("orders", { keyPath: "id", autoIncrement: true });
          ordersStore.createIndex("order_id", "order_id", { unique: false });
          ordersStore.createIndex("driver_id", "driver_id", { unique: false });
          ordersStore.createIndex("trip_id", "trip_id", { unique: false });
          ordersStore.createIndex("extraction_date", "extraction_date", { unique: false });
        }

        // Session reviews store.
        //
        // session_id is NOT unique. Archived legacy reviews (see lib/rebuild.js)
        // are retained alongside live ones, and a unique index would abort the
        // whole rebuild transaction with a ConstraintError the moment two rows
        // referenced the same session.
        if (!db.objectStoreNames.contains("session_reviews")) {
          const reviewsStore = db.createObjectStore("session_reviews", { keyPath: "id" });
          reviewsStore.createIndex("session_id", "session_id", { unique: false });
          reviewsStore.createIndex("status", "status", { unique: false });
        } else if (oldVersion < 4) {
          const reviewsStore = event.target.transaction.objectStore("session_reviews");
          if (reviewsStore.indexNames.contains("session_id")) reviewsStore.deleteIndex("session_id");
          reviewsStore.createIndex("session_id", "session_id", { unique: false });
        }

        // Items cache store (for fetched items)
        if (!db.objectStoreNames.contains("items")) {
          const itemsStore = db.createObjectStore("items", { keyPath: ["order_id", "item_id"] });
          itemsStore.createIndex("order_id", "order_id", { unique: false });
        }
      };
    });
    // A failed open must not be cached, or every later call replays the error.
    this.opening.catch(() => { this.opening = null; });
    return this.opening;
  }

  async getAll(storeName, indexName = null, query = null) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readonly");
    const store = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      const request = query ? store.getAll(query) : store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Atomic swap of the whole analysis: orders, sessions and reviews are
  // cleared and rewritten inside ONE transaction, so a failure part-way
  // through leaves the previous analysis intact rather than a half-rebuild.
  // The first call also snapshots the pre-migration contents into `backups`
  // under `before-foundation-v3`, which is never overwritten afterwards.
  async replaceAnalysis({ orders, sessions, reviews }) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['orders', 'sessions', 'session_reviews', 'backups'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Spark Risk rebuild aborted'));
      tx.onerror = () => {}; // Abort is the final failure signal.
      const backup = tx.objectStore('backups');
      const request = backup.get('before-foundation-v3');
      request.onsuccess = () => {
        const write = () => {
          backup.put({ id: 'foundation-v3-ready', at: Date.now() });
          for (const [name, rows] of [['orders', orders], ['sessions', sessions], ['session_reviews', reviews]]) {
            const store = tx.objectStore(name);
            store.clear();
            for (const row of rows) store.put(row);
          }
        };
        if (request.result) { write(); return; }
        const original = { id: 'before-foundation-v3', at: Date.now() };
        let remaining = 3;
        for (const name of ['orders', 'sessions', 'session_reviews']) {
          const read = tx.objectStore(name).getAll();
          read.onsuccess = () => {
            original[name] = read.result;
            if (--remaining === 0) { backup.put(original); write(); }
          };
        }
      };
    });
  }

  async get(storeName, key) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async put(storeName, data) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      const request = store.put(data);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async putMany(storeName, dataArray) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    
    const promises = dataArray.map(data => {
      return new Promise((resolve, reject) => {
        const request = store.put(data);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
    
    return Promise.all(promises);
  }

  async delete(storeName, key) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async clear(storeName) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async query(storeName, filterFn) {
    const all = await this.getAll(storeName);
    return all.filter(filterFn);
  }

  async count(storeName, indexName = null, query = null) {
    const db = await this.open();
    const tx = db.transaction(storeName, "readonly");
    const store = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
    
    return new Promise((resolve, reject) => {
      const request = query ? store.count(query) : store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

// Singleton instance
const db = new SparkRiskDB();

export { db, SparkRiskDB };
