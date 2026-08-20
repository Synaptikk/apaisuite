// modules/sparkrisk/models/index.js
//
// IndexedDB data layer for SparkRisk
// Mirrors the SQLite schema from the standalone tool

const DB_NAME = "sparkrisk";
const DB_VERSION = 3;  // Increment for driver_key migration

// IndexedDB promise wrapper
class SparkRiskDB {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

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

        // Session reviews store
        if (!db.objectStoreNames.contains("session_reviews")) {
          const reviewsStore = db.createObjectStore("session_reviews", { keyPath: "id" });
          reviewsStore.createIndex("session_id", "session_id", { unique: true });
          reviewsStore.createIndex("status", "status", { unique: false });
        }

        // Items cache store (for fetched items)
        if (!db.objectStoreNames.contains("items")) {
          const itemsStore = db.createObjectStore("items", { keyPath: ["order_id", "item_id"] });
          itemsStore.createIndex("order_id", "order_id", { unique: false });
        }
      };
    });
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
