const APP_NAME = "근거 기반 자료 검증기";
const VERSION = "1.5-evidence-engine";
const MAX_TEXT = 18000;
const MAX_CLAIMS = 4;
const MAX_HTML = 1400000;
const FETCH_TIMEOUT_MS = 15000;
const JINA_READER = "https://r.jina.ai/";
const MAX_FACTCHECK_ARTICLES = 4;
const MAX_EVIDENCE_ARTICLES = 4;
const MAX_EVIDENCE_RESULTS = 15;

const SEARCH_STOPWORDS = new Set([
  "그리고","그러나","또한","있는","있다","있어","없는","없다","한다","했다","된다","됐다","되는","대한","통해","따르면","관련","이번","당시","현재","이후","이전","정도","때문","위해","대해","에서","에게","으로","부터","까지","보다","처럼","같은","하는","것으로","것이","것은","것도","것을","주장","내용","자료","기사","보도","말했다","밝혔다","전했다"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, app: APP_NAME, version: VERSION });
    }

    if (url.pathname === "/api/check" && request.method === "POST") {
      try {
        const body = await request.json();
        const sourceUrl = typeof body.url === "string" ? body.url.trim() : "";
        const inputText = typeof body.text === "string" ? body.text.trim() : "";
        const manualClaim = typeof body.claim === "string" ? body.claim.trim() : "";

        let articleText = inputText;
        let fetched = null;
        if (sourceUrl) {
          try {
            fetched = await fetchArticle(sourceUrl);
            if (!articleText) articleText = fetched.text;
          } catch (err) {
            return json({
              ok: false,
              error: "이 웹페이지의 원문을 가져오지 못했습니다.",
              detail: String(err?.message || err),
              suggestion: "사이트가 자동 읽기를 막았거나 페이지가 동적으로 만들어지는 경우가 있습니다. '본문을 붙여넣어 검증' 방법으로 같은 내용을 넣어 다시 확인해 주세요."
            }, 200);
          }
        }

        if (!manualClaim && !articleText) {
          return json({ ok: false, error: "URL 또는 검증할 자료를 입력해 주세요." }, 200);
        }

        articleText = cleanText(articleText).slice(0, MAX_TEXT);
        const claims = manualClaim ? [manualClaim.slice(0, 700)] : extractClaims(articleText, MAX_CLAIMS);
        if (!claims.length) {
          return json({ ok: false, error: "검증할 주장 문장을 찾지 못했습니다. 한두 문장의 핵심 주장을 직접 입력해 보세요." }, 400);
        }

        const results = [];
        for (const claim of claims) {
          results.push(await verifyClaim(claim, env));
        }

        return json({
          ok: true,
          app: APP_NAME,
          version: VERSION,
          fetched: fetched ? { url: sourceUrl, title: fetched.title, host: safeHost(sourceUrl), method: fetched.method || "direct" } : null,
          claims,
          results,
          note: "자동 판정은 검색·팩트체크 근거를 정리한 참고 결과입니다. 원문과 근거 문서를 직접 확인하세요."
        });
      } catch (err) {
        return json({
          ok: false,
          error: "검증 중 예기치 않은 오류가 발생했습니다.",
          detail: String(err?.message || err),
          suggestion: "입력 내용을 확인하고 다시 시도해 주세요. 계속되면 본문 붙여넣기 방법을 사용해 보세요."
        }, 200);
      }
    }

    return env.ASSETS.fetch(request);
  }
};

