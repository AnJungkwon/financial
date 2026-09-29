/* 시세 소스 어댑터
 *
 * 모든 소스는 같은 인터페이스를 따른다:
 *   fetch(codes: string[]) → Promise<{ [code]: { price, prevClose, asOf, source } }>
 * 외부로는 종목 코드만 보낸다. 수량·금액·주체 정보는 절대 인자로 받지 않는다.
 *
 * 브라우저(PWA)에서는 네이버·야후 등 무료 시세 API가 CORS로 차단된다(2026-09 확인).
 * 그래서 v1 기본값은 수동 입력이고, 앱을 Capacitor(Android)·Tauri(Windows)로 감싸
 * 네이티브 HTTP를 쓸 수 있게 되면 NaverSource를 켜면 된다.
 */
(function (g) {
  'use strict';

  const ManualSource = {
    id: 'manual',
    label: '수동 입력',
    auto: false,
    async fetch() { return {}; },
  };

  // 네이버 금융 비공식 API (약관 확인 필요). 네이티브 HTTP 환경에서만 동작한다.
  const NaverSource = {
    id: 'naver',
    label: '네이버 금융 (네이티브 앱 전용)',
    auto: true,
    async fetch(codes) {
      const http = g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.CapacitorHttp;
      if (!http) throw new Error('브라우저에서는 CORS 제한으로 네이버 시세를 가져올 수 없습니다.');
      const out = {};
      for (let i = 0; i < codes.length; i += 20) {
        const chunk = codes.slice(i, i + 20).join(',');
        const res = await http.get({ url: 'https://polling.finance.naver.com/api/realtime/domestic/stock/' + chunk });
        for (const d of (res.data && res.data.datas) || []) {
          const num = s => Number(String(s).replace(/,/g, ''));
          const price = num(d.closePriceRaw ?? d.closePrice);
          const diff = num(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice);
          out[d.itemCode] = { price, prevClose: price - diff, asOf: new Date().toISOString(), source: 'naver' };
        }
      }
      return out;
    },
  };

  const sources = { manual: ManualSource, naver: NaverSource };

  // 붙여넣기 형식: 한 줄에 "코드 현재가 전일종가".
  // 공백·탭이 있으면 그것으로 나누고 숫자의 천단위 쉼표(61,000)는 허용한다(엑셀·증권사 앱 복사 대비).
  // 공백이 없으면 쉼표로 나눈다(CSV: 005930,61000,60000).
  // 전일종가는 생략 가능하며, 생략하면 그 종목의 일일손익은 표시하지 않는다.
  function parseBulk(text) {
    const out = {};
    const errors = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.split('#')[0].trim(); // "#" 뒤는 메모(종목명 등)
      if (!t) return;
      const parts = (/\s/.test(t) ? t.split(/\s+/) : t.split(/[,;]/)).filter(Boolean);
      const [code, p, pc] = parts;
      const toNum = s => Number(String(s).replace(/,/g, ''));
      const price = toNum(p);
      const prevClose = pc === undefined ? null : toNum(pc);
      if (!code || !(price > 0) || (prevClose !== null && !(prevClose > 0))) {
        errors.push(`${i + 1}행: "${t}"`);
        return;
      }
      out[code.toUpperCase()] = { price, prevClose, asOf: new Date().toISOString(), source: 'manual' };
    });
    return { prices: out, errors };
  }

  // 한국 정규장(평일 09:00~15:30 KST) 여부
  function isMarketOpen(now = new Date()) {
    const kst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
    const day = kst.getDay();
    const m = kst.getHours() * 60 + kst.getMinutes();
    return day >= 1 && day <= 5 && m >= 540 && m <= 930;
  }

  g.Prices = { sources, parseBulk, isMarketOpen };
})(window);
