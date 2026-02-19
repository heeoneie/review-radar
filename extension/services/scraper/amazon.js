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
  // 2순위: XHR/Fetch 인터셉션
  // MAIN world 스크립트를 동적으로 주입해서 window.fetch / XHR 래핑
  // content script(isolated world) ↔ 주입 스크립트(main world) 는
  // window.postMessage 로 통신
  // ─────────────────────────────────────────────────────────────────────────

  let _interceptedReviews = null;

  function injectInterceptor() {
    if (document.getElementById('rr-interceptor')) return;

    // 인라인 script는 Amazon CSP에 막히므로 web_accessible_resources 파일을 src로 주입
    const script = document.createElement('script');
    script.id  = 'rr-interceptor';
    script.src = chrome.runtime.getURL('content/interceptor.js');
    (document.head || document.documentElement).appendChild(script);
  }

  function waitForInterceptedReviews(timeoutMs = 5000) {
    return new Promise(resolve => {
      if (_interceptedReviews) return resolve(_interceptedReviews);

      const handler = e => {
        if (e.data?.__rrType === 'REVIEWS_INTERCEPTED') {
          window.removeEventListener('message', handler);
          clearTimeout(timer);
          const reviews = e.data.reviews.map(r => ({
            ...r,
            date: r.date ? new Date(r.date) : null,
          }));
          _interceptedReviews = reviews;
          resolve(reviews);
        }
      };

      window.addEventListener('message', handler);
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, timeoutMs);
    });
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

    // 방법 1: aria-label에 "% of reviews have N stars" 또는 "별 N개" 형태로 파싱
    // 아마존이 언어/레이아웃에 따라 히스토그램 구조를 자주 바꾸므로 다양한 방법 시도
    const ariaLinks = document.querySelectorAll(
      '[aria-label*="star"], [aria-label*="별"], ' +
      '[aria-label*="Stars"], [aria-label*="stars"]'
    );
    ariaLinks.forEach(el => {
      const label = el.getAttribute('aria-label') || '';
      // "73 percent of reviews have 5 stars" / "73% of reviews have 5 stars"
      const m = label.match(/(\d+)\s*%?\s*(?:percent|of).*?(\d)\s*star/i) ||
                label.match(/별\s*(\d+)개.*?(\d+)\s*%/i);
      if (m) {
        const pct   = parseInt(m[1]);
        const stars = parseInt(m[2]);
        if (stars >= 1 && stars <= 5 && !isNaN(pct)) dist[stars] = pct;
      }
    });

    // 방법 2: 히스토그램 테이블 행에서 숫자 추출
    if (Object.values(dist).every(v => v === 0)) {
      const rows = document.querySelectorAll(
        '#histogramTable tr, .a-histogram-row, [data-hook="rating-histogram"] tr, ' +
        'table.a-normal tr, .cr-widget-histogram tr'
      );
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th, span');
        let stars = null, pct = null;
        cells.forEach(cell => {
          const t = cell.textContent.trim();
          if (/^[1-5]$/.test(t) || /^[1-5]\s*(star|별)/i.test(t)) {
            stars = parseInt(t);
          }
          if (/^\d{1,3}%$/.test(t)) {
            pct = parseInt(t);
          }
        });
        if (stars && pct !== null && !isNaN(pct)) dist[stars] = pct;
      });
    }

    // 방법 3: 페이지 내 별점 분포 텍스트 파싱 (73%, 11% 형태로 나열된 경우)
    if (Object.values(dist).every(v => v === 0)) {
      const pctEls = document.querySelectorAll('.a-text-right .a-size-base, .cr-widget-histogram .a-text-right');
      let starIndex = 5;
      pctEls.forEach(el => {
        const t = el.textContent.trim();
        if (/^\d{1,3}%$/.test(t) && starIndex >= 1) {
          dist[starIndex--] = parseInt(t);
        }
      });
    }

    return dist;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 메인 진입점
  // ─────────────────────────────────────────────────────────────────────────

  async function scrapeAll() {
    // 인터셉터를 가장 먼저 주입 (페이지 XHR 캐치)
    injectInterceptor();

    const product = getProductInfo();

    // 1순위: 임베딩 JSON
    let reviews = tryExtractEmbeddedJSON();

    // 2순위: XHR 인터셉션 대기 (이미 발생했거나 곧 발생할 것)
    if (!reviews || reviews.length === 0) {
      console.log('[ReviewRadar] Tier-1 miss → waiting for XHR intercept...');
      reviews = await waitForInterceptedReviews(4000);
    }

    // 3순위: DOM 파싱
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