async function verifyClaim(claim, env) {
  const factChecks = env.GOOGLE_FACTCHECK_API_KEY
    ? await searchGoogleFactChecks(claim, env.GOOGLE_FACTCHECK_API_KEY)
    : [];

  const queries = buildSearchQueries(claim);
  const searches = await Promise.all(queries.map(q => googleNewsSearch(q.query)));
  const rawEvidence = searches.flatMap((items, i) => items.map(item => ({ ...item, searchType: queries[i].type })));
  const evidence = rankEvidence(claim, dedupeResults(rawEvidence)).slice(0, MAX_EVIDENCE_RESULTS);

  const factCandidates = evidence
    .filter(isLikelyFactCheck)
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
    .slice(0, MAX_FACTCHECK_ARTICLES);
  const explicitChecks = await inspectFactCheckArticles(claim, factCandidates);

  const evidenceCandidates = evidence
    .filter(x => !isLikelyFactCheck(x))
    .filter(x => (x.relevance || 0) >= 0.16)
    .slice(0, MAX_EVIDENCE_ARTICLES);
  const evidenceSignals = await inspectEvidenceArticles(claim, evidenceCandidates);

  const claimType = classifyClaimType(claim);
  const verdict = deriveVerdict(claim, factChecks, explicitChecks, evidence, evidenceSignals, claimType);

  return {
    claim,
    claimType,
    verdict: verdict.label,
    reason: verdict.reason,
    basis: verdict.basis,
    confidence: verdict.confidence,
    factChecks: factChecks.length ? factChecks : explicitChecks,
    evidence,
    evidenceSignals,
    caution: verdict.caution
  };
}
function buildSearchQueries(claim) {
  const compact = compactClaim(claim, 10);
  const compactShort = compactClaim(claim, 6);
  const quoted = quotePhrase(claim, 140);
  const numbers = (String(claim).match(/\d+(?:[.,]\d+)?%?/g) || []).slice(0, 4).join(" ");
  const numQuery = numbers ? ` ${numbers}` : "";
  return [
    { type: "factcheck", query: `${quoted} 팩트체크` },
    { type: "negative", query: `${compact} 거짓 허위 반박 사실아님` },
    { type: "positive", query: `${compact} 사실 확인 공식 발표` },
    { type: "specific", query: `${compactShort}${numQuery}` },
    { type: "general", query: compact }
  ];
}

