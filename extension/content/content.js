/**
 * Content Script - 메인 오케스트레이터
 * 아마존 상품 페이지에서 실행: 스크래핑 → 분석 → UI 렌더링
 */
(async () => {
  // 상품 페이지 아닌 경우 or 이미 주입된 경우 스킵
  if (!window.location.pathname.match(/\/dp\/|\/gp\/product\//)) return;
  if (document.getElementById('rr-badge')) return;

  const ASIN = extractASIN();
  if (!ASIN) return;

  // ── 캐시 확인 ────────────────────────────────────────────────────────────
  const cached = getCached(ASIN);
  if (cached) {
    renderUI(cached);
    return;
  }

  showLoading();

  try {
    // 1. 상품 정보 + DOM 리뷰 (빠름)
    const scraped = await window.AmazonScraper.scrapeAll();

    // 2. 백그라운드 탭으로 전체 리뷰 수집 (느리지만 완전함)
    const allTabReviews = await getAllReviews(ASIN);
    if (allTabReviews) scraped.reviews = allTabReviews;

    if (!scraped.reviews.length) {
      showMessage('No reviews found on this page');
      return;
    }

    // 2. 패턴 분석 (로컬, 즉시)
    const pattern = window.PatternAnalyzer.analyze(scraped.reviews, scraped.product);

    // 3. AI 분석 (API 키 있을 때만)
    const apiKey = await getApiKey();
    let ai = null;
    let finalScore = pattern.score;
    let finalGrade = pattern.grade;

    if (apiKey) {
      ai = await window.AIAnalyzer.analyzeWithAI(scraped.reviews, apiKey);
      if (ai && !ai.error) {
        finalScore = window.AIAnalyzer.combineScores(pattern.score, ai);
        finalGrade = window.PatternAnalyzer.scoreToGrade(finalScore);
      }
    }

    const result = {
      product:    scraped.product,
      reviews:    scraped.reviews,
      pattern,
      ai,
      finalScore,
      finalGrade,
      asin:       ASIN,
      analyzedAt: Date.now(),
    };

    setCache(ASIN, result);
    chrome.runtime.sendMessage({ type: 'UPDATE_STATS', grade: finalGrade });
    renderUI(result);

  } catch (err) {
    console.error('[ReviewRadar]', err);
    showMessage('Analysis failed: ' + err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 헬퍼
  // ─────────────────────────────────────────────────────────────────────────

  function extractASIN() {
    const m = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/);
    return m ? m[1] : null;
  }

  // 캐시 키에 extension 버전 포함 → 코드 업데이트(⟳) 시 자동으로 새 분석 실행
  const EXT_VER = chrome.runtime.getManifest().version;
  const cacheKey = (asin) => `rr_${EXT_VER}_${asin}`;

  function getCached(asin) {
    try {
      const raw = localStorage.getItem(cacheKey(asin));
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.analyzedAt > 86_400_000) {
        localStorage.removeItem(cacheKey(asin));
        return null;
      }
      return data;
    } catch { return null; }
  }

  function setCache(asin, data) {
    try { localStorage.setItem(cacheKey(asin), JSON.stringify(data)); } catch {}
    chrome.runtime.sendMessage({ type: 'SET_CACHE', asin, data });
  }

  function getApiKey() {
    return new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'GET_API_KEY' }, res =>
        resolve(res?.apiKey || null)
      )
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI 렌더링
  // ─────────────────────────────────────────────────────────────────────────

  function showLoading() {
    mountBadge('loading', '···');
  }

  function updateLoadingText(text) {
    const badge = document.getElementById('rr-badge');
    if (badge) badge.setAttribute('title', text);
  }

  async function getAllReviews(asin) {
    updateLoadingText('Fetching all reviews...');

    const onProgress = msg => {
      if (msg.type === 'SCRAPE_PROGRESS') {
        updateLoadingText(`Fetching reviews... (${msg.count} found)`);
      }
    };
    chrome.runtime.onMessage.addListener(onProgress);

    try {
      const result = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'SCRAPE_ALL_REVIEWS', asin }, resolve)
      );
      return result?.reviews?.length > 0 ? result.reviews : null;
    } catch {
      return null;
    } finally {
      chrome.runtime.onMessage.removeListener(onProgress);
    }
  }

  function showMessage(msg) {
    document.getElementById('rr-badge')?.remove();
    mountBadge('error', '!', msg);
  }

  function renderUI(result) {
    document.getElementById('rr-badge')?.remove();
    document.getElementById('rr-panel')?.remove();

    const badge = mountBadge(result.finalGrade, result.finalGrade);
    const panel = mountPanel(result);

    badge.addEventListener('click', () => panel.classList.toggle('rr-panel--open'));
  }

  function mountBadge(gradeClass, label, tooltip = '') {
    const el = document.createElement('div');
    el.id = 'rr-badge';
    el.className = `rr-badge rr-grade-${gradeClass.toLowerCase()}`;
    el.setAttribute('title', tooltip || `Review Radar: Grade ${label}`);
    el.innerHTML = `
      <svg class="rr-badge__icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M9 12l-3-3 1.4-1.4L9 9.2l5.6-5.6L16 5z"/>
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-2a6 6 0 110-12 6 6 0 010 12z" clip-rule="evenodd"/>
      </svg>
      <span class="rr-badge__label">${label}</span>
    `;
    document.body.appendChild(el);
    return el;
  }

  function mountPanel(result) {
    const { finalGrade: grade, finalScore: score, reviews, pattern, ai, product } = result;
    const vpCount = reviews.filter(r => r.isVerified).length;
    const vpPct   = reviews.length ? Math.round(vpCount / reviews.length * 100) : 0;
    const allFlags = [
      ...(pattern.flags || []),
      ...(ai?.flags    || []),
    ];
    const mode = ai && !ai.error ? 'Pattern + AI' : 'Pattern only';

    const panel = document.createElement('div');
    panel.id = 'rr-panel';
    panel.className = 'rr-panel';
    panel.innerHTML = `
      <div class="rr-panel__header">
        <span class="rr-panel__title">🔍 Review Radar</span>
        <div class="rr-panel__actions">
          <button class="rr-btn-icon" id="rr-refresh" title="Re-analyze (clear cache)">↺</button>
          <button class="rr-panel__close" id="rr-close" aria-label="Close">✕</button>
        </div>
      </div>

      <div class="rr-panel__body">

        <!-- 점수 섹션 -->
        <div class="rr-score">
          <div class="rr-grade rr-grade-${grade.toLowerCase()}">${grade}</div>
          <div class="rr-score__info">
            <div class="rr-score__num">${score}<span class="rr-score__den">/100</span></div>
            <div class="rr-score__desc">${gradeLabel(grade)}</div>
          </div>
        </div>

        <!-- 통계 칩 -->
        <div class="rr-chips">
          <div class="rr-chip">
            <span class="rr-chip__val">${reviews.length}</span>
            <span class="rr-chip__key">Reviews</span>
          </div>
          <div class="rr-chip">
            <span class="rr-chip__val">${vpPct}%</span>
            <span class="rr-chip__key">Verified</span>
          </div>
          <div class="rr-chip">
            <span class="rr-chip__val">${mode}</span>
            <span class="rr-chip__key">Mode</span>
          </div>
        </div>

        <!-- 플래그 -->
        ${renderFlags(allFlags)}

        <!-- 별점 분포 -->
        ${renderDistribution(product.ratingDistribution)}

        <div class="rr-footer">
          Powered by Review Radar${ai && !ai.error ? ' · GPT-4o-mini' : ''}
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    panel.querySelector('#rr-close').addEventListener('click', () =>
      panel.classList.remove('rr-panel--open')
    );
    panel.querySelector('#rr-refresh').addEventListener('click', () => {
      try { localStorage.removeItem(cacheKey(ASIN)); } catch {}
      chrome.runtime.sendMessage({ type: 'SET_CACHE', asin: ASIN, data: null });
      location.reload();
    });
    return panel;
  }

  function renderFlags(flags) {
    if (!flags.length) {
      return `<div class="rr-flags">
        <div class="rr-flag rr-flag--ok">✓ No suspicious patterns detected</div>
      </div>`;
    }
    const items = flags.map(f =>
      `<div class="rr-flag rr-flag--warn">⚠ ${f}</div>`
    ).join('');
    return `<div class="rr-flags">
      <div class="rr-flags__title">Suspicious Patterns</div>
      ${items}
    </div>`;
  }

  function renderDistribution(dist) {
    if (!dist) return '';
    const bars = [5, 4, 3, 2, 1].map(s => {
      const pct = dist[s] || 0;
      return `
        <div class="rr-dist__row">
          <span class="rr-dist__star">${s}★</span>
          <div class="rr-dist__bar-wrap">
            <div class="rr-dist__bar" style="width:${pct}%"></div>
          </div>
          <span class="rr-dist__pct">${pct}%</span>
        </div>`;
    }).join('');
    return `<div class="rr-dist">
      <div class="rr-dist__title">Rating Distribution</div>
      ${bars}
    </div>`;
  }

  function gradeLabel(grade) {
    return {
      A: 'Trustworthy reviews',
      B: 'Generally reliable',
      C: 'Some concerns',
      D: 'Suspected fake reviews',
      F: 'Highly suspicious',
    }[grade] || '';
  }
})();
