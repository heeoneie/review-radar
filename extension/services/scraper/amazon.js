/**
 * Amazon Review Scraper
 *
 * 3-tier fallback 전략:
 *   1순위: 페이지 내 <script> 임베딩 JSON 추출 (SSR 데이터)
 *   2순위: XHR/fetch 인터셉션 (동적 로딩 캐치)
 *   3순위: DOM 파싱 (최후 수단)
 */
window.AmazonScraper = (() => {

  // ─────────────────────────────────────────────────────────────────────────
  // 1순위: 임베딩 JSON 추출
  // ─────────────────────────────────────────────────────────────────────────

  function tryExtractEmbeddedJSON() {
    const scripts = document.querySelectorAll('script[type="application/json"], script[data-a-state]');

    for (const script of scripts) {
      try {
        const raw = script.textContent.trim();
        if (!raw.startsWith('{') && !raw.startsWith('[')) continue;

        const json = JSON.parse(raw);
        const reviews = parseJSONReviews(json);
        if (reviews.length > 0) {
          console.log('[ReviewRadar] Tier-1: embedded JSON hit, reviews:', reviews.length);
          return reviews;
        }
      } catch {}
    }

    // window.__INITIAL_DATA__ 류 전역 변수 확인
    const globals = ['__INITIAL_DATA__', 'P', 'ue_jse'];
    for (const key of globals) {
      try {
        const data = window[key];
        if (!data) continue;
        const reviews = parseJSONReviews(data);
        if (reviews.length > 0) {
          console.log('[ReviewRadar] Tier-1: global variable hit, reviews:', reviews.length);
          return reviews;
        }
      } catch {}
    }

    return null;
  }

  function parseJSONReviews(obj) {
    // Amazon JSON 구조에서 리뷰 배열을 재귀 탐색
    if (!obj || typeof obj !== 'object') return [];

    // 리뷰 배열로 보이는 필드명 후보
    const reviewKeys = ['reviews', 'customerReviews', 'reviewsList', 'reviewItems'];
    for (const key of reviewKeys) {
      if (Array.isArray(obj[key]) && obj[key].length > 0) {
        const mapped = obj[key].map(mapJSONReview).filter(Boolean);
        if (mapped.length > 0) return mapped;
      }
    }

    // 재귀 탐색 (최대 3단계)
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const found = parseJSONReviews(val);
        if (found.length > 0) return found;
      }
    }
    return [];
  }

  function mapJSONReview(item) {
    if (!item || typeof item !== 'object') return null;
    const body = item.body || item.reviewText || item.text || item.content || '';
    if (!body) return null;

    return {
      id: item.id || item.reviewId || `json-${Math.random().toString(36).slice(2)}`,
      rating: parseFloat(item.rating || item.starRating || item.overallRating) || null,
      title: item.title || item.reviewTitle || '',
      body: body.toString().trim(),
      isVerified: !!(item.verifiedPurchase || item.isVerifiedPurchase),
      date: item.date ? new Date(item.date) : null,
      helpfulVotes: parseInt(item.helpfulVotes || item.helpful || 0) || 0,
      reviewerName: item.reviewerName || item.customerName || item.author || 'Anonymous',
      source: 'json',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2순위: 전체 리뷰 fetch (5개씩 병렬, 페이지 제한 없음)
  // ─────────────────────────────────────────────────────────────────────────

  const FETCH_BATCH = 5; // 동시 요청 수

  // 현재 페이지에서 "See all reviews" 링크 URL 베이스 추출 (product slug 포함)
  function getReviewsBaseUrl(asin) {
    const el = document.querySelector(
      '[data-hook="see-all-reviews-link-foot"], ' +
      '[data-hook="see-all-reviews-link-top"], ' +
      `a[href*="product-reviews/${asin}"]`
    );
    if (el?.href) return el.href.split('?')[0].split('#')[0];
    return `https://www.amazon.com/product-reviews/${asin}`;
  }

  async function fetchReviewPage(baseUrl, pageNum) {
    const url = `${baseUrl}?ie=UTF8&reviewerType=all_reviews&pageNumber=${pageNum}`;
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      if (!res.ok) {
        console.warn(`[ReviewRadar] Page ${pageNum}: HTTP ${res.status}`);
        return null;
      }
      if (res.url.includes('/ap/') || res.url.includes('/robot')) {
        console.warn(`[ReviewRadar] Page ${pageNum}: redirected to login/captcha`);
        return null;
      }

      const html = await res.text();
      const doc  = new DOMParser().parseFromString(html, 'text/html');

      const reviewEls = doc.querySelectorAll('[data-hook="review"]');
      console.log(`[ReviewRadar] Page ${pageNum}: ${reviewEls.length} reviews (${res.url.slice(0, 80)})`);
      if (reviewEls.length === 0) return null;

      const reviews = [];
      reviewEls.forEach((el, idx) => {
        const r = parseSingleReview(el, `p${pageNum}-${idx}`);
        if (r?.body?.length > 0) reviews.push(r);
      });

      const hasNextPage = !!doc.querySelector('li.a-last:not(.a-disabled)');
      return { reviews, hasNextPage };
    } catch (e) {
      console.warn(`[ReviewRadar] Page ${pageNum} fetch error:`, e);
      return null;
    }
  }

  async function fetchAllReviews(asin) {
    const baseUrl = getReviewsBaseUrl(asin);
    console.log(`[ReviewRadar] Review base URL: ${baseUrl}`);

    const allReviews = [];
    const seen = new Set();
    let startPage = 1;

    while (true) {
      const pageNums = Array.from({ length: FETCH_BATCH }, (_, i) => startPage + i);
      const settled  = await Promise.allSettled(pageNums.map(p => fetchReviewPage(baseUrl, p)));

      // 이 배치에서 리뷰가 있는 마지막 페이지 인덱스 찾기
      let lastFilledIdx = -1;
      settled.forEach((r, i) => {
        if (r.status !== 'fulfilled' || !r.value?.reviews?.length) return;
        lastFilledIdx = i;
        r.value.reviews.forEach(rev => {
          if (!seen.has(rev.id)) { seen.add(rev.id); allReviews.push(rev); }
        });
      });

      if (lastFilledIdx === -1) break; // 배치 전체에 리뷰 없음 → 종료

      const lastFilled = settled[lastFilledIdx].value;
      if (!lastFilled.hasNextPage) break; // 마지막 유효 페이지 도달 → 종료

      console.log(`[ReviewRadar] Fetched ${allReviews.length} reviews so far...`);
      startPage += FETCH_BATCH;
    }

    console.log(`[ReviewRadar] Tier-2: total ${allReviews.length} reviews fetched`);
    return allReviews;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3순위: DOM 파싱 (fallback)
  // ─────────────────────────────────────────────────────────────────────────

  function scrapeReviewsFromDOM() {
    const containers = document.querySelectorAll(
      '[data-hook="review"], ' +
      '#cm-cr-dp-review-list [data-hook="review"], ' +
      '.review.aok-relative'
    );

    const reviews = [];
    containers.forEach((el, idx) => {
      try {
        const r = parseSingleReview(el, idx);
        if (r?.body?.length > 0) reviews.push(r);
      } catch (e) {
        console.warn('[ReviewRadar] DOM parse error:', e);
      }
    });

    console.log('[ReviewRadar] Tier-3: DOM fallback, reviews:', reviews.length);
    return reviews;
  }

  function parseSingleReview(el, idx) {
    const id = el.id || `dom-${idx}`;

    const ratingEl =
      el.querySelector('[data-hook="review-star-rating"] .a-icon-alt') ||
      el.querySelector('[data-hook="cmps-review-star-rating"] .a-icon-alt') ||
      el.querySelector('.review-rating .a-icon-alt');
    const rating = ratingEl ? parseFloat(ratingEl.textContent) : null;

    const titleEl =
      el.querySelector('[data-hook="review-title"] span:not(.a-icon-alt)') ||
      el.querySelector('[data-hook="review-title"]') ||
      el.querySelector('.review-title span');
    const title = titleEl?.textContent.trim() || '';

    const bodyEl =
      el.querySelector('[data-hook="review-body"] span') ||
      el.querySelector('[data-hook="review-body"]') ||
      el.querySelector('.review-text-content span') ||
      el.querySelector('.review-text');
    const body = bodyEl?.textContent.trim() || '';

    // VP 배지는 언어 무관하게 data-hook 속성으로 존재 여부만 확인
    // (한국어: "확인된 구매", 영어: "Verified Purchase" 등 텍스트는 무시)
    const vpEl = el.querySelector('[data-hook="avp-badge"]');
    const isVerified = !!vpEl;

    const dateEl =
      el.querySelector('[data-hook="review-date"]') ||
      el.querySelector('.review-date');
    const dateMatch = dateEl?.textContent.match(/(\w+ \d{1,2},\s*\d{4})/);
    const date = dateMatch ? new Date(dateMatch[1]) : null;

    const helpfulEl =
      el.querySelector('[data-hook="helpful-vote-statement"]') ||
      el.querySelector('.cr-helpful-vote-statement');
    const helpfulMatch = helpfulEl?.textContent.match(/\d+/);
    const helpfulVotes = helpfulMatch ? parseInt(helpfulMatch[0]) : 0;

    const nameEl =
      el.querySelector('[data-hook="genome-widget"] .a-profile-name') ||
      el.querySelector('.a-profile-name');
    const reviewerName = nameEl?.textContent.trim() || 'Anonymous';

    return { id, rating, title, body, isVerified, date, helpfulVotes, reviewerName, source: 'dom' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 상품 정보 추출
  // ─────────────────────────────────────────────────────────────────────────

  function getProductInfo() {
    const product = {};

    product.title =
      document.querySelector('#productTitle')?.textContent.trim() ||
      document.querySelector('.product-title-word-break')?.textContent.trim() ||
      document.querySelector('h1.a-size-large')?.textContent.trim() ||
      'Unknown Product';

    const asinMatch = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/);
    product.asin = asinMatch ? asinMatch[1] : null;

    const ratingAttr =
      document.querySelector('#acrPopover')?.getAttribute('title') ||
      document.querySelector('[data-hook="rating-out-of-text"]')?.textContent;
    product.overallRating = ratingAttr ? parseFloat(ratingAttr) : null;

    const reviewCountEl =
      document.querySelector('#acrCustomerReviewText')?.textContent ||
      document.querySelector('[data-hook="total-review-count"]')?.textContent;
    product.totalReviewCount = reviewCountEl
      ? parseInt(reviewCountEl.replace(/[^0-9]/g, ''))
      : 0;

    product.ratingDistribution = getRatingDistribution();

    return product;
  }

  function getRatingDistribution() {
    const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    // 방법 0: .a-meter[aria-valuenow] — Amazon이 접근성용으로 항상 넣는 속성 (가장 신뢰)
    const meters = document.querySelectorAll('.a-meter[aria-valuenow]');
    if (meters.length >= 2) {
      let fallbackIdx = 5;
      meters.forEach(m => {
        const pct = parseInt(m.getAttribute('aria-valuenow'));
        if (isNaN(pct)) return;
        // 가까운 <tr>에서 별점 숫자 추출
        const row = m.closest('tr');
        if (row) {
          const txt = row.querySelector('td')?.textContent || '';
          const sm  = txt.match(/\b([1-5])\b/);
          if (sm) { dist[parseInt(sm[1])] = pct; return; }
        }
        // 행 파싱 실패 시 5→1 순서로 대입
        if (fallbackIdx >= 1) dist[fallbackIdx--] = pct;
      });
      if (Object.values(dist).some(v => v > 0)) return dist;
    }

    // 방법 1: aria-label에 "N percent of reviews have M stars" 형태 파싱
    const ariaLinks = document.querySelectorAll(
      '[aria-label*="star"], [aria-label*="별"], ' +
      '[aria-label*="Stars"], [aria-label*="stars"]'
    );
    ariaLinks.forEach(el => {
      const label = el.getAttribute('aria-label') || '';
      const m = label.match(/(\d+)\s*%?\s*(?:percent|of).*?(\d)\s*star/i) ||
                label.match(/별\s*(\d+)개.*?(\d+)\s*%/i);
      if (m) {
        const pct   = parseInt(m[1]);
        const stars = parseInt(m[2]);
        if (stars >= 1 && stars <= 5 && !isNaN(pct)) dist[stars] = pct;
      }
    });
    if (Object.values(dist).some(v => v > 0)) return dist;

    // 방법 2: 히스토그램 테이블 행에서 별점 + 퍼센트 추출
    const rows = document.querySelectorAll(
      '#histogramTable tr, .a-histogram-row, [data-hook="rating-histogram"] tr, ' +
      'table.a-normal tr, .cr-widget-histogram tr'
    );
    rows.forEach(row => {
      const cells = row.querySelectorAll('td, th, span');
      let stars = null, pct = null;
      cells.forEach(cell => {
        const t = cell.textContent.trim();
        if (/^[1-5]$/.test(t) || /^[1-5]\s*(star|별)/i.test(t)) stars = parseInt(t);
        if (/^\d{1,3}%$/.test(t)) pct = parseInt(t);
      });
      if (stars && pct !== null && !isNaN(pct)) dist[stars] = pct;
    });
    if (Object.values(dist).some(v => v > 0)) return dist;

    // 방법 3: .a-text-right .a-size-base 순서 파싱 (5→1)
    const pctEls = document.querySelectorAll('.a-text-right .a-size-base, .cr-widget-histogram .a-text-right');
    let starIndex = 5;
    pctEls.forEach(el => {
      const t = el.textContent.trim();
      if (/^\d{1,3}%$/.test(t) && starIndex >= 1) dist[starIndex--] = parseInt(t);
    });

    return dist;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 메인 진입점
  // ─────────────────────────────────────────────────────────────────────────

  async function scrapeAll() {
    const product = getProductInfo();

    // 1순위: 임베딩 JSON (SSR 데이터 있는 경우)
    let reviews = tryExtractEmbeddedJSON();

    // 2순위: 리뷰 페이지 직접 fetch (최대 5페이지 = 50개)
    if (!reviews || reviews.length === 0) {
      console.log('[ReviewRadar] Tier-1 miss → fetching review pages...');
      if (product.asin) reviews = await fetchAllReviews(product.asin);
    }

    // 3순위: DOM 파싱 (현재 페이지 10개, 최후 수단)
    if (!reviews || reviews.length === 0) {
      console.log('[ReviewRadar] Tier-2 miss → DOM fallback');
      reviews = scrapeReviewsFromDOM();
    }

    return {
      product,
      reviews: reviews || [],
      scrapedAt: Date.now(),
      url: window.location.href,
    };
  }

  return { scrapeAll };
})();