function deriveVerdict(claim, factChecks, explicitChecks, evidence, evidenceSignals, claimType = classifyClaimType(claim)) {
  const factRatings = [
    ...factChecks.flatMap(x => x.reviews || []).map(r => normalizeRating(r.rating)),
    ...explicitChecks.map(x => x.rating)
  ].filter(Boolean);

  const falseCount = factRatings.filter(x => x === "false").length;
  const trueCount = factRatings.filter(x => x === "true").length;
  const mixedCount = factRatings.filter(x => x === "mixed").length;

  if (falseCount > 0 && trueCount === 0 && mixedCount === 0) {
    return verdict("반박됨", "검증 문서에서 이 주장에 대한 명시적 반박 판정을 확인했습니다.", "명시적 팩트체크 판정", "높음", "자동 판정은 참고용입니다. 해당 팩트체크 원문에서 날짜·범위·수치와 근거를 직접 확인하세요.");
  }
  if (trueCount > 0 && falseCount === 0 && mixedCount === 0) {
    return verdict("지지됨", "검증 문서에서 이 주장과 부합하는 명시적 사실 판정을 확인했습니다.", "명시적 팩트체크 판정", "높음", "지지됨은 모든 맥락에서 영구적으로 참이라는 뜻이 아닙니다. 검증 문서의 범위와 날짜를 확인하세요.");
  }
  if (mixedCount > 0 && falseCount === 0 && trueCount === 0) {
    return verdict("일부 사실·맥락 필요", "검증 문서가 주장 전체를 그대로 참 또는 거짓으로 보지 않고 일부 사실이나 맥락 보완이 필요하다고 판단합니다.", "명시적 혼합/부분 판정", "높음", "어떤 부분이 맞고 어떤 부분이 틀렸는지를 원문에서 확인하세요.");
  }
  if (factRatings.length && (falseCount || trueCount || mixedCount)) {
    return verdict("근거 충돌", "서로 다른 검증 자료에서 판정이 일치하지 않습니다. 출처의 범위와 조사 시점을 비교해야 합니다.", "복수 팩트체크 판정 충돌", "중간", "서로 다른 판정이 있을 때는 한쪽 제목만 보고 결론을 내리지 마세요.");
  }

  if (claimType === "의견·해석") {
    return verdict("의견·해석", "이 문장은 사실의 단순 서술보다 평가, 전망 또는 해석의 성격이 강해 객관적인 참·거짓 판정 대상으로 보기 어렵습니다.", "문장 성격 분석", "해당 없음", "문장 안의 구체적인 사실 주장만 따로 떼어 검증하면 더 정확합니다.");
  }

  const support = evidenceSignals.reduce((n, x) => n + x.support, 0);
  const contradict = evidenceSignals.reduce((n, x) => n + x.contradict, 0);
  const relevantSignals = evidenceSignals.filter(x => x.relevant);
  const matchedSources = relevantSignals.length;
  const strongSources = evidence.filter(x => isStrongSource(x.host)).length;
  const independentSupport = new Set(relevantSignals.filter(x => x.support >= 1.5).map(x => x.host || x.publisher || "").filter(Boolean)).size;
  const independentContradict = new Set(relevantSignals.filter(x => x.contradict >= 1.5).map(x => x.host || x.publisher || "").filter(Boolean)).size;

  if (independentSupport >= 2 && support >= 3 && support >= contradict + 1.5) {
    return verdict("지지 근거 다수", `서로 다른 출처 ${independentSupport}곳 이상에서 주장과 부합하는 사실 근거가 확인되었습니다.`, "복수 독립 출처의 일치 + 문장 근거", "중간", "여러 언론이 같은 원자료를 반복 인용했을 수도 있으므로 가능하면 1차 자료까지 확인하세요.");
  }
  if (independentContradict >= 2 && contradict >= 3 && contradict >= support + 1.5) {
    return verdict("반박 근거 다수", `서로 다른 출처 ${independentContradict}곳 이상에서 주장과 충돌하는 사실 근거가 확인되었습니다.`, "복수 독립 출처의 일치 + 문장 근거", "중간", "반박 출처의 조사 시점과 범위를 직접 확인하세요.");
  }
  if (support >= 2 && contradict >= 2) {
    return verdict("근거 충돌", "관련 문서에서 지지와 반박 신호가 함께 발견되어 한쪽으로 기울이기 어렵습니다.", "지지·반박 문서의 동시 발견", "중간", "출처의 날짜, 표본, 정의가 서로 다른지 확인하세요.");
  }
  if (support >= 2 && strongSources >= 1) {
    return verdict("지지 근거 있음", "관련 출처가 있고 공공기관·통계·1차 자료 성격의 출처에서 주장과 맞는 정보가 확인되었습니다.", "강한 출처 + 문장 근거", "중간", "원문 전체와 1차 자료의 날짜·범위를 확인하세요.");
  }
  if (contradict >= 2 && strongSources >= 1) {
    return verdict("반박 근거 있음", "관련 출처가 있고 강한 출처에서 주장과 충돌하는 정보가 확인되었습니다.", "강한 출처 + 문장 근거", "중간", "반박 문서의 조사 방법과 날짜를 직접 확인하세요.");
  }
  if (matchedSources >= 2 && support > contradict) {
    return verdict("지지 근거 있음", `관련 출처 ${matchedSources}곳에서 같은 방향의 사실 근거가 확인되었습니다.`, "관련 출처 교차 확인", "낮음~중간", "동일한 원자료를 반복 인용한 것인지 확인하세요.");
  }
  if (matchedSources >= 2 && contradict > support) {
    return verdict("반박 근거 있음", `관련 출처 ${matchedSources}곳에서 주장과 충돌하는 사실 근거가 확인되었습니다.`, "관련 출처 교차 확인", "낮음~중간", "반박 근거의 원문과 조사 시점을 확인하세요.");
  }
  if (matchedSources >= 1 || evidence.some(x => (x.relevance || 0) >= 0.24)) {
    return verdict("관련 근거 확인", "주장과 관련된 자료는 찾았지만 현재 자료만으로 참·거짓을 직접 확정하기에는 근거가 충분하지 않습니다.", "관련 자료 존재 + 직접 판정 부족", "낮음", "가능하면 주장에 포함된 숫자·날짜·기관·인물 등을 기준으로 1차 자료를 추가 확인하세요.");
  }
  return verdict("근거 부족", "주장과 충분히 관련된 자료를 찾지 못해 자동 판정을 만들 근거가 부족합니다.", "검색 근거 부족", "낮음", "검색어를 더 구체화하거나 특정 문장을 직접 입력해 보세요.");
}

