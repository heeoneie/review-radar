/**
 * Popup Script
 * - API 키 저장/조회/삭제
 * - 현재 탭 분석 결과 표시
 * - 통계 표시
 */

document.addEventListener('DOMContentLoaded', async () => {

  // ── 요소 참조 ─────────────────────────────────────────────────────────────
  const apiInput    = document.getElementById('api-key-input');
  const apiToggle   = document.getElementById('api-key-toggle');
  const apiSave     = document.getElementById('api-key-save');
  const apiClear    = document.getElementById('api-key-clear');
  const apiStatus   = document.getElementById('api-status');

  const statAnalyzed = document.getElementById('stat-analyzed');
  const statFakes    = document.getElementById('stat-fakes');

  const statusIdle   = document.getElementById('status-idle');
  const statusResult = document.getElementById('status-result');
  const resultGrade  = document.getElementById('result-grade');
  const resultScore  = document.getElementById('result-score');
  const resultDesc   = document.getElementById('result-desc');
  const resultMeta   = document.getElementById('result-meta');

  // ── 초기 데이터 로딩 ──────────────────────────────────────────────────────
  await Promise.all([
    loadApiKey(),
    loadStats(),
    loadCurrentTabResult(),
  ]);

  // ── API 키 ────────────────────────────────────────────────────────────────

  async function loadApiKey() {
    const res = await msg('GET_API_KEY');
    if (res?.apiKey) {
      apiInput.value = res.apiKey;
      showApiStatus('Key saved ✓', 'ok');
    }
  }

  apiToggle.addEventListener('click', () => {
    apiInput.type = apiInput.type === 'password' ? 'text' : 'password';
  });

  apiSave.addEventListener('click', async () => {
    const key = apiInput.value.trim();
    if (!key) { showApiStatus('Enter an API key first', 'err'); return; }
    if (!key.startsWith('sk-')) { showApiStatus('Invalid key format (must start with sk-)', 'err'); return; }

    await msg('SET_API_KEY', { apiKey: key });
    showApiStatus('Saved ✓', 'ok');
  });

  apiClear.addEventListener('click', async () => {
    await msg('CLEAR_API_KEY');
    apiInput.value = '';
    showApiStatus('Cleared', 'ok');
  });

  function showApiStatus(text, type) {
    apiStatus.textContent = text;
    apiStatus.className = `api-status api-status--${type}`;
    apiStatus.classList.remove('hidden');
    setTimeout(() => apiStatus.classList.add('hidden'), 3000);
  }

  // ── 통계 ──────────────────────────────────────────────────────────────────

  async function loadStats() {
    const res = await msg('GET_STATS');
    if (res?.stats) {
      statAnalyzed.textContent = res.stats.analyzed;
      statFakes.textContent    = res.stats.fakesDetected;
    }
  }

  // ── 현재 탭 결과 ──────────────────────────────────────────────────────────

  async function loadCurrentTabResult() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.match(/amazon\.com\/.*\/dp\//)) return;

    // URL에서 ASIN 추출
    const asinMatch = tab.url.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinMatch) return;

    const asin = asinMatch[1];

    // content script에 캐시 조회 요청
    const res = await msg('GET_CACHE', { asin });
    if (!res?.data) return;

    displayResult(res.data);
  }

  function displayResult(data) {
    const { finalGrade: grade, finalScore: score, reviews, ai } = data;

    statusIdle.classList.add('hidden');
    statusResult.classList.remove('hidden');

    resultGrade.textContent = grade;
    resultGrade.className   = `result-grade rr-grade-${grade.toLowerCase()}`;
    resultScore.textContent = `${score}/100`;
    resultDesc.textContent  = gradeLabel(grade);
    resultMeta.textContent  = `${reviews.length} reviews · ${ai && !ai.error ? 'AI+Pattern' : 'Pattern only'}`;
  }

  function gradeLabel(g) {
    return { A:'Trustworthy', B:'Generally reliable', C:'Some concerns',
             D:'Suspected fake', F:'Highly suspicious' }[g] || '';
  }

  // ── 메시지 헬퍼 ───────────────────────────────────────────────────────────

  function msg(type, extra = {}) {
    return new Promise(resolve =>
      chrome.runtime.sendMessage({ type, ...extra }, res => resolve(res))
    );
  }
});
