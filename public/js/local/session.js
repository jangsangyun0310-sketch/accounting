// 성당별 모드의 "열린 장부" 하나를 관리한다.
// 1단계: 이 브라우저(IndexedDB)에 그대로 저장. 2단계에서 암호화 보관함(서버)으로 바뀐다.
import { PARISH_ID } from '../base.js';
import { openEngine } from './engine.js';

const DB_NAME = 'bondang-salim';
const STORE = 'ledgers';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let enginePromise = null;

/** 엔진을 한 번만 열어 돌려준다 */
export function ready() {
  enginePromise ??= (async () => {
    const bytes = await idbGet(PARISH_ID);
    return openEngine(bytes, { onChange: (next) => idbPut(PARISH_ID, next) });
  })();
  return enginePromise;
}