function classifyClaimType(claim) {
  const s = cleanText(claim);
  const factMarkers = /(\d|%|억원|조원|명|년|월|발표|통계|조사|법률|법안|시행|출범|기록|증가|감소|확인|설립|폐지|선정|조사 결과)/u.test(s);
  const opinionMarkers = /(필요하다|해야 한다|바람직|우려|우려된다|기대|전망|가능성이|문제다|문제이다|좋다|나쁘다|중요하다|성공할|실패하면|신뢰|고질적인|저절로|반드시|결국|일 뿐|에 불과|못한다|되지 못한다|할 수 있다|할 수 없다)/u.test(s);
  if (opinionMarkers && !factMarkers) return "의견·해석";
  if (opinionMarkers && factMarkers) return "혼합 주장";
  return "사실 주장";
}
function verdict(label, reason, basis, confidence, caution) {
  return { label, reason, basis, confidence, caution };
}

async function inspectFactCheckArticles(claim, items) {
  const inspected = [];
  for (const item of items) {
    const doc = await fetchEvidenceDocument(item.url);
    if (!doc.text) continue;

    const claimReviews = extractClaimReviews(doc.raw);
    let accepted = false;
    for (const cr of claimReviews) {
      const similarity = claimSimilarity(claim, cr.claimReviewed);
      const rating = normalizeRating(cr.rating);
      if (rating && (similarity >= 0.25 || claimSimilarity(claim, item.title) >= 0.30)) {
        inspected.push({ claim: cr.claimReviewed || item.title, claimant: "", date: cr.date || item.date || "", reviews: [{ publisher: item.publisher || item.host || "", title: item.title, url: cr.url || item.url, date: cr.date || item.date || "", rating: cr.rating || "" }], rating, similarity: round(similarity) });
        accepted = true;
        break;
      }
    }
    if (accepted) continue;

    for (const window of conclusionWindows(doc.text, 80)) {
      const rating = detectExplicitRating(window);
      if (!rating) continue;
      const similarity = claimSimilarity(claim, window);
      const titleSimilarity = claimSimilarity(claim, item.title);
      const queryBackedFactcheck = item.searchType === "factcheck" && isLikelyFactCheck(item) && (item.relevance || 0) >= 0.26;
      if (similarity < 0.18 && titleSimilarity < 0.30 && !queryBackedFactcheck) continue;
      inspected.push({ claim: item.title, claimant: "", date: item.date || "", reviews: [{ publisher: item.publisher || item.host || "", title: item.title, url: item.url, date: item.date || "", rating: rating === "false" ? "사실 아님/반박" : rating === "true" ? "사실" : "부분 사실/혼합" }], rating, similarity: round(Math.max(similarity, titleSimilarity)) });
      break;
    }
  }
  return dedupeFactChecks(inspected);
}
async function inspectEvidenceArticles(claim, items) {
  const out = [];
  for (const item of items) {
    const text = await fetchEvidenceText(item.url);
    const analysis = analyzeEvidenceText(claim, [item.title || "", text || ""].filter(Boolean).join(" "));
    out.push({
      url: item.url,
      title: item.title,
      publisher: item.publisher || item.host || "",
      host: item.host || "",
      relevant: analysis.relevant,
      support: analysis.support,
      contradict: analysis.contradict,
      matchedSentences: analysis.matchedSentences.slice(0, 3)
    });
  }
  return out;
}

