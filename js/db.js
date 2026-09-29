/* 기기 내 저장소 (IndexedDB). 데이터는 이 기기 브라우저 안에만 저장되며 외부로 전송하지 않는다.
 * 데이터 규모(종목 수십 개, 거래 수백 건)가 작아 전체 상태를 문서 하나로 저장한다.
 */
(function (g) {
  'use strict';

  const DB_NAME = 'family-portfolio';
  const STORE = 'kv';
  const KEY = 'state';
  const SCHEMA = 1;

  function defaultState() {
    return {
      schema: SCHEMA,
      // 주체 색은 손익색(빨강·파랑)과 겹치지 않게 초록/주황/보라 계열
      owners: [
        { id: 'me', name: '나', color: '#2e9d5b' },
        { id: 'wife', name: '부인', color: '#e08a1e' },
        { id: 'mom', name: '어머니', color: '#8a5cd1' },
      ],
      accounts: [],     // { id, ownerId, type, broker }
      securities: {},   // code → { code, name, type: STOCK|ETF|FUND, market, currency, unit }
      transactions: [], // { id, accountId, code, date, qty, price, side: 'BUY' }
      prices: {},       // code → { price, prevClose, asOf, source }
      settings: { source: 'manual', autoRefresh: true, lastRefresh: null },
    };
  }

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function load() {
    try {
      const db = await open();
      const data = await new Promise((resolve, reject) => {
        const r = db.transaction(STORE).objectStore(STORE).get(KEY);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return data ? migrate(data) : defaultState();
    } catch (e) {
      console.error('저장소 열기 실패', e);
      return defaultState();
    }
  }

  async function save(state) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  // 누락된 필드를 기본값으로 채운다 (가져오기·스키마 변경 대비)
  function migrate(data) {
    const d = defaultState();
    return {
      ...d,
      ...data,
      settings: { ...d.settings, ...(data.settings || {}) },
      owners: data.owners && data.owners.length ? data.owners : d.owners,
      schema: SCHEMA,
    };
  }

  // 브라우저가 저장 공간 정리 시 데이터를 지우지 않도록 영구 저장 요청
  function requestPersist() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  g.DB = { load, save, migrate, defaultState, requestPersist };
})(window);
