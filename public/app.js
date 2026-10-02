const $ = (id) => document.getElementById(id);
const methodScreen = $("methodScreen");
const checkScreen = $("checkScreen");
const heroText = $("heroText");
const backButton = $("backToMethods");
const selectedIcon = $("selectedIcon");
const selectedLabel = $("selectedLabel");
const selectedDescription = $("selectedDescription");
const urlField = $("urlField");
const textField = $("textField");
const claimField = $("claimField");
const urlEl = $("url"), textEl = $("text"), claimEl = $("claim"), button = $("check"), statusEl = $("status"), resultEl = $("result");

const METHODS = {
  url: {
    icon: "🔗",
    label: "자료 주소로 검증",
    description: "웹페이지의 원문을 불러와 핵심 주장을 검증합니다.",
    placeholder: "https://..."
  },
  text: {
    icon: "📄",
    label: "본문을 붙여넣어 검증",
    description: "붙여넣은 본문에서 검증할 핵심 주장을 찾아 확인합니다.",
    placeholder: "뉴스 기사, 블로그 글, SNS 글 등을 붙여넣으세요."
  },
  claim: {
    icon: "🎯",
    label: "특정 문장만 검증",
    description: "확인하고 싶은 주장 한 문장을 집중적으로 검증합니다.",
    placeholder: "예: 2025년에 국내 전기차 판매량은 전년보다 20% 증가했다."
  }
};

let currentMode = null;

document.querySelectorAll(".method-card").forEach(card => {
  card.addEventListener("click", () => selectMode(card.dataset.mode));
});

backButton.addEventListener("click", () => {
  checkScreen.classList.add("hidden");
  methodScreen.classList.remove("hidden");
  heroText.textContent = "검증할 방법을 선택하면 그 방식에 맞는 화면으로 이동합니다.";
  statusEl.className = "status hidden";
  resultEl.classList.add("hidden");
});

function selectMode(mode) {
  currentMode = mode;
  const config = METHODS[mode];
  selectedIcon.textContent = config.icon;
  selectedLabel.textContent = config.label;
  selectedDescription.textContent = config.description;

  urlField.classList.toggle("hidden", mode !== "url");
  textField.classList.toggle("hidden", mode !== "text");
  claimField.classList.toggle("hidden", mode !== "claim");

  methodScreen.classList.add("hidden");
  checkScreen.classList.remove("hidden");
  resultEl.classList.add("hidden");
  statusEl.className = "status hidden";
  heroText.textContent = `${config.label}을 선택했습니다. 자료를 넣고 검증을 시작하세요.`;

  if (mode === "url") setTimeout(() => urlEl.focus(), 50);
  if (mode === "text") setTimeout(() => textEl.focus(), 50);
  if (mode === "claim") setTimeout(() => claimEl.focus(), 50);
}

button.addEventListener("click", async () => {
  if (!currentMode) return;

  const payload = { url: "", text: "", claim: "" };
  if (currentMode === "url") payload.url = urlEl.value.trim();
  if (currentMode === "text") payload.text = textEl.value.trim();
  if (currentMode === "claim") payload.claim = claimEl.value.trim();

  if (!payload.url && !payload.text && !payload.claim) {
    showStatus("먼저 검증할 자료를 입력해 주세요.", "error");
    return;
  }

  button.disabled = true;
  resultEl.classList.add("hidden");
  showStatus("자료를 읽고 관련 근거를 찾는 중입니다…", "success");

  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`서버가 예상하지 못한 응답을 보냈습니다. HTTP ${res.status}`);
    }
    if (!data.ok) {
      showStatus(data.error || "검증에 실패했습니다.", "error");
      if (data.suggestion) showStatus(`${data.error} ${data.suggestion}`, "error");
      return;
    }
    render(data);
    const readMethod = data.fetched?.method === "jina-reader" ? "보조 원문 읽기" : "원문 직접 읽기";
    showStatus(`${data.results.length}개의 주장에 대해 검증 결과를 만들었습니다.${data.fetched ? ` (${readMethod})` : ""}`, "success");
  } catch (e) {
    showStatus(e.message || "오류가 발생했습니다.", "error");
  } finally {
    button.disabled = false;
  }
});

function showStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

function render(data) {
  resultEl.classList.remove("hidden");
  const sourceInfo = data.fetched
    ? `<div class="meta">불러온 출처: <b>${esc(data.fetched.host)}</b>${data.fetched.title ? ` · ${esc(data.fetched.title)}` : ""}${data.fetched.method === "jina-reader" ? " · 보조 읽기 사용" : ""}</div>`
    : `<div class="meta">사용자 입력 자료를 대상으로 검증했습니다.</div>`;

  let html = `<div class="summary"><strong>검증 결과</strong>${sourceInfo}<div class="caution">${esc(data.note)}</div></div>`;
  data.results.forEach((r, i) => {
    const cls = r.verdict.includes("반박") ? "false" : r.verdict.includes("지지") ? "true" : r.verdict.includes("일부") ? "mixed" : "";
    html += `<article class="claim-card"><p class="claim">${i + 1}. ${esc(r.claim)}</p><span class="verdict ${cls}">${esc(r.verdict)}</span><div class="meta"><b>판정 이유:</b> ${esc(r.reason)}<br><b>판정 근거:</b> ${esc(r.basis)}</div>`;
    html += `<div class="sources"><div class="source-group"><h3>확인된 팩트체크 신호</h3>${renderFactChecks(r.factChecks)}</div><div class="source-group"><h3>관련 웹 검색 결과</h3>${renderEvidence(r.evidence)}</div></div>`;
    html += `<div class="caution">${esc(r.caution)}</div></article>`;
  });
  resultEl.innerHTML = html;
}

function renderFactChecks(items) {
  if (!items.length) return `<div class="empty">명시적인 팩트체크 판정 자료를 찾지 못했습니다. 이것만으로 거짓이라고 판단하지 않습니다.</div>`;
  return items.map(item => `<div class="source"><div><b>${esc(item.claim || "관련 주장")}</b></div>${(item.reviews || []).map(rv => `<div style="margin-top:7px"><a href="${safeUrl(rv.url)}" target="_blank" rel="noopener noreferrer">${esc(rv.title || rv.publisher || rv.url)}</a><div class="host">${esc(rv.publisher || "")} · ${esc(rv.date || "")}</div><div class="rating">판정: ${esc(rv.rating || "표기 없음")}</div></div>`).join("")}</div>`).join("");
}

function renderEvidence(items) {
  if (!items.length) return `<div class="empty">관련 웹 검색 결과가 없습니다.</div>`;
  return items.map(x => `<div class="source"><a href="${safeUrl(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a><div class="host">${esc(x.host || x.publisher || "")} · ${esc(x.date || "")}</div></div>`).join("");
}

function safeUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "http:" && x.protocol !== "https:") return "#";
    return x.href;
  } catch {
    return "#";
  }
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