function analyzeEvidenceText(claim, text) {
  const sentences = splitSentences(cleanText(text));
  let support = 0, contradict = 0, relevant = false;
  const matchedSentences = [];
  const claimTokens = keywordTokens(claim);
  const claimNumbers = (String(claim).match(/\d+(?:[.,]\d+)?%?/g) || []);

  for (const sentence of sentences) {
    const sentenceTokens = keywordTokens(sentence);
    const sim = tokenOverlap(claimTokens, sentenceTokens);
    if (sim < 0.22) continue;
    relevant = true;
    const normalized = normalizeForMatch(sentence);
    const hasFalse = /사실이\s*(아니다|아님)|거짓|허위|오보|가짜|반박|사실과\s*다르|근거\s*없|사실무근|못한다|아니다|아닌\s|취소|부인/.test(normalized);
    const hasTrue = /사실로\s*(확인|판명)|사실\s*확인|사실이다|사실임|맞는\s*주장|공식적으로\s*(확인|발표)|확인됐다|발표됐다|발표했다|시행된다|시행됐다|출범한다|출범했다|기록했다|선정됐다|조사됐다|폐지된다|폐지됐다|공개됐다|공개했다|밝혔다/.test(normalized);
    const numeric = numericConsistency(claim, normalized);
    const numberMatch = numeric.matchedCount > 0;
    const strongSentence = isStrongSourceSentence(sentence);
    const factualVerb = /발표|출범|폐지|시행|선정|조사|기록|밝혔다|확인|공식/.test(normalized);
    const hardMismatch = numeric.hasMismatch;

    if (hasFalse && sim >= 0.28) { contradict += 2.5 + Math.min(1.5, sim * 1.5); matchedSentences.push(`반박 신호: ${sentence}`); }
    else if (hasTrue && sim >= 0.28 && !hardMismatch) { support += 2.5 + Math.min(1.5, sim * 1.5); matchedSentences.push(`지지 신호: ${sentence}`); }
    else if (hardMismatch && sim >= 0.42 && factualVerb) { contradict += 2.0 + Math.min(1.0, sim); matchedSentences.push(`수치·날짜 불일치: ${sentence}`); }
    else if (numberMatch && numeric.coverage >= 1 && sim >= 0.42 && (strongSentence || factualVerb)) { support += 1.8; matchedSentences.push(`수치·날짜 근거: ${sentence}`); }
    else if (!claimNumbers.length && sim >= 0.68 && (strongSentence || /발표|출범|폐지|시행|선정|조사|기록|밝혔다|공식/.test(normalized))) { support += 1.5; matchedSentences.push(`직접 부합 근거: ${sentence}`); }
    else if (sim >= 0.76 && !hasFalse) { support += 1.0; matchedSentences.push(`높은 문장 일치: ${sentence}`); }
    else { matchedSentences.push(`관련 문장: ${sentence}`); }
  }
  return { support: Math.round(support * 10) / 10, contradict: Math.round(contradict * 10) / 10, relevant, matchedSentences };
}
function isStrongSourceSentence(sentence) {
  return /공식|통계|발표|보고서|조사|연구|정부|기관|자료|기준/.test(sentence);
}

function numericConsistency(claimText, sentence) {
  const claimFacts = extractNumericFacts(claimText);
  const sourceFacts = extractNumericFacts(sentence);
  const sourceNumbers = new Set((String(sentence).match(/\d+(?:[.,]\d+)?%?/g) || []).map(normalizeNumberToken));
  const claimNumbers = (String(claimText).match(/\d+(?:[.,]\d+)?%?/g) || []).map(normalizeNumberToken);

  let matchedCount = 0;
  let mismatchCount = 0;
  for (const cf of claimFacts) {
    const sameUnit = sourceFacts.filter(sf => sf.unit === cf.unit);
    if (sameUnit.length) {
      if (sameUnit.some(sf => sf.value === cf.value)) matchedCount++;
      else mismatchCount++;
      continue;
    }
    if (sourceNumbers.has(cf.value)) matchedCount++;
  }

  // A number is considered contradictory only when the source gives a different
  // value for the same explicit unit, e.g. 1위 vs 2위 or 10월 1일 vs 10월 2일.
  return {
    matchedCount,
    hasNumbers: sourceNumbers.size > 0 || sourceFacts.length > 0,
    hasMismatch: mismatchCount > 0,
    coverage: claimFacts.length ? matchedCount / claimFacts.length : 1
  };
}

function extractNumericFacts(text) {
  const facts = [];
  const normalized = cleanText(text);
  const re = /(\d+(?:[.,]\d+)?%?)\s*(년|월|일|개|명|곳|위|억|조|만|천만|백만|만명|조원|억원|%)/gu;
  for (const m of normalized.matchAll(re)) {
    facts.push({ value: normalizeNumberToken(m[1]), unit: m[2] });
  }
  return facts;
}

function normalizeNumberToken(value) {
  return String(value || "").replace(/,/g, "").trim();
}

function extractClaimReviews(htmlOrText) {
  const results = [];
  const scripts = String(htmlOrText).match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const raw = script.replace(/^.*?>/, "").replace(/<\/script>\s*$/i, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    walkJson(parsed, obj => {
      if (!obj || typeof obj !== "object") return;
      const type = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
      if (!type.includes("ClaimReview")) return;
      const rr = obj.reviewRating || {};
      results.push({
        claimReviewed: obj.claimReviewed || obj.itemReviewed?.claimReviewed || "",
        rating: rr.alternateName || rr.name || rr.ratingValue || "",
        url: obj.url || "",
        date: obj.datePublished || obj.dateModified || ""
      });
    });
  }
  return results;
}

