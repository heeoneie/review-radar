/**
 * AI Analyzer
 * OpenAI gpt-4o-mini를 사용한 리뷰 신뢰도 분석
 * 패턴 분석의 보조 역할 - API 키 없으면 스킵
 */
window.AIAnalyzer = (() => {

  const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
  const MODEL    = 'gpt-4o-mini';

  // ─────────────────────────────────────────────────────────────────────────
  // 프롬프트 구성
  // ─────────────────────────────────────────────────────────────────────────

  function buildPrompt(reviews) {
    const reviewsData = reviews.map(r => ({
      review_id:   r.id,
      rating:      r.rating,
      title:       r.title,
      body:        r.body.slice(0, 400), // 토큰 절약
      is_verified: r.isVerified,
      date:        r.date instanceof Date ? r.date.toISOString().slice(0, 10) : null,
    }));

    return `Analyze these Amazon product reviews and rate each one's authenticity from 0–100.

Evaluation criteria:
1. Does it describe specific, concrete usage experience?
2. Are the emotions and language natural (not templated or generic)?
3. Does it show signs of AI-generation (repetitive phrasing, overly polished)?
4. Is it suspiciously similar to other reviews in the set?

Review data:
${JSON.stringify(reviewsData, null, 2)}

Respond ONLY with a JSON array, no other text:
[{"review_id":"...","trust_score":85,"flags":["specific usage described"],"risk_level":"low"}]

risk_level must be one of: "low", "medium", "high"`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OpenAI 호출
  // ─────────────────────────────────────────────────────────────────────────

  async function analyzeWithAI(reviews, apiKey) {
    if (!apiKey || !reviews?.length) return null;

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model:       MODEL,
          messages:    [{ role: 'user', content: buildPrompt(reviews) }],
          temperature: 0.2,
          max_tokens:  1200,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }

      const data    = await res.json();
      const content = data.choices?.[0]?.message?.content || '';

      // JSON 파싱 - 마크다운 코드블록 안에 있을 수도 있음
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('AI response did not contain valid JSON array');

      const reviewScores = JSON.parse(match[0]);

      const avgTrust = reviewScores.reduce((sum, r) => sum + (r.trust_score || 50), 0)
                       / reviewScores.length;
      const allFlags     = [...new Set(reviewScores.flatMap(r => r.flags || []))];
      const highRiskCount = reviewScores.filter(r => r.risk_level === 'high').length;

      return {
        reviewScores,
        aggregateScore: Math.round(avgTrust),
        flags:          allFlags,
        highRiskCount,
        model:          MODEL,
        tokensUsed:     data.usage?.total_tokens || 0,
      };

    } catch (err) {
      console.error('[ReviewRadar] AI analysis failed:', err.message);
      return { error: err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 패턴 점수 + AI 점수 합산
  // 패턴 40% : AI 60%
  // ─────────────────────────────────────────────────────────────────────────

  function combineScores(patternScore, aiResult) {
    if (!aiResult || aiResult.error) return patternScore;
    return Math.round(patternScore * 0.4 + aiResult.aggregateScore * 0.6);
  }

  return { analyzeWithAI, combineScores };
})();
