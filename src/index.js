const APP_NAME = "근거 기반 자료 검증기";
const MAX_TEXT = 18000;
const MAX_CLAIMS = 5;
const MAX_HTML = 1400000;
const FETCH_TIMEOUT_MS = 15000;
const JINA_READER = "https://r.jina.ai/";
const MAX_FACTCHECK_ARTICLES = 2;
const MAX_EVIDENCE_RESULTS = 12;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, app: APP_NAME, version: "1.2-evidence" });
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
          const result = await verifyClaim(claim, env);
          results.push(result);
        }

        return json({
          ok: true,
          app: APP_NAME,
          fetched: fetched ? { url: sourceUrl, title: fetched.title, host: safeHost(sourceUrl), method: fetched.method || "direct" } : null,
          claims,
          results,
          note: "이 도구는 자동 판정 보조 도구입니다. 검색 결과와 원문을 직접 확인하세요."
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

  const searches = await Promise.all([
    googleNewsSearch(`${trimForSearch(claim)} 팩트체크`),
    googleNewsSearch(trimForSearch(claim)),
    googleNewsSearch(`${trimForSearch(claim)} 사실 거짓 반박`)
  ]);

  const factSearch = dedupeResults(searches[0]);
  const evidence = dedupeResults(searches.flat()).slice(0, MAX_EVIDENCE_RESULTS);

  // API key가 없어도 무료 RSS 결과의 '팩트체크 기사 제목 + 원문'에서
  // 명시적인 판정 표현을 찾아 1차 판정을 만들 수 있게 합니다.
  const explicitChecks = await inspectFactCheckArticles(factSearch);
  const allFactSignals = [...explicitChecks, ...factChecks];
  const verdict = deriveVerdict(factChecks, evidence, explicitChecks);

  return {
    claim,
    verdict: verdict.label,
    reason: verdict.reason,
    basis: verdict.basis,
    factChecks: factChecks.length ? factChecks : explicitChecks,
    evidence,
    factSignals: explicitChecks,
    caution: verdict.caution
  };
}

function deriveVerdict(factChecks, evidence, explicitChecks = []) {
  const ratings = [
    ...factChecks.flatMap(x => x.reviews || []).map(r => normalizeRating(r.rating)),
    ...explicitChecks.map(x => x.rating)
  ].filter(Boolean);

  const falseCount = ratings.filter(x => x === "false").length;
  const trueCount = ratings.filter(x => x === "true").length;
  const mixedCount = ratings.filter(x => x === "mixed").length;

  if (falseCount >= 1 && falseCount >= trueCount && falseCount >= mixedCount) {
    return {
      label: "반박됨",
      reason: "관련 팩트체크 자료에서 이 주장에 대한 명시적인 반박 판정 신호가 확인되었습니다.",
      basis: "팩트체크 자료의 명시적 판정 표현",
      caution: "자동 판정은 참고용입니다. 원문과 팩트체크 기사에서 날짜, 수치, 인용 맥락을 직접 확인하세요."
    };
  }
  if (trueCount >= 1 && trueCount > falseCount && trueCount >= mixedCount) {
    return {
      label: "지지되는 근거 있음",
      reason: "관련 팩트체크 자료에서 이 주장과 부합하는 명시적 사실 판정 신호가 확인되었습니다.",
      basis: "팩트체크 자료의 명시적 판정 표현",
      caution: "'지지되는 근거 있음'은 모든 맥락에서 절대적으로 참이라는 뜻이 아닙니다. 날짜와 범위를 확인하세요."
    };
  }
  if (mixedCount >= 1) {
    return {
      label: "일부만 맞을 가능성",
      reason: "관련 팩트체크 자료에서 부분 사실·혼합 판정 신호가 확인되었습니다.",
      basis: "팩트체크 자료의 명시적 판정 표현",
      caution: "주장의 일부만 맞거나 표현이 과장되었을 수 있습니다. 검증 기사에서 어떤 부분이 맞고 틀린지 확인하세요."
    };
  }

  const strong = evidence.filter(x => isStrongSource(x.host));
  const distinctHosts = new Set(evidence.map(x => x.host).filter(Boolean));

  // 기존에는 '강한 출처 2개'라는 매우 좁은 조건만 사용해서,
  // 검색 결과가 있어도 거의 전부 '판단 보류'가 되었습니다.
  // 이제는 직접 판정을 찾지 못했더라도 실제 관련 자료가 여러 개면
  // '추가 확인 필요'로 올려 사용자가 근거를 볼 수 있게 합니다.
  if (strong.length >= 1 || distinctHosts.size >= 2 || evidence.length >= 3) {
    return {
      label: "추가 확인 필요",
      reason: `직접적인 사실/거짓 판정은 확인되지 않았지만 관련 자료 ${evidence.length}건에서 추가 확인할 근거를 찾았습니다.`,
      basis: "복수 웹 자료와 출처 교차 확인 필요",
      caution: "검색 결과의 제목이나 검색 순위만으로 참·거짓을 확정하지 않습니다. 핵심 수치와 원문 근거를 직접 대조하세요."
    };
  }

  return {
    label: "판단 보류",
    reason: "관련 자료 자체를 충분히 찾지 못해 자동 판정을 만들기 어렵습니다.",
    basis: "근거 부족",
    caution: "판단 보류는 거짓이라는 뜻이 아닙니다. 검색어를 더 구체화하거나 다른 출처를 추가하세요."
  };
}

async function inspectFactCheckArticles(items) {
  const candidates = items
    .filter(isLikelyFactCheck)
    .slice(0, MAX_FACTCHECK_ARTICLES);

  const inspected = [];
  for (const item of candidates) {
    const text = await fetchEvidenceText(item.url);
    const sourceText = `${item.title}\n${text || ""}`;
    const rating = detectExplicitRating(sourceText);
    if (!rating) continue;
    inspected.push({
      claim: item.title,
      claimant: "",
      date: item.date || "",
      reviews: [{
        publisher: item.publisher || item.host || "",
        title: item.title,
        url: item.url,
        date: item.date || "",
        rating: rating === "false" ? "사실 아님/반박" : rating === "true" ? "사실" : "부분 사실/혼합"
      }],
      rating
    });
  }
  return inspected;
}

function isLikelyFactCheck(item) {
  const blob = `${item.title || ""} ${item.publisher || ""} ${item.host || ""}`.toLowerCase();
  return /팩트체크|사실확인|검증|fact ?check|factcheck/.test(blob)
    || /factcheckkorea\.afp\.com|factcheck\.org|snopes\.com|politifact\.com|factcheck\.snu\.ac\.kr/.test(item.host || "");
}

function detectExplicitRating(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return null;

  // 부정 표현을 먼저 검사해 '사실'이라는 단어가 함께 있어도 잘못 긍정하지 않도록 합니다.
  if (/(사실이\s*(아니다|아님)|사실\s*아님|거짓|허위|오보|가짜|틀린\s*주장|잘못된\s*주장|근거\s*없|사실무근|반박|사실과\s*다르|허위정보|거짓정보)/i.test(s)) return "false";
  if (/(일부\s*사실|부분적으로\s*사실|절반의\s*사실|대체로\s*사실|과장된\s*주장|맥락이\s*필요|오해의\s*소지)/i.test(s)) return "mixed";
  if (/(사실로\s*(확인|판명)|사실\s*확인|맞는\s*주장|사실이다|사실임|대체로\s*사실)/i.test(s)) return "true";
  return null;
}

async function fetchEvidenceText(url) {
  if (!/^https?:\/\//i.test(url || "")) return "";
  try {
    const res = await fetchWithTimeout(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 FactCheckerFree/2.0",
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
    if (!res.ok) return "";
    const raw = await readLimitedText(res, 120000);
    const text = /<html|<article|<main/i.test(raw) ? extractReadableText(raw) : cleanText(raw);
    return text.slice(0, 30000);
  } catch {
    return "";
  }
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
        "user-agent": "Mozilla/5.0 FactCheckerFree/1.0",
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

function xmlAttr(s, tag, attr) {
  const m = s.match(new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, "i"));
  return m ? decodeXml(m[1]) : "";
}

function xmlTag(s, tag) {
  const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

async function fetchArticle(sourceUrl) {
  let u;
  try { u = new URL(sourceUrl); } catch { throw new Error("URL 형식이 올바르지 않습니다."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("http 또는 https URL만 사용할 수 있습니다.");

  let direct = null;
  try {
    direct = await fetchWithTimeout(u.href, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 FactCheckerFree/2.0",
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
  } catch {
    direct = null;
  }

  if (direct?.ok) {
    const html = await readLimitedText(direct, MAX_HTML);
    const text = extractReadableText(html);
    if (text.length >= 120) {
      return { title: extractTitle(html), text, method: "direct" };
    }
  }

  // Many news/government sites block server-side scraping or render the article with JavaScript.
  // Jina Reader is a free basic URL reader and is used only as a fallback.
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
  } catch {
    reader = null;
  }
  if (reader?.ok) {
    const content = cleanText(await readLimitedText(reader, MAX_TEXT));
    if (content.length >= 120) {
      return { title: titleFromReader(content) || u.hostname, text: content, method: "jina-reader" };
    }
  }

  const directStatus = direct ? `직접 읽기 HTTP ${direct.status}` : "직접 읽기 실패/시간초과";
  const readerStatus = reader ? `보조 읽기 HTTP ${reader.status}` : "보조 읽기 실패/시간초과";
  throw new Error(`${directStatus}; ${readerStatus}`);
}

async function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("요청 시간이 초과되었습니다.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
    /<div[^>]+(?:id|class)=["'][^"']*(?:article|content|entry-content|post-content|news-article|view-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
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

function extractClaims(text, max = 5) {
  const sentences = splitSentences(text)
    .map(s => cleanText(s))
    .filter(s => s.length >= 25 && s.length <= 420);

  const scored = sentences.map((s, i) => ({ s, i, score: claimScore(s) }));
  return scored.sort((a,b) => b.score - a.score || a.i - b.i).slice(0, max).map(x => x.s);
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+|(?<=다\.)\s+|(?<=요\.)\s+/);
}

function claimScore(s) {
  let score = 0;
  if (/\d/.test(s)) score += 3;
  if (/(명|만|억|조|%|년|월|일|배|증가|감소|최초|세계|전국|공식|발표|연구|통계|따르면|기록|확인)/.test(s)) score += 3;
  if (/(이다|있다|없다|됐다|발생|증가했다|감소했다|기록했다|발견됐다|확인됐다|발표했다)/.test(s)) score += 2;
  if (s.includes("?") || /해야|좋다|나쁘다|문제다/.test(s)) score -= 2;
  return score;
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

function isStrongSource(host = "") {
  const h = host.toLowerCase();
  return /(^|\.)gov\.kr$|(^|\.)go\.kr$|(^|\.)korea\.kr$|(^|\.)kostat\.go\.kr$|(^|\.)kosis\.kr$|(^|\.)kdca\.go\.kr$|(^|\.)bok\.or\.kr$|(^|\.)who\.int$|(^|\.)un\.org$|(^|\.)nasa\.gov$|(^|\.)reuters\.com$|(^|\.)apnews\.com$/.test(h);
}

function cleanText(s) {
  return decodeXml(String(s || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
