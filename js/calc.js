/* 손익 계산 로직 (순수 함수, DOM/저장소 의존 없음)
 *
 * 단위 규칙
 * - 금액은 원(KRW) 실수로 계산하고, 표시 단계에서만 반올림한다.
 * - security.unit: 가격이 몇 주(좌)당 가격인지. 주식·ETF = 1, 펀드 기준가 = 1000(1,000좌당).
 *   금액 = 수량 × 가격 ÷ unit
 * - 통합·소계 수익률은 행 수익률을 평균 내지 않고 금액을 합산한 뒤 재계산한다.
 */
(function (g) {
  'use strict';

  // 거래 내역 → (계좌, 종목)별 보유 현황. 보유 현황은 저장하지 않고 항상 여기서 계산한다.
  function buildHoldings(state) {
    const map = new Map();
    for (const t of state.transactions) {
      const key = t.accountId + '|' + t.code;
      let h = map.get(key);
      if (!h) {
        h = { accountId: t.accountId, code: t.code, qty: 0, costRaw: 0, txCount: 0 };
        map.set(key, h);
      }
      const sign = t.side === 'SELL' ? -1 : 1; // v1은 BUY만 사용
      h.qty += sign * t.qty;
      h.costRaw += sign * t.qty * t.price;
      h.txCount += 1;
    }
    return [...map.values()].filter(h => h.qty > 0);
  }

  function evaluate(state, h) {
    const acc = state.accounts.find(a => a.id === h.accountId);
    const sec = state.securities[h.code] || { code: h.code, name: h.code, unit: 1, type: 'STOCK' };
    const unit = sec.unit || 1;
    const q = state.prices[h.code];
    const hasPrice = !!(q && q.price > 0);
    const hasPrev = hasPrice && q.prevClose > 0;

    const avg = h.costRaw / h.qty;
    const cost = h.costRaw / unit;
    // 시세가 없으면 평가금액 = 매입금액(손익 0)으로 두고 priced=false 로 표시한다.
    const value = hasPrice ? h.qty * q.price / unit : cost;
    const prevValue = hasPrev ? h.qty * q.prevClose / unit : 0;
    const dayPnl = hasPrev ? value - prevValue : 0;

    return {
      key: h.accountId + '|' + h.code,
      ownerId: acc ? acc.ownerId : null,
      accountId: h.accountId,
      accountType: acc ? acc.type : '',
      broker: acc ? acc.broker : '',
      code: h.code,
      name: sec.name,
      secType: sec.type,
      unit,
      qty: h.qty,
      avg,
      price: hasPrice ? q.price : null,
      prevClose: hasPrev ? q.prevClose : null,
      asOf: q ? q.asOf : null,
      cost,
      value,
      prevValue,
      dayPnl,
      dayRate: hasPrev ? dayPnl / prevValue : null,
      pnl: value - cost,
      rate: cost ? (value - cost) / cost : null,
      priced: hasPrice,
    };
  }

  function sum(rows) {
    const s = { cost: 0, value: 0, prevValue: 0, dayPnl: 0, count: rows.length, unpriced: 0 };
    for (const r of rows) {
      s.cost += r.cost;
      s.value += r.value;
      s.prevValue += r.prevValue;
      s.dayPnl += r.dayPnl;
      if (!r.priced) s.unpriced += 1;
    }
    s.pnl = s.value - s.cost;
    s.rate = s.cost ? s.pnl / s.cost : null;
    s.dayRate = s.prevValue ? s.dayPnl / s.prevValue : null;
    return s;
  }

  // ownerId 가 null 이면 통합
  function aggregate(state, ownerId) {
    let rows = buildHoldings(state).map(h => evaluate(state, h));
    if (ownerId) rows = rows.filter(r => r.ownerId === ownerId);
    const byOwner = {};
    for (const o of state.owners) {
      const own = rows.filter(r => r.ownerId === o.id);
      if (own.length) byOwner[o.id] = sum(own);
    }
    return { rows, byOwner, total: sum(rows) };
  }

  g.Calc = { buildHoldings, evaluate, sum, aggregate };
})(typeof window !== 'undefined' ? window : globalThis);