function walkJson(value, fn) {
  fn(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, fn);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) walkJson(v, fn);
  }
}

function conclusionWindows(text, maxSentences = 80) {
  const normalized = cleanText(text);
  const sentences = splitSentences(normalized);
  const keys = /(결론|판정|팩트체크\s*결과|사실확인|검증\s*결과|따져보면|확인해보니|확인해\s*본\s*결과|실제로는|확인\s*결과)/;
  const windows = [];
  for (let i = 0; i < Math.min(sentences.length, maxSentences); i++) {
    if (keys.test(sentences[i])) windows.push(sentences.slice(Math.max(0, i - 1), Math.min(sentences.length, i + 4)).join(" "));
    const rating = detectExplicitRating(sentences[i]);
    if (rating) windows.push(sentences[i]);
  }
  if (!windows.length) return sentences.slice(0, Math.min(20, sentences.length));
  return windows.slice(0, 20);
}
function isLikelyFactCheck(item) {
  const blob = `${item.title || ""} ${item.publisher || ""} ${item.host || ""}`.toLowerCase();
  return /팩트체크|사실확인|사실 확인|검증|fact ?check|factcheck|사실체크/.test(blob)
    || /afp\.com|factcheck\.org|snopes\.com|politifact\.com|snu\.ac\.kr/.test(item.host || "");
}

function detectExplicitRating(text) {
  const s = normalizeForMatch(text);
  if (!s) return null;
  if (/(사실이\s*(아니다|아님)|사실\s*아님|거짓|허위|오보|가짜|틀린\s*주장|잘못된\s*주장|근거\s*없|사실무근|반박|사실과\s*다르|허위정보|거짓정보)/i.test(s)) return "false";
  if (/(일부\s*사실|부분적으로\s*사실|절반의\s*사실|half true|mixed|과장된\s*주장|맥락이\s*필요|오해의\s*소지)/i.test(s)) return "mixed";
  if (/(사실로\s*(확인|판명)|사실\s*확인|맞는\s*주장|사실이다|사실임|true|mostly true|공식적으로\s*(확인|발표))/i.test(s)) return "true";
  return null;
}

function normalizeRating(rating) {
  const s = normalizeForMatch(rating).toLowerCase();
  if (!s) return null;
  if (/false|mostly false|pants on fire|거짓|허위|사실 아님|반박|오보/.test(s)) return "false";
  if (/half true|mixed|일부 사실|부분|절반|과장/.test(s)) return "mixed";
  if (/true|mostly true|사실|확인됨|사실임|맞음/.test(s)) return "true";
  return null;
}

