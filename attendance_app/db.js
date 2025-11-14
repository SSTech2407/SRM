// tiny IndexedDB wrapper for attendance queue
(function () {
    const DB_NAME = 'srm_attendance';
    const STORE = 'attendanceQueue';
    let dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((res, rej) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'timestamp' });
            };
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        });
        return dbPromise;
    }

    async function dbAdd(obj) {
        const db = await openDB();
        obj.timestamp = obj.timestamp || new Date().toISOString();
        return new Promise((res, rej) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).add(obj);
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }

    async function dbGetAll() {
        const db = await openDB();
        return new Promise((res, rej) => {
            const r = db.transaction(STORE).objectStore(STORE).getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }

    async function dbClear() {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    }

    // export to window
    window.srmDB = { add: dbAdd, getAll: dbGetAll, clear: dbClear };
})();
