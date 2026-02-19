/**
 * XHR/Fetch Interceptor — MAIN world에서 실행
 * content script가 <script src="..."> 방식으로 주입 (CSP 우회)
 * Amazon의 리뷰 API 응답을 가로채서 window.postMessage로 전달
 */
(function () {
  if (window.__rrInterceptorInstalled) return;
  window.__rrInterceptorInstalled = true;

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

      const dateText  = dateEl?.textContent || '';
      const dateMatch = dateText.match(/(\w+ \d{1,2},\s*\d{4})/);

      reviews.push({
        id:           el.id || ('xhr-' + idx),
        rating:       ratingEl ? parseFloat(ratingEl.textContent) : null,
        title:        titleEl?.textContent.trim() || '',
        body,
        isVerified:   !!(vpEl?.textContent.toLowerCase().includes('verified')),
        date:         dateMatch ? dateMatch[1] : null,
        helpfulVotes: 0,
        reviewerName: nameEl?.textContent.trim() || 'Anonymous',
        source:       'xhr',
      });
    });

    if (reviews.length > 0) {
      window.postMessage({ __rrType: 'REVIEWS_INTERCEPTED', reviews }, '*');
    }
  }

  // fetch 래핑
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const res = await _origFetch.apply(this, args);
    if (isReviewURL(url)) {
      try {
        parseReviewsFromHTML(await res.clone().text());
      } catch {}
    }
    return res;
  };

  // XMLHttpRequest 래핑
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._rrUrl = url;
    return _origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isReviewURL(this._rrUrl)) {
      this.addEventListener('load', () => {
        try { parseReviewsFromHTML(this.responseText); } catch {}
      });
    }
    return _origSend.apply(this, args);
  };
})();