async function fetchEvidenceDocument(url) {
  if (!/^https?:\/\//i.test(url || "")) return { raw: "", text: "" };
  try {
    const res = await fetchWithTimeout(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 FactCheckerFree/3.0",
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
    if (!res.ok) return { raw: "", text: "" };
    const raw = await readLimitedText(res, 500000);
    const text = /<html|<article|<main/i.test(raw) ? extractReadableText(raw) : cleanText(raw);
    return { raw, text: text.slice(0, 50000) };
  } catch {
    return { raw: "", text: "" };
  }
}

async function fetchEvidenceText(url) {
  const doc = await fetchEvidenceDocument(url);
  return doc.text;
}

async function searchGoogleFactChecks(query, key) {
  const endpoint = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
  endpoint.searchParams.set("query", trimForSearch(query));
  endpoint.searchParams.set("languageCode", "ko");
  endpoint.searchParams.set("pageSize", "5");
  endpoint.searchParams.set("key", key);

  try {
    const res = await fetch(endpoint, { headers: { "accept": "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.claims || []).map(c => ({
      claim: c.text || "",
      claimant: c.claimant || "",
      date: c.claimDate || "",
      reviews: (c.claimReview || []).map(r => ({
        publisher: r.publisher?.name || r.publisher?.site || "",
        title: r.title || "",
        url: r.url || "",
        date: r.reviewDate || "",
        rating: r.textualRating || ""
      }))
    }));
  } catch {
    return [];
  }
}

async function googleNewsSearch(query) {
  const u = new URL("https://news.google.com/rss/search");
  u.searchParams.set("q", query);
  u.searchParams.set("hl", "ko");
  u.searchParams.set("gl", "KR");
  u.searchParams.set("ceid", "KR:ko");

  try {
    const res = await fetch(u, {
      headers: {
        "user-agent": "Mozilla/5.0 FactCheckerFree/3.0",
        "accept": "application/rss+xml, application/xml, text/xml"
      }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml);
  } catch {
    return [];
  }
}

function parseRss(xml) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items.slice(0, 8)) {
    const title = xmlTag(item, "title");
    const link = xmlTag(item, "link");
    const pubDate = xmlTag(item, "pubDate");
    const source = xmlTag(item, "source");
    const sourceUrl = xmlAttr(item, "source", "url");
    const publisher = decodeXml(source || "");
    const host = hostFromUrl(sourceUrl || link);
    if (title && link) {
      out.push({
        title: decodeXml(title),
        url: decodeXml(link),
        date: pubDate ? decodeXml(pubDate) : "",
        publisher,
        host,
        sourceUrl: sourceUrl || "",
        type: "web-search"
      });
    }
  }
  return out;
}

function rankEvidence(claim, items) {
  return items.map(item => ({
    ...item,
    relevance: evidenceRelevance(claim, item)
  })).sort((a, b) => b.relevance - a.relevance);
}

function evidenceRelevance(claim, item) {
  const titleSim = claimSimilarity(claim, item.title || "");
  const hostBonus = isStrongSource(item.host) ? 0.12 : 0;
  const factBonus = isLikelyFactCheck(item) ? 0.18 : 0;
  const queryBonus = item.searchType === "factcheck" ? 0.12 : 0;
  return Math.min(1, titleSim + hostBonus + factBonus + queryBonus);
}

function claimSimilarity(a, b) {
  const aa = keywordTokens(a);
  const bb = keywordTokens(b);
  return tokenOverlap(aa, bb);
}

function tokenOverlap(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(1, Math.min(A.size, B.size));
}

function keywordTokens(text) {
  return compactTokens(text)
    .map(stemKoreanToken)
    .filter(t => !SEARCH_STOPWORDS.has(t) && t.length >= 2)
    .slice(0, 30);
}

function stemKoreanToken(token) {
  let t = String(token || "").trim();
  if (!t) return "";
  // 검색어의 조사/활용형 차이 때문에 같은 단어가 서로 다른 토큰이 되는 문제를 줄입니다.
  t = t.replace(/(되었습니다|되었다|하였다|하였다|했어요|했다|한다|된다|됐다|이다|이라는|이라고|이라고는|있다|없다)$/u, "");
  t = t.replace(/(으로|에서|에게|까지|부터|처럼|보다|만|도|와|과|로|으로|의|에|이|가|을|를|은|는)$/u, "");
  return t;
}

function compactClaim(claim, maxTokens = 9) {
  const tokens = keywordTokens(claim);
  if (!tokens.length) return cleanText(claim).slice(0, 100);
  return tokens.slice(0, maxTokens).join(" ");
}

function quotePhrase(claim, max = 110) {
  const s = cleanText(claim).replace(/["']/g, "");
  return JSON.stringify(s.slice(0, max));
}

function compactTokens(text) {
  return cleanText(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[“”‘’"'`]/g, " ")
    .split(/\s+/)
    .map(t => t.replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu, ""))
    .filter(Boolean);
}

function dedupeResults(items) {
  const seen = new Set();
  return items.filter(x => {
    const key = (x.url || "") + "|" + (x.title || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeFactChecks(items) {
  const seen = new Set();
  return items.filter(x => {
    const key = (x.reviews?.[0]?.url || "") + "|" + x.rating + "|" + (x.claim || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isStrongSource(host = "") {
  const h = host.toLowerCase();
  return /(^|\.)gov\.kr$|(^|\.)go\.kr$|(^|\.)korea\.kr$|(^|\.)kostat\.go\.kr$|(^|\.)kosis\.kr$|(^|\.)bok\.or\.kr$|(^|\.)who\.int$|(^|\.)un\.org$|(^|\.)nasa\.gov$|(^|\.)reuters\.com$|(^|\.)apnews\.com$/.test(h);
}

function cleanText(s) {
  return decodeXml(String(s || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForMatch(s) {
  return cleanText(String(s || "")).replace(/[()\[\]{}:;,/|]/g, " ");
}

function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function trimForSearch(s) {
  return cleanText(s).slice(0, 220);
}

function hostFromUrl(url) {
  try { return new URL(decodeXml(url)).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function safeHost(url) { return hostFromUrl(url); }

function round(n) { return Math.round(n * 100) / 100; }

async function fetchArticle(sourceUrl) {
  let u;
  try { u = new URL(sourceUrl); } catch { throw new Error("URL 형식이 올바르지 않습니다."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("http 또는 https URL만 사용할 수 있습니다.");
  if (isPrivateOrLocalHost(u.hostname)) throw new Error("내부 또는 로컬 주소는 읽을 수 없습니다.");

  let direct = null;
  try {
    direct = await fetchWithTimeout(u.href, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 FactCheckerFree/3.0",
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
  } catch { direct = null; }

  if (direct?.ok) {
    const html = await readLimitedText(direct, MAX_HTML);
    const text = extractReadableText(html);
    if (text.length >= 120) return { title: extractTitle(html), text, method: "direct" };
  }

  const readerUrl = JINA_READER + encodeURIComponent(u.href);
  let reader = null;
  try {
    reader = await fetchWithTimeout(readerUrl, {
      headers: {
        "accept": "text/plain,text/markdown;q=0.9,*/*;q=0.5",
        "x-engine": "browser",
        "x-timeout": "15"
      }
    });
  } catch { reader = null; }
  if (reader?.ok) {
    const content = cleanText(await readLimitedText(reader, MAX_TEXT));
    if (content.length >= 120) return { title: titleFromReader(content) || u.hostname, text: content, method: "jina-reader" };
  }

  const directStatus = direct ? `직접 읽기 HTTP ${direct.status}` : "직접 읽기 실패/시간초과";
  const readerStatus = reader ? `보조 읽기 HTTP ${reader.status}` : "보조 읽기 실패/시간초과";
  throw new Error(`${directStatus}; ${readerStatus}`);
}

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

async function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("요청 시간이 초과되었습니다.");
    throw err;
  } finally { clearTimeout(timer); }
}

async function readLimitedText(res, limit) {
  const text = await res.text();
  return text.slice(0, limit);
}

function titleFromReader(content) {
  const lines = content.split(/\n+/).map(x => x.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t.length >= 4 && t.length <= 220 && !/^https?:\/\//i.test(t)) return t;
  }
  return "";
}

function extractReadableText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ")
       .replace(/<style[\s\S]*?<\/style>/gi, " ")
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
       .replace(/<svg[\s\S]*?<\/svg>/gi, " ");

  const candidates = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]+(?:id|class)=["'][^"']*(?:article|content|entry-content|post-content|news-article|view-content|article-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  ];
  let match = null;
  for (const re of candidates) {
    const m = s.match(re);
    if (m && m[1] && m[1].length > 120) { match = m[1]; break; }
  }
  const chosen = match || s;
  return cleanText(chosen.replace(/<[^>]+>/g, " "));
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanText(decodeXml(m[1])) : "";
}

function extractClaims(text, max = 4) {
  const sentences = splitSentences(text)
    .map(s => cleanText(s))
    .filter(s => s.length >= 25 && s.length <= 420);
  const scored = sentences.map((s, i) => ({ s, i, score: claimScore(s) }));
  return scored.sort((a,b) => b.score - a.score || a.i - b.i).slice(0, max).map(x => x.s);
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+|(?<=다\.)\s+|(?<=요\.)\s+/);
}

function claimScore(s) {
  let score = 0;
  if (/\d/.test(s)) score += 3;
  if (/(명|만|억|조|%|년|월|일|배|증가|감소|최초|세계|전국|공식|발표|연구|통계|기록|확인)/.test(s)) score += 3;
  if (/(이다|있다|없다|됐다|발생|증가했다|감소했다|기록했다|발견됐다|확인됐다|발표했다)/.test(s)) score += 2;
  if (s.includes("?") || /해야|좋다|나쁘다|문제다/.test(s)) score -= 2;
  return score;
}

function xmlAttr(s, tag, attr) {
  const m = s.match(new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, "i"));
  return m ? decodeXml(m[1]) : "";
}

function xmlTag(s, tag) {
  const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
