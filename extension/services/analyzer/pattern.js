/**
 * Pattern Analyzer
 * 로컬에서 실행되는 패턴 기반 가짜 리뷰 탐지
 *
 * 4가지 시그널:
 *   1. 별점 분포 이상 (5점/1점 극단 편중, bimodal 분포)
 *   2. Verified Purchase 비율
 *   3. 리뷰 폭주 탐지 (특정 기간 급증)
 *   4. 유사 문구 클러스터링 (코사인 유사도)
 */
window.PatternAnalyzer = (() => {

  // ─────────────────────────────────────────────────────────────────────────
  // 메인 진입점
  // ─────────────────────────────────────────────────────────────────────────

  function analyze(reviews, product) {
    if (!reviews || reviews.length === 0) {
      return { score: 50, grade: 'C', flags: [], signals: {}, reviewCount: 0 };
    }

    const signals = {};
    const flags = [];

    signals.ratingDist    = analyzeRatingDistribution(product?.ratingDistribution, reviews);
    signals.vpRatio       = analyzeVPRatio(reviews);
    signals.burstDetect   = analyzeReviewBurst(reviews);
    signals.similarity    = analyzeSimilarity(reviews);

    Object.values(signals).forEach(s => {
      if (s.flags?.length) flags.push(...s.flags);
    });

    const score = calculateCompositeScore(signals);
    const grade = scoreToGrade(score);

    return { score, grade, flags, signals, reviewCount: reviews.length };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Signal 1: 별점 분포 이상 탐지
  // ─────────────────────────────────────────────────────────────────────────

  function analyzeRatingDistribution(distribution, reviews) {
    const result = { score: 100, suspicious: false, flags: [] };

    // 상품 정보에 분포 없으면 리뷰에서 직접 계산
    let dist = distribution;
    const hasValidDist = dist && Object.values(dist).some(v => v > 0);

    if (!hasValidDist) {
      dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      reviews.forEach(r => {
        const star = Math.round(r.rating);
        if (star >= 1 && star <= 5) dist[star]++;
      });
      const total = reviews.length;
      if (total > 0) {
        Object.keys(dist).forEach(k => {
          dist[k] = Math.round((dist[k] / total) * 100);
        });
      }
    }

    const p5 = dist[5] || 0;
    const p1 = dist[1] || 0;
    const p3 = dist[3] || 0;

    // 5점 극단 집중
    if (p5 >= 85) {
      result.suspicious = true;
      result.flags.push(`5-star reviews extremely high (${p5}%)`);
      result.score -= 35;
    } else if (p5 >= 70) {
      result.flags.push(`High 5-star concentration (${p5}%)`);
      result.score -= 15;
    }

    // Bimodal: 5점 + 1점만 있고 중간 없음 (리뷰 폭탄 + 가짜 5점 패턴)
    if (p5 + p1 >= 80 && p3 < 5) {
      result.suspicious = true;
      result.flags.push('Bimodal distribution: polarized 5★/1★ with no middle ratings');
      result.score -= 20;
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Signal 2: Verified Purchase 비율
  // ─────────────────────────────────────────────────────────────────────────

  function analyzeVPRatio(reviews) {
    const result = { score: 100, suspicious: false, flags: [], vpRatio: 0 };

    if (reviews.length === 0) return result;

    const vpCount = reviews.filter(r => r.isVerified).length;
    const ratio = vpCount / reviews.length;
    result.vpRatio = ratio;

    if (ratio < 0.4) {
      result.suspicious = true;
      result.flags.push(`Low Verified Purchase ratio (${Math.round(ratio * 100)}%)`);
      result.score -= 35;
    } else if (ratio < 0.6) {
      result.flags.push(`Below average VP ratio (${Math.round(ratio * 100)}%)`);
      result.score -= 15;
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Signal 3: 리뷰 폭주 탐지
  // ─────────────────────────────────────────────────────────────────────────

  function analyzeReviewBurst(reviews) {
    const result = { score: 100, suspicious: false, flags: [] };

    const datedReviews = reviews.filter(r => r.date instanceof Date && !isNaN(r.date));
    if (datedReviews.length < 3) return result;

    // 주 단위 그룹핑
    const weekGroups = {};
    datedReviews.forEach(r => {
      const key = getWeekKey(r.date);
      weekGroups[key] = (weekGroups[key] || 0) + 1;
    });

    const counts = Object.values(weekGroups);
    const maxCount = Math.max(...counts);
    const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;

    if (maxCount >= avgCount * 3 && maxCount >= 3) {
      result.suspicious = true;
      result.flags.push(`Review burst: ${maxCount} reviews in a single week`);
      result.score -= 25;
    }

    // 전체 리뷰가 같은 달에 집중
    const months = new Set(
      datedReviews.map(r => `${r.date.getFullYear()}-${r.date.getMonth()}`)
    );
    if (months.size === 1 && datedReviews.length >= 5) {
      result.suspicious = true;
      result.flags.push('All reviews clustered in the same month');
      result.score -= 20;
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  function getWeekKey(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Signal 4: 유사 문구 클러스터링 (코사인 유사도)
  // ─────────────────────────────────────────────────────────────────────────

  function analyzeSimilarity(reviews) {
    const result = { score: 100, suspicious: false, flags: [], clusterSize: 0 };

    if (reviews.length < 3) return result;

    const vectors = reviews.map(r => wordFrequency(r.body.toLowerCase()));
    const clusterMembers = new Set();

    for (let i = 0; i < reviews.length; i++) {
      for (let j = i + 1; j < reviews.length; j++) {
        if (cosineSimilarity(vectors[i], vectors[j]) > 0.6) {
          clusterMembers.add(i);
          clusterMembers.add(j);
        }
      }
    }

    const ratio = clusterMembers.size / reviews.length;
    result.clusterSize = clusterMembers.size;

    if (ratio >= 0.4) {
      result.suspicious = true;
      result.flags.push(`${clusterMembers.size} reviews share suspiciously similar text`);
      result.score -= 30;
    } else if (ratio >= 0.2) {
      result.flags.push(`Some reviews share similar phrasing (${clusterMembers.size} reviews)`);
      result.score -= 15;
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  function wordFrequency(text) {
    const freq = {};
    text.split(/\W+/).filter(w => w.length > 3).forEach(w => {
      freq[w] = (freq[w] || 0) + 1;
    });
    return freq;
  }

  function cosineSimilarity(v1, v2) {
    const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
    let dot = 0, mag1 = 0, mag2 = 0;
    keys.forEach(k => {
      const a = v1[k] || 0, b = v2[k] || 0;
      dot  += a * b;
      mag1 += a * a;
      mag2 += b * b;
    });
    if (!mag1 || !mag2) return 0;
    return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 종합 점수 계산
  // ─────────────────────────────────────────────────────────────────────────

  function calculateCompositeScore(signals) {
    const weights = {
      ratingDist:  0.30,
      vpRatio:     0.30,
      burstDetect: 0.20,
      similarity:  0.20,
    };

    let total = 0;
    let wSum  = 0;
    Object.entries(weights).forEach(([key, w]) => {
      if (signals[key] != null) {
        total += signals[key].score * w;
        wSum  += w;
      }
    });

    return wSum > 0 ? Math.round(total / wSum) : 50;
  }

  function scoreToGrade(score) {
    if (score >= 80) return 'A';
    if (score >= 60) return 'B';
    if (score >= 40) return 'C';
    if (score >= 20) return 'D';
    return 'F';
  }

  return { analyze, scoreToGrade };
})();
