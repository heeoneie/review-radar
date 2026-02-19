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

    const script = document.createElement('script');
    script.id = 'rr-interceptor';
    script.textContent = `
(function() {
  const REVIEW_URL_PATTERNS = [
    '/hz/reviews-render/ajax/reviews/get',
    '/customer-reviews/get-customer-reviews',
    '/reviews/ajax',
  ];

  function isReviewURL(url) {
    return REVIEW_URL_PATTERNS.some(p => url && url.includes(p));
  }

  function parseReviewsFromHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const items = doc.querySelectorAll('[data-hook="review"]');
    const reviews = [];

    items.forEach((el, idx) => {
      const ratingEl = el.querySelector('[data-hook="review-star-rating"] .a-icon-alt') ||
                       el.querySelector('.review-rating .a-icon-alt');
      const bodyEl   = el.querySelector('[data-hook="review-body"] span') ||
                       el.querySelector('.review-text-content span');
      const titleEl  = el.querySelector('[data-hook="review-title"] span:not(.a-icon-alt)');
      const dateEl   = el.querySelector('[data-hook="review-date"]');
      const vpEl     = el.querySelector('[data-hook="avp-badge"]');
      const nameEl   = el.querySelector('.a-profile-name');

      const body = bodyEl?.textContent.trim() || '';
      if (!body) return;

      const dateText = dateEl?.textContent || '';
      const dateMatch = dateText.match(/(\\w+ \\d{1,2},\\s*\\d{4})/);

      reviews.push({
        id: el.id || ('xhr-' + idx),
        rating: ratingEl ? parseFloat(ratingEl.textContent) : null,
        title: titleEl?.textContent.trim() || '',
        body,
        isVerified: !!(vpEl?.textContent.toLowerCase().includes('verified')),
        date: dateMatch ? dateMatch[1] : null,
        helpfulVotes: 0,
        reviewerName: nameEl?.textContent.trim() || 'Anonymous',
        source: 'xhr',
      });
    });

    if (reviews.length > 0) {
      window.postMessage({ __rrType: 'REVIEWS_INTERCEPTED', reviews }, '*');
    }
  }

  // fetch 래핑
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const res = await _origFetch.apply(this, args);
    if (isReviewURL(url)) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        parseReviewsFromHTML(text);
      } catch {}
    }
    return res;
  };

  // XMLHttpRequest 래핑
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._rrUrl = url;
    return _origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (isReviewURL(this._rrUrl)) {
      this.addEventListener('load', () => {
        try { parseReviewsFromHTML(this.responseText); } catch {}
      });
    }
    return _origSend.apply(this, args);
  };
})();
    `;

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

    const vpEl =
      el.querySelector('[data-hook="avp-badge"]') ||
      el.querySelector('.a-color-state.a-text-bold');
    const isVerified = !!(vpEl?.textContent.toLowerCase().includes('verified'));

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

    const rows = document.querySelectorAll(
      '#histogramTable tr, ' +
      '.a-histogram-row, ' +
      '[data-hook="rating-histogram"] tr, ' +
      'table.a-normal tr'
    );

    rows.forEach(row => {
      const starEl =
        row.querySelector('.a-size-base') ||
        row.querySelector('[data-hook="histogram-row-link-text"]');
      const pctEl =
        row.querySelector('.a-text-right .a-size-base') ||
        row.querySelector('[aria-label]');

      if (!starEl || !pctEl) return;
      const stars = parseInt(starEl.textContent);
      const pctText = pctEl.textContent || pctEl.getAttribute('aria-label') || '';
      const pct = parseInt(pctText.match(/\d+/)?.[0]);
      if (stars >= 1 && stars <= 5 && !isNaN(pct)) dist[stars] = pct;
    });

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
