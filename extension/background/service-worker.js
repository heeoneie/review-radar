/**
 * Background Service Worker
 * - API 키 관리 (chrome.storage.local)
 * - 24h 캐시 관리
 * - 통계 (분석 횟수, 가짜 의심 탐지 횟수)
 */

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({ stats: { analyzed: 0, fakesDetected: 0 } });
  }

  // install 또는 update(⟳ 리로드 포함) 시 분석 캐시 전체 삭제
  // → 코드 변경 후 extension 리로드하면 자동으로 새 분석 실행
  if (reason === 'install' || reason === 'update') {
    chrome.storage.local.get(null, items => {
      const staleKeys = Object.keys(items).filter(k => k.startsWith('cache_'));
      if (staleKeys.length > 0) chrome.storage.local.remove(staleKeys);
      console.log(`[ReviewRadar] ${reason}: cleared ${staleKeys.length} cached analyses`);
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    // ── API 키 ─────────────────────────────────────────────────────────────
    case 'GET_API_KEY':
      chrome.storage.local.get(['openai_api_key'], res =>
        sendResponse({ apiKey: res.openai_api_key || null })
      );
      return true;

    case 'SET_API_KEY':
      chrome.storage.local.set({ openai_api_key: msg.apiKey }, () =>
        sendResponse({ success: true })
      );
      return true;

    case 'CLEAR_API_KEY':
      chrome.storage.local.remove(['openai_api_key'], () =>
        sendResponse({ success: true })
      );
      return true;

    // ── 캐시 ───────────────────────────────────────────────────────────────
    case 'GET_CACHE': {
      const cacheKey = `cache_${msg.asin}`;
      chrome.storage.local.get([cacheKey], res => {
        const cached = res[cacheKey];
        const TTL = 24 * 60 * 60 * 1000; // 24h
        if (cached && Date.now() - cached.timestamp < TTL) {
          sendResponse({ data: cached.data });
        } else {
          sendResponse({ data: null });
        }
      });
      return true;
    }

    case 'SET_CACHE': {
      const cacheKey = `cache_${msg.asin}`;
      chrome.storage.local.set({
        [cacheKey]: { data: msg.data, timestamp: Date.now() },
      }, () => sendResponse({ success: true }));
      return true;
    }

    // ── 통계 ───────────────────────────────────────────────────────────────
    case 'GET_STATS':
      chrome.storage.local.get(['stats'], res =>
        sendResponse({ stats: res.stats || { analyzed: 0, fakesDetected: 0 } })
      );
      return true;

    case 'UPDATE_STATS':
      chrome.storage.local.get(['stats'], res => {
        const stats = res.stats || { analyzed: 0, fakesDetected: 0 };
        stats.analyzed += 1;
        if (msg.grade === 'D' || msg.grade === 'F') stats.fakesDetected += 1;
        chrome.storage.local.set({ stats }, () => sendResponse({ success: true }));
      });
      return true;

    // ── 탭 기반 전체 리뷰 스크래핑 ────────────────────────────────────────────
    case 'SCRAPE_ALL_REVIEWS': {
      const senderTabId = _sender.tab ? _sender.tab.id : null;
      scrapeAllReviews(msg.asin, senderTabId)
        .then(reviews => sendResponse({ reviews }))
        .catch(() => sendResponse({ reviews: [] }));
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// ── 탭 기반 리뷰 스크래핑 구현 ─────────────────────────────────────────────────

/**
 * product-reviews 탭에 주입되는 DOM 스크래핑 함수.
 * chrome.scripting.executeScript로 직렬화되므로 완전히 독립적이어야 함
 * (클로저나 외부 변수 참조 불가).
 */
function scrapeReviewPageDOM() {
  const loc = window.location.href;
  // 로그인 페이지 / 봇 차단 / CAPTCHA 등 다양한 리다이렉트 패턴 감지
  const blocked =
    loc.includes('/ap/') ||
    loc.includes('/signin') ||
    loc.includes('sign-in') ||
    loc.includes('robot-check') ||
    loc.includes('/captcha') ||
    loc.includes('validateCaptcha');
  if (blocked) {
    return { reviews: [], hasNextPage: false, blocked: true, url: loc };
  }

  const containers = document.querySelectorAll('[data-hook="review"]');
  const reviews = [];

  containers.forEach(function(el, idx) {
    const id = el.id || ('t' + idx + '-' + Date.now());

    const ratingEl =
      el.querySelector('[data-hook="review-star-rating"] .a-icon-alt') ||
      el.querySelector('[data-hook="cmps-review-star-rating"] .a-icon-alt') ||
      el.querySelector('.review-rating .a-icon-alt');
    const rating = ratingEl ? parseFloat(ratingEl.textContent) : null;

    const titleEl =
      el.querySelector('[data-hook="review-title"] span:not(.a-icon-alt)') ||
      el.querySelector('[data-hook="review-title"]');
    const title = titleEl ? titleEl.textContent.trim() : '';

    const bodyEl =
      el.querySelector('[data-hook="review-body"] span') ||
      el.querySelector('[data-hook="review-body"]') ||
      el.querySelector('.review-text-content span') ||
      el.querySelector('.review-text');
    const body = bodyEl ? bodyEl.textContent.trim() : '';
    if (!body) return;

    const isVerified = !!el.querySelector('[data-hook="avp-badge"]');

    const dateEl =
      el.querySelector('[data-hook="review-date"]') ||
      el.querySelector('.review-date');
    const dateMatch = dateEl ? dateEl.textContent.match(/(\w+ \d{1,2},\s*\d{4})/) : null;
    const date = dateMatch ? dateMatch[1] : null;

    const helpfulEl =
      el.querySelector('[data-hook="helpful-vote-statement"]') ||
      el.querySelector('.cr-helpful-vote-statement');
    const helpfulMatch = helpfulEl ? helpfulEl.textContent.match(/\d+/) : null;
    const helpfulVotes = helpfulMatch ? parseInt(helpfulMatch[0]) : 0;

    const nameEl =
      el.querySelector('[data-hook="genome-widget"] .a-profile-name') ||
      el.querySelector('.a-profile-name');
    const reviewerName = nameEl ? nameEl.textContent.trim() : 'Anonymous';

    reviews.push({ id, rating, title, body, isVerified, date, helpfulVotes, reviewerName, source: 'tab' });
  });

  const hasNextPage = !!document.querySelector('li.a-last:not(.a-disabled) a');
  return { reviews, hasNextPage, url: loc };
}

/** URL을 새 비활성 탭에서 로드하고 scrapeReviewPageDOM 결과를 반환 */
function loadReviewPageTab(url) {
  return new Promise(async function(resolve) {
    let tabId = null;

    const timer = setTimeout(async function() {
      if (tabId !== null) try { await chrome.tabs.remove(tabId); } catch {}
      resolve(null);
    }, 20000);

    const onUpdated = async function(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeReviewPageDOM,
        });
        const result = res ? res.result : null;
        if (result) {
          console.log('[ReviewRadar] Tab loaded:', result.url ? result.url.slice(0, 80) : '?',
            '| reviews:', result.reviews.length,
            result.blocked ? '| BLOCKED' : '');
        }
        await chrome.tabs.remove(tabId);
        resolve(result);
      } catch (e) {
        console.warn('[ReviewRadar] executeScript error:', e.message);
        try { await chrome.tabs.remove(tabId); } catch {}
        resolve(null);
      }
    };

    try {
      chrome.tabs.onUpdated.addListener(onUpdated);
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * ASIN의 모든 리뷰를 product-reviews 페이지에서 탭으로 수집.
 * - 1페이지: 순차 (접근 가능 여부 확인)
 * - 이후: BATCH_SIZE 개씩 병렬 로딩
 * - 진행 상황을 senderTabId로 전송
 */
async function scrapeAllReviews(asin, senderTabId) {
  const BASE = 'https://www.amazon.com/product-reviews/' + asin;
  const PARAMS = '?ie=UTF8&reviewerType=all_reviews&pageNumber=';
  const BATCH = 3;

  const allReviews = [];
  const seen = new Set();

  function addReviews(pageResult) {
    if (!pageResult || !pageResult.reviews.length) return false;
    let added = false;
    pageResult.reviews.forEach(function(r) {
      if (!seen.has(r.id)) { seen.add(r.id); allReviews.push(r); added = true; }
    });
    return added;
  }

  function sendProgress() {
    if (senderTabId) {
      chrome.tabs.sendMessage(senderTabId, {
        type: 'SCRAPE_PROGRESS', count: allReviews.length,
      }).catch(function() {});
    }
  }

  // 1페이지: 접근 가능 여부 확인
  const first = await loadReviewPageTab(BASE + PARAMS + '1');
  if (!first || first.blocked || !first.reviews.length) {
    console.log('[ReviewRadar] Tab: page 1 blocked or empty, falling back');
    return [];
  }
  addReviews(first);
  sendProgress();
  if (!first.hasNextPage) return allReviews;

  // 이후 페이지: BATCH개씩 병렬 로딩
  let page = 2;
  while (true) {
    const batch = Array.from({ length: BATCH }, function(_, i) { return page + i; });
    const results = await Promise.all(
      batch.map(function(p) { return loadReviewPageTab(BASE + PARAMS + p); })
    );

    let reachedEnd = false;
    results.forEach(function(r) {
      if (!r || !r.reviews.length) { reachedEnd = true; return; }
      const added = addReviews(r);
      if (!added || !r.hasNextPage) reachedEnd = true;
    });

    sendProgress();
    if (reachedEnd) break;
    page += BATCH;
  }

  console.log('[ReviewRadar] Tab: total', allReviews.length, 'reviews');
  return allReviews;
}
