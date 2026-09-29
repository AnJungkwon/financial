/* 화면 로직: 상태 로드 → 계산(Calc) → 렌더링. 모든 변경은 commit() 으로 저장 후 다시 그린다. */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
  const pf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
  const qf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 });
  const ACCOUNT_TYPES = ['일반', '연금저축', 'ISA', 'IRP', '기타'];
  const TAB_KEY = 'fp.tab';

  let state;
  let tab = 'all';
  let sort = { key: null, dir: -1 }; // key=null → 기본 정렬(평가금액 내림차순)
  let editingKey = null;             // 추가 매수 대상 "계좌|코드", null 이면 신규 등록
  let refreshing = false;

  // ── 유틸 ──
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const owner = id => state.owners.find(o => o.id === id) || { id, name: '?', color: '#999' };
  const num = v => (v === '' || v == null ? NaN : Number(v));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 사생활 보호 모드 등 */ } },
  };

  function tone(amount) {
    const r = Math.round(amount || 0);
    return r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
  }
  function pctText(rate) {
    if (rate == null) return '—';
    const r = Math.round(rate * 10000) / 100;
    return (r > 0 ? '+' : '') + r.toFixed(2) + '%';
  }
  // 색 + ▲▼ 기호를 함께 써서 색각 이상에도 구분되게 한다
  function pnlHtml(amount, rate, show = true) {
    if (!show) return '<span class="flat">—</span>';
    const t = tone(amount);
    const arrow = t === 'up' ? '▲' : t === 'down' ? '▼' : '';
    return `<div class="pnl ${t}"><span>${arrow} ${nf.format(Math.abs(Math.round(amount)))}</span><small>${pctText(rate)}</small></div>`;
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // 주식·ETF는 오늘 시세가 아니면 "지연", 펀드는 기준가가 일 1회라 4일 넘게 묵으면 "지연"
  function isStale(r) {
    if (!r.priced || !r.asOf) return false;
    const days = (Date.parse(kstDate()) - Date.parse(kstDate(new Date(r.asOf)))) / 86400e3;
    return r.secType === 'FUND' ? days > 4 : days >= 1;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function commit() {
    render();
    try { await DB.save(state); } catch (e) { console.error(e); toast('저장에 실패했습니다: ' + e.message); }
  }

  // ── 렌더링 ──
  const COLS = [
    { key: 'name', label: '종목', cls: 'c-name', val: r => r.name },
    { key: 'price', label: '현재가', cls: 'num', val: r => r.price ?? -Infinity },
    { key: 'dayRate', label: '일일손익', cls: 'num', val: r => r.dayRate ?? -Infinity },
    { key: 'rate', label: '누적손익', cls: 'num', val: r => r.rate ?? -Infinity },
    { key: 'value', label: '평가금액', cls: 'num', val: r => r.value },
    { key: 'qty', label: '수량', cls: 'num', val: r => r.qty },
    { key: 'avg', label: '평균단가', cls: 'num', val: r => r.avg },
    { key: 'accountType', label: '계좌', cls: '', val: r => r.accountType },
  ];

  function render() {
    const agg = Calc.aggregate(state, tab === 'all' ? null : tab);
    renderTabs();
    renderCards(agg.total);
    renderTable(agg);
    renderUpdated();
  }

  function renderTabs() {
    const items = [{ id: 'all', name: '통합', color: 'var(--text)' }, ...state.owners];
    $('#tabs').innerHTML = items.map(o =>
      `<button class="tab" role="tab" type="button" data-tab="${esc(o.id)}" aria-selected="${o.id === tab}" style="--c:${o.color}">` +
      (o.id === 'all' ? '' : '<span class="dot"></span>') + `${esc(o.name)}</button>`).join('');
  }

  function renderCards(t) {
    $('#cards').innerHTML = `
      <div class="card"><h2>총 평가금액</h2><div class="big">${nf.format(Math.round(t.value))}원</div>
        <div class="sub"><small>매입 ${nf.format(Math.round(t.cost))}<span class="count">원 · ${t.count}종목</span></small></div></div>
      <div class="card"><h2>일일손익</h2><div class="big ${tone(t.dayPnl)}">${signedWon(t.dayPnl, t.dayRate != null)}</div>
        <div class="sub ${tone(t.dayPnl)}">${pctText(t.dayRate)}</div></div>
      <div class="card"><h2>누적손익</h2><div class="big ${tone(t.pnl)}">${signedWon(t.pnl, t.cost > 0)}</div>
        <div class="sub ${tone(t.pnl)}">${pctText(t.cost ? t.rate : null)}</div></div>`;
    const n = $('#notice');
    n.hidden = !t.unpriced;
    n.textContent = t.unpriced ? `시세가 입력되지 않은 종목 ${t.unpriced}개는 매입금액으로 평가(손익 0)했습니다. 현재가 칸을 눌러 입력하세요.` : '';
  }
  function signedWon(v, show) {
    if (!show) return '—';
    const t = tone(v);
    return (t === 'up' ? '▲ ' : t === 'down' ? '▼ ' : '') + nf.format(Math.abs(Math.round(v))) + '원';
  }

  function sortRows(rows) {
    const col = COLS.find(c => c.key === sort.key);
    const val = col ? col.val : (r => r.value);
    const dir = col ? sort.dir : -1;
    return rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y;
      return c * dir;
    });
  }

  function rowHtml(r, showChip) {
    const o = owner(r.ownerId);
    const unitNote = r.unit !== 1 ? `<small>${qf.format(r.unit)}좌당</small>` : '';
    return `<tr class="item" data-key="${esc(r.key)}" style="--owner:${o.color}">
      <td class="c-name">${showChip ? `<span class="chip">${esc(o.name)}</span>` : ''}<b title="${esc(r.name)}">${esc(r.name)}</b><small>${esc(r.code)}</small></td>
      <td class="num c-price" data-code="${esc(r.code)}" title="눌러서 시세 입력">${r.priced ? pf.format(r.price) : '<span class="missing">시세 입력</span>'}${isStale(r) ? '<em class="stale">지연</em>' : ''}${r.priced ? unitNote : ''}</td>
      <td class="num">${pnlHtml(r.dayPnl, r.dayRate, r.dayRate != null)}</td>
      <td class="num">${pnlHtml(r.pnl, r.rate, r.priced)}</td>
      <td class="num">${nf.format(Math.round(r.value))}<small>매입 ${nf.format(Math.round(r.cost))}</small></td>
      <td class="num">${qf.format(r.qty)}</td>
      <td class="num">${pf.format(Math.round(r.avg * 100) / 100)}</td>
      <td>${esc(r.accountType)}${r.broker ? `<small>${esc(r.broker)}</small>` : ''}</td>
    </tr>`;
  }

  function sumHtml(label, s, cls, color) {
    return `<tr class="${cls}"${color ? ` style="--owner:${color}"` : ''}>
      <td class="c-name"><b>${esc(label)}</b><small>${s.count}종목</small></td>
      <td></td>
      <td class="num">${pnlHtml(s.dayPnl, s.dayRate, s.dayRate != null)}</td>
      <td class="num">${pnlHtml(s.pnl, s.rate, s.cost > 0)}</td>
      <td class="num">${nf.format(Math.round(s.value))}<small>매입 ${nf.format(Math.round(s.cost))}</small></td>
      <td></td><td></td><td></td>
    </tr>`;
  }

  function renderTable(agg) {
    const empty = agg.rows.length === 0;
    $('#tableWrap').hidden = empty;
    $('#empty').hidden = !empty;
    $('#btnAdd').hidden = empty;
    if (empty) {
      $('#empty p').textContent = state.transactions.length
        ? `${tab === 'all' ? '' : owner(tab).name + '님의 '}등록된 자산이 없습니다.`
        : '등록된 자산이 없습니다.';
      return;
    }

    $('#grid thead').innerHTML = '<tr>' + COLS.map(c => {
      const aria = sort.key === c.key ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : '';
      return `<th class="${c.cls}" data-sort="${c.key}"${aria} scope="col">${c.label}</th>`;
    }).join('') + '</tr>';

    let body = '';
    if (tab === 'all') {
      // 통합: 주체별로 묶고 각 묶음 끝에 소계 행
      for (const o of state.owners) {
        const own = agg.rows.filter(r => r.ownerId === o.id);
        if (!own.length) continue;
        body += sortRows(own).map(r => rowHtml(r, true)).join('');
        body += sumHtml(`${o.name} 소계`, agg.byOwner[o.id], 'subtotal', o.color);
      }
    } else {
      body = sortRows(agg.rows).map(r => rowHtml(r, false)).join('');
    }
    $('#grid tbody').innerHTML = body;
    $('#grid tfoot').innerHTML = sumHtml(tab === 'all' ? '통합 합계' : `${owner(tab).name} 합계`, agg.total, 'total');
  }

  function renderUpdated() {
    const last = state.settings.lastRefresh;
    const src = Prices.sources[state.settings.source] || Prices.sources.manual;
    $('#updated').textContent = last ? `마지막 갱신 ${fmtTime(last)}${src.auto ? '' : ' (수동)'}` : '시세 미입력';
  }

  // ── 종목 등록 / 추가 매수 ──
  function holdingTx(key) {
    return state.transactions.filter(t => t.accountId + '|' + t.code === key)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  function openTx(key) {
    editingKey = key || null;
    const f = id => $('#' + id);
    f('fOwner').innerHTML = state.owners.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    f('fAcct').innerHTML = ACCOUNT_TYPES.map(t => `<option>${t}</option>`).join('');
    $('#codeList').innerHTML = Object.values(state.securities).map(s => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
    f('fQty').value = '';
    f('fPrice').value = '';
    f('fDate').value = kstDate();
    f('txError').textContent = '';

    const lockIds = ['fOwner', 'fAcct', 'fBroker', 'fCode', 'fName', 'fType'];
    if (editingKey) {
      const [accountId, code] = editingKey.split('|');
      const acc = state.accounts.find(a => a.id === accountId);
      const sec = state.securities[code];
      f('fOwner').value = acc.ownerId;
      f('fAcct').value = acc.type;
      f('fBroker').value = acc.broker || '';
      f('fCode').value = code;
      f('fName').value = sec.name;
      f('fType').value = sec.type;
      lockIds.forEach(id => { f(id).disabled = true; });
      $('#txTitle').textContent = `추가 매수 — ${sec.name}`;
      f('txSubmit').textContent = '추가 매수';
      renderTxHistory();
    } else {
      f('fOwner').value = tab === 'all' ? state.owners[0].id : tab;
      f('fAcct').value = '일반';
      f('fBroker').value = '';
      f('fCode').value = '';
      f('fName').value = '';
      f('fType').value = 'STOCK';
      lockIds.forEach(id => { f(id).disabled = false; });
      $('#txTitle').textContent = '종목 등록';
      f('txSubmit').textContent = '등록';
      $('#txHistory').hidden = true;
    }
    updateTxHint();
    $('#dlgTx').showModal();
    (editingKey ? f('fQty') : f('fCode')).focus();
  }

  function renderTxHistory() {
    const list = holdingTx(editingKey);
    $('#txHistory').hidden = !list.length;
    $('#txCount').textContent = `(${list.length}건)`;
    $('#txList').innerHTML = list.map(t =>
      `<li><span>${esc(t.date || '날짜 없음')} · ${qf.format(t.qty)} × ${pf.format(t.price)}</span>
        <button class="btn danger small" type="button" data-del-tx="${esc(t.id)}">삭제</button></li>`).join('');
  }

  function updateTxHint() {
    const type = $('#fType').value;
    const fund = type === 'FUND';
    $('#qtyUnit').textContent = fund ? '(좌)' : '(주)';
    $('#priceUnit').textContent = fund ? '(1,000좌당 기준가)' : '(원)';
    const q = num($('#fQty').value), p = num($('#fPrice').value);
    let hint = fund ? '펀드는 매수 시점 기준가(1,000좌당 가격)를 입력하세요. 매입금액 = 좌수 × 기준가 ÷ 1,000' : '';
    if (editingKey && q > 0 && p > 0) {
      const h = Calc.buildHoldings(state).find(x => x.accountId + '|' + x.code === editingKey);
      if (h) {
        const newQty = h.qty + q;
        const newAvg = (h.costRaw + q * p) / newQty;
        hint = `추가 후 보유 ${qf.format(newQty)} · 평균단가 ${pf.format(Math.round(h.costRaw / h.qty * 100) / 100)} → ${pf.format(Math.round(newAvg * 100) / 100)}`;
      }
    }
    $('#txHint').textContent = hint;
  }

  function onCodeInput() {
    if (editingKey) return;
    const code = $('#fCode').value.trim().toUpperCase();
    const sec = state.securities[code];
    if (sec) {
      $('#fName').value = sec.name;
      $('#fType').value = sec.type;
      updateTxHint();
    }
  }

  function findOrCreateAccount(ownerId, type, broker) {
    let acc = state.accounts.find(a => a.ownerId === ownerId && a.type === type && (a.broker || '') === broker);
    if (!acc) {
      acc = { id: uid(), ownerId, type, broker };
      state.accounts.push(acc);
    }
    return acc;
  }

  function submitTx(e) {
    e.preventDefault();
    const err = msg => { $('#txError').textContent = msg; };
    const code = $('#fCode').value.trim().toUpperCase();
    const name = $('#fName').value.trim();
    const type = $('#fType').value;
    const qty = num($('#fQty').value);
    const price = num($('#fPrice').value);
    if (!code) return err('종목코드를 입력하세요.');
    if (!name) return err('종목명을 입력하세요.');
    if (!(qty > 0)) return err('수량은 0보다 커야 합니다.');
    if (!(price > 0)) return err('매수단가는 0보다 커야 합니다.');

    let accountId;
    if (editingKey) {
      accountId = editingKey.split('|')[0];
    } else {
      const existing = state.securities[code];
      if (existing && existing.type !== type) {
        return err(`${code}는 이미 "${existing.name}"(${{ STOCK: '주식', ETF: 'ETF', FUND: '펀드' }[existing.type]})로 등록되어 있습니다. 유형을 맞춰 주세요.`);
      }
      state.securities[code] = existing
        ? { ...existing, name }
        : { code, name, type, market: 'KRX', currency: 'KRW', unit: type === 'FUND' ? 1000 : 1 };
      accountId = findOrCreateAccount($('#fOwner').value, $('#fAcct').value, $('#fBroker').value.trim()).id;
    }

    state.transactions.push({ id: uid(), accountId, code, date: $('#fDate').value || kstDate(), qty, price, side: 'BUY' });
    const key = accountId + '|' + code;
    const h = Calc.buildHoldings(state).find(x => x.accountId + '|' + x.code === key);
    $('#dlgTx').close();
    commit();
    toast(`${name} 반영 · 보유 ${qf.format(h.qty)} · 평균단가 ${pf.format(Math.round(h.costRaw / h.qty * 100) / 100)}`);
  }

  function deleteTx(id) {
    const t = state.transactions.find(x => x.id === id);
    if (!t || !confirm(`${t.date} ${qf.format(t.qty)} × ${pf.format(t.price)} 거래를 삭제할까요?`)) return;
    state.transactions = state.transactions.filter(x => x.id !== id);
    commit();
    if (holdingTx(editingKey).length) { renderTxHistory(); updateTxHint(); } else $('#dlgTx').close();
  }

  function deleteHolding() {
    const list = holdingTx(editingKey);
    const name = state.securities[editingKey.split('|')[1]].name;
    if (!confirm(`${name}의 거래 ${list.length}건을 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
    const ids = new Set(list.map(t => t.id));
    state.transactions = state.transactions.filter(t => !ids.has(t.id));
    $('#dlgTx').close();
    commit();
    toast(`${name} 삭제됨`);
  }

  // ── 시세 ──
  let priceCode = null;
  function openPrice(code) {
    priceCode = code;
    const sec = state.securities[code];
    const q = state.prices[code] || {};
    $('#priceTarget').textContent = `${sec ? sec.name : ''} (${code})`;
    $('#pPrice').value = q.price ?? '';
    $('#pPrev').value = q.prevClose ?? '';
    $('#priceHint').textContent = (sec && sec.type === 'FUND' ? '펀드는 1,000좌당 기준가를 입력하세요. ' : '') +
      (q.asOf ? `최근 입력: ${fmtTime(q.asOf)}` : '');
    $('#priceError').textContent = '';
    $('#dlgPrice').showModal();
    $('#pPrice').select();
  }

  function submitPrice(e) {
    e.preventDefault();
    const price = num($('#pPrice').value);
    const prev = $('#pPrev').value === '' ? null : num($('#pPrev').value);
    if (!(price > 0)) { $('#priceError').textContent = '현재가는 0보다 커야 합니다.'; return; }
    if (prev !== null && !(prev > 0)) { $('#priceError').textContent = '전일종가는 비우거나 0보다 큰 값이어야 합니다.'; return; }
    const now = new Date().toISOString();
    state.prices[priceCode] = { price, prevClose: prev, asOf: now, source: 'manual' };
    state.settings.lastRefresh = now;
    $('#dlgPrice').close();
    commit();
  }

  function heldCodes() {
    return [...new Set(Calc.buildHoldings(state).map(h => h.code))];
  }

  function openBulk() {
    $('#bulkText').value = heldCodes().map(code => {
      const q = state.prices[code] || {};
      const sec = state.securities[code] || {};
      return `${code} ${q.price ?? ''} ${q.prevClose ?? ''}`.replace(/\s+$/, '') + `   # ${sec.name || ''}${sec.type === 'FUND' ? ' (1,000좌당)' : ''}`;
    }).join('\n');
    $('#bulkError').textContent = '';
    $('#dlgBulk').showModal();
  }

  function submitBulk(e) {
    e.preventDefault();
    const { prices, errors } = Prices.parseBulk($('#bulkText').value);
    if (errors.length) { $('#bulkError').textContent = '형식을 확인하세요 — ' + errors.join(', '); return; }
    const n = Object.keys(prices).length;
    if (!n) { $('#bulkError').textContent = '입력된 시세가 없습니다. 코드 뒤에 현재가를 입력하세요.'; return; }
    Object.assign(state.prices, prices);
    state.settings.lastRefresh = new Date().toISOString();
    $('#dlgBulk').close();
    commit();
    toast(`${n}개 종목 시세 반영`);
  }

  async function refresh(silent) {
    const src = Prices.sources[state.settings.source] || Prices.sources.manual;
    if (!src.auto) { if (!silent) openBulk(); return; }
    if (refreshing) return;
    refreshing = true;
    $('#btnRefresh').disabled = true;
    try {
      // 외부로는 종목 코드만 보낸다. 펀드는 장중 시세가 없어 제외(기준가 수동 입력).
      const codes = heldCodes().filter(c => (state.securities[c] || {}).type !== 'FUND');
      const got = await src.fetch(codes);
      Object.assign(state.prices, got);
      state.settings.lastRefresh = new Date().toISOString();
      commit();
      const miss = codes.length - Object.keys(got).length;
      if (!silent) toast(`시세 갱신 완료${miss > 0 ? ` · ${miss}개 실패` : ''}`);
    } catch (e) {
      console.warn(e);
      if (!silent) toast('시세 갱신 실패: ' + e.message);
    } finally {
      refreshing = false;
      $('#btnRefresh').disabled = false;
    }
  }

  // ── 메뉴 · 백업 ──
  function openMenu() {
    const native = !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp);
    $('#mSource').innerHTML = Object.values(Prices.sources).map(s =>
      `<option value="${s.id}"${s.id === 'naver' && !native ? ' disabled' : ''}>${esc(s.label)}</option>`).join('');
    $('#mSource').value = state.settings.source;
    $('#mAuto').checked = state.settings.autoRefresh;
    $('#mSourceHint').textContent = native ? '' :
      '브라우저(PWA)에서는 보안 정책(CORS) 때문에 무료 시세 API를 직접 부를 수 없어 수동 입력만 지원합니다. "시세 갱신" 버튼으로 여러 종목을 한 번에 입력할 수 있습니다.';
    $('#dlgMenu').showModal();
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    download(`가족자산-백업-${kstDate().replace(/-/g, '')}.json`, JSON.stringify(state, null, 2), 'application/json');
    toast('백업 파일을 저장했습니다');
  }

  function exportCsv() {
    const agg = Calc.aggregate(state, tab === 'all' ? null : tab);
    const head = ['주체', '종목명', '코드', '계좌유형', '증권사', '수량', '평균단가', '현재가', '전일종가', '매입금액', '평가금액', '일일손익', '일일수익률(%)', '누적손익', '누적수익률(%)'];
    const pct = v => (v == null ? '' : (Math.round(v * 10000) / 100).toFixed(2));
    const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = sortRows(agg.rows).map(r => [owner(r.ownerId).name, r.name, r.code, r.accountType, r.broker, r.qty,
      Math.round(r.avg * 100) / 100, r.price ?? '', r.prevClose ?? '', Math.round(r.cost), Math.round(r.value),
      r.dayRate == null ? '' : Math.round(r.dayPnl), pct(r.dayRate), Math.round(r.pnl), pct(r.rate)]);
    const csv = '﻿' + [head, ...lines].map(l => l.map(cell).join(',')).join('\r\n'); // BOM: 엑셀 한글 깨짐 방지
    download(`가족자산-${tab === 'all' ? '통합' : owner(tab).name}-${kstDate().replace(/-/g, '')}.csv`, csv, 'text/csv');
  }

  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.transactions) || !Array.isArray(data.accounts) || typeof data.securities !== 'object') {
        throw new Error('이 앱의 백업 파일이 아닙니다.');
      }
      if (!confirm(`백업(거래 ${data.transactions.length}건)으로 현재 데이터(거래 ${state.transactions.length}건)를 덮어쓸까요?`)) return;
      state = DB.migrate(data);
      $('#dlgMenu').close();
      await commit();
      toast('백업을 불러왔습니다');
    } catch (e) {
      alert('불러오기 실패: ' + e.message);
    }
  }

  // ── 이벤트 연결 ──
  function bind() {
    $('#tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      tab = b.dataset.tab;
      store.set(TAB_KEY, tab);
      render();
    });
    $('#grid thead').addEventListener('click', e => {
      const th = e.target.closest('[data-sort]');
      if (!th) return;
      const k = th.dataset.sort;
      if (sort.key === k) {
        if (sort.dir === -1) sort.dir = 1; else sort = { key: null, dir: -1 }; // 내림 → 오름 → 기본
      } else {
        sort = { key: k, dir: k === 'name' || k === 'accountType' ? 1 : -1 };
      }
      render();
    });
    $('#grid tbody').addEventListener('click', e => {
      const priceCell = e.target.closest('.c-price');
      if (priceCell) return openPrice(priceCell.dataset.code);
      const tr = e.target.closest('tr.item');
      if (tr) openTx(tr.dataset.key);
    });
    document.querySelectorAll('[data-action="add"]').forEach(b => b.addEventListener('click', () => openTx(null)));
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    // 바깥(backdrop) 클릭으로 닫기
    document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

    $('#formTx').addEventListener('submit', submitTx);
    ['fQty', 'fPrice'].forEach(id => $('#' + id).addEventListener('input', updateTxHint));
    $('#fType').addEventListener('change', updateTxHint);
    $('#fCode').addEventListener('input', onCodeInput);
    $('#txList').addEventListener('click', e => { const b = e.target.closest('[data-del-tx]'); if (b) deleteTx(b.dataset.delTx); });
    $('#btnDelHolding').addEventListener('click', deleteHolding);

    $('#formPrice').addEventListener('submit', submitPrice);
    $('#formBulk').addEventListener('submit', submitBulk);
    $('#btnRefresh').addEventListener('click', () => refresh(false));

    $('#btnMenu').addEventListener('click', openMenu);
    $('#mSource').addEventListener('change', e => { state.settings.source = e.target.value; commit(); });
    $('#mAuto').addEventListener('change', e => { state.settings.autoRefresh = e.target.checked; commit(); });
    $('#mExport').addEventListener('click', exportJson);
    $('#mCsv').addEventListener('click', exportCsv);
    $('#mImport').addEventListener('click', () => $('#mFile').click());
    $('#mFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importJson(f); });

    // 장중 자동 갱신 (자동 소스일 때만)
    setInterval(() => {
      const src = Prices.sources[state.settings.source];
      if (src && src.auto && state.settings.autoRefresh && Prices.isMarketOpen() && !document.hidden) refresh(true);
    }, 60000);
  }

  async function init() {
    state = await DB.load();
    DB.requestPersist();
    const saved = store.get(TAB_KEY);
    if (saved && (saved === 'all' || state.owners.some(o => o.id === saved))) tab = saved;
    bind();
    render();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 등록 실패', e));
    }
  }

  init();
})();
