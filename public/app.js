const $ = (id) => document.getElementById(id);
const urlEl = $("url"), textEl = $("text"), claimEl = $("claim"), button = $("check"), statusEl = $("status"), resultEl = $("result");

button.addEventListener("click", async () => {
  button.disabled = true;
  resultEl.classList.add("hidden");
  showStatus("자료를 읽고 관련 근거를 찾는 중입니다…", "success");
  try {
    const res = await fetch("/api/check", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ url:urlEl.value.trim(), text:textEl.value.trim(), claim:claimEl.value.trim() }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "검증에 실패했습니다.");
    render(data);
    showStatus(`${data.results.length}개의 주장에 대해 검증 결과를 만들었습니다.`, "success");
  } catch (e) {
    showStatus(e.message || "오류가 발생했습니다.", "error");
  } finally { button.disabled = false; }
});

function showStatus(msg, kind){ statusEl.textContent = msg; statusEl.className = `status ${kind}`; }

function render(data){
  resultEl.classList.remove("hidden");
  const sourceInfo = data.fetched ? `<div class="meta">불러온 출처: <b>${esc(data.fetched.host)}</b>${data.fetched.title ? ` · ${esc(data.fetched.title)}` : ""}</div>` : `<div class="meta">사용자 입력 자료를 대상으로 검증했습니다.</div>`;
  let html = `<div class="summary"><strong>검증 결과</strong>${sourceInfo}<div class="caution">${esc(data.note)}</div></div>`;
  data.results.forEach((r, i) => {
    const cls = r.verdict.includes("반박") ? "false" : r.verdict.includes("지지") ? "true" : r.verdict.includes("일부") ? "mixed" : "";
    html += `<article class="claim-card"><p class="claim">${i+1}. ${esc(r.claim)}</p><span class="verdict ${cls}">${esc(r.verdict)}</span><div class="meta"><b>판정 이유:</b> ${esc(r.reason)}<br><b>판정 근거:</b> ${esc(r.basis)}</div>`;
    html += `<div class="sources"><div class="source-group"><h3>기존 팩트체크 자료</h3>${renderFactChecks(r.factChecks)}</div><div class="source-group"><h3>관련 웹 검색 결과</h3>${renderEvidence(r.evidence)}</div></div>`;
    html += `<div class="caution">${esc(r.caution)}</div></article>`;
  });
  resultEl.innerHTML = html;
}

function renderFactChecks(items){
  if (!items.length) return `<div class="empty">일치하는 기존 팩트체크 자료를 찾지 못했습니다. 검색 결과가 없다고 해서 거짓이라는 뜻은 아닙니다.</div>`;
  return items.map(item => `<div class="source"><div><b>${esc(item.claim || "관련 주장")}</b></div>${(item.reviews||[]).map(rv => `<div style="margin-top:7px"><a href="${safeUrl(rv.url)}" target="_blank" rel="noopener noreferrer">${esc(rv.title || rv.publisher || rv.url)}</a><div class="host">${esc(rv.publisher || "")} · ${esc(rv.date || "")}</div><div class="rating">판정: ${esc(rv.rating || "표기 없음")}</div></div>`).join("")}</div>`).join("");
}
function renderEvidence(items){
  if (!items.length) return `<div class="empty">관련 웹 검색 결과가 없습니다.</div>`;
  return items.map(x => `<div class="source"><a href="${safeUrl(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a><div class="host">${esc(x.host || x.publisher || "")} · ${esc(x.date || "")}</div></div>`).join("");
}
function safeUrl(u){
  try { const x=new URL(u); if(x.protocol!=="http:"&&x.protocol!=="https:") return "#"; return x.href; } catch { return "#"; }
}
function esc(s){ return String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
