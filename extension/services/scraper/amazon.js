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
  // 2순위: 숨겨진 iframe으로 product-reviews 페이지 로딩
  // fetch()는 Sec-Fetch-Mode: no-cors → Amazon 차단
  // iframe은 Sec-Fetch-Mode: navigate → 실제 브라우저 탐색으로 인식
  // ─────────────────────────────────────────────────────────────────────────

  const IFRAME_MAX_PAGES = 5; // 최대 50개

  function getReviewsBaseUrl(asin) {
    const el = document.querySelector(
      `[data-hook="see-all-reviews-link-foot"], [data-hook="see-all-reviews-link-top"], a[href*="product-reviews/${asin}"]`
    );
    if (el?.href) {
      // /ref=... 경로 접미사와 쿼리스트링 제거
      // 예: https://www.amazon.com/-/ko/product-reviews/B0CK99VP7J/ref=xxx?ie=UTF8...
      //  → https://www.amazon.com/-/ko/product-reviews/B0CK99VP7J
      return el.href.split('?')[0].replace(/\/ref=.*$/, '');
    }
    return `https://www.amazon.com/product-reviews/${asin}`;
  }

  function loadViaIframe(url) {
    return new Promise(resolve => {
      const iframe = document.createElement('iframe');
      // 숨김 처리 (사용자에게 보이지 않게)
      iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1920px;height:1080px;opacity:0;pointer-events:none;z-index:-1;';

      const cleanup = (result) => {
        clearTimeout(timer);
        if (document.body.contains(iframe)) document.body.removeChild(iframe);
        resolve(result);
      };

      const timer = setTimeout(() => {
        console.warn('[ReviewRadar] iframe timeout');
        cleanup(null);
      }, 10000);

      iframe.onload = () => {
        try {
          const loc = iframe.contentWindow?.location?.href || '';
          // about:blank는 초기 상태 — 실제 URL 로드 대기
          if (!loc || loc === 'about:blank') return;

          if (loc.includes('/ap/') || loc.includes('/robot') || loc.includes('/signin')) {
            console.warn('[ReviewRadar] iframe redirected to auth page');
            return cleanup(null);
          }

          const doc = iframe.contentDocument;
          const reviewEls = doc?.querySelectorAll('[data-hook="review"]') || [];
          console.log(`[ReviewRadar] iframe: ${reviewEls.length} reviews at ${loc.slice(0, 80)}`);

          const reviews = [];
          reviewEls.forEach((el, idx) => {
            const r = parseSingleReview(el, `fr-${idx}`);
            if (r?.body?.length > 0) reviews.push(r);
          });

          const hasNextPage = !!doc?.querySelector('li.a-last:not(.a-disabled)');
          cleanup({ reviews, hasNextPage });
        } catch (e) {
          console.warn('[ReviewRadar] iframe access error:', e.message);
          cleanup(null);
        }
      };

      iframe.onerror = () => cleanup(null);
      // src를 먼저 설정한 뒤 DOM에 추가 → about:blank 초기 onload 방지
      iframe.src = url;
      document.body.appendChild(iframe);
    });
  }

  async function scrapeViaIframes(asin) {
    const baseUrl = getReviewsBaseUrl(asin);
    console.log(`[ReviewRadar] iframe base URL: ${baseUrl}`);

    // 1페이지 먼저 테스트 (차단 여부 확인)
    const first = await loadViaIframe(`${baseUrl}?ie=UTF8&reviewerType=all_reviews&pageNumber=1`);
    if (!first || first.reviews.length === 0) {
      console.log('[ReviewRadar] iframe strategy failed, no reviews on page 1');
      return [];
    }

    const allReviews = [...first.reviews];
    const seen = new Set(allReviews.map(r => r.id));
    if (!first.hasNextPage) return allReviews;

    // 2페이지~ 병렬 로딩 (3개씩)
    let page = 2;
    while (page <= IFRAME_MAX_PAGES) {
      const batch = Array.from(
        { length: Math.min(3, IFRAME_MAX_PAGES - page + 1) },
        (_, i) => page + i
      );
      const results = await Promise.all(
        batch.map(p => loadViaIframe(`${baseUrl}?ie=UTF8&reviewerType=all_reviews&pageNumber=${p}`))
      );

      let anyNew = false;
      results.forEach(r => {
        if (!r?.reviews?.length) return;
        r.reviews.forEach(rev => {
          if (!seen.has(rev.id)) { seen.add(rev.id); allReviews.push(rev); anyNew = true; }
        });
      });

      if (!anyNew) break;

      const lastGood = [...results].reverse().find(r => r?.reviews?.length > 0);
      if (!lastGood?.hasNextPage) break;

      page += batch.length;
    }

    console.log(`[ReviewRadar] Tier-2 (iframe): ${allReviews.length} reviews`);
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

    // 2순위: 숨겨진 iframe으로 product-reviews 페이지 로딩 (최대 50개)
    if (!reviews || reviews.length === 0) {
      console.log('[ReviewRadar] Tier-1 miss → iframe strategy...');
      if (product.asin) reviews = await scrapeViaIframes(product.asin);
    }

    // 3순위: DOM 파싱 (최후 수단, 10개)
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
