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

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});
