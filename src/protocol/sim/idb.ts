// Minimal IndexedDB key-value store for the visitor's demo state (one record per key).
// Falls back to memory when IndexedDB is unavailable (some private-browsing modes); the app says so.

const DB = 'rixor-browser-evm'
const STORE = 'kv'
let dbPromise: Promise<IDBDatabase> | null = null
const memory = new Map<string, unknown>()
export let persistent = typeof indexedDB !== 'undefined'

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    t.oncomplete = () => resolve(req.result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  if (!persistent) return memory.get(key) as T | undefined
  try {
    return await tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>)
  } catch {
    persistent = false
    return memory.get(key) as T | undefined
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  if (!persistent) { memory.set(key, value); return }
  try {
    await tx('readwrite', (s) => s.put(value, key))
  } catch {
    persistent = false
    memory.set(key, value)
  }
}

export async function idbDelete(key: string): Promise<void> {
  memory.delete(key)
  if (!persistent) return
  try { await tx('readwrite', (s) => s.delete(key)) } catch { /* ignore */ }
}
