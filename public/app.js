const $ = id => document.getElementById(id);
const methodScreen=$('methodScreen'), findScreen=$('findScreen'), heroText=$('heroText');
const selectedIcon=$('selectedIcon'), selectedLabel=$('selectedLabel'), selectedDescription=$('selectedDescription');
const urlField=$('urlField'), textField=$('textField'), topicField=$('topicField');
const urlEl=$('url'), textEl=$('text'), topicEl=$('topic'), button=$('find'), statusEl=$('status'), resultEl=$('result');
const METHODS={
  url:{icon:'🔗',label:'자료 주소로 찾기',desc:'웹페이지 내용을 읽어 관련 자료를 모읍니다.'},
  text:{icon:'📄',label:'본문으로 찾기',desc:'본문의 핵심 주제를 뽑아 관련 자료를 모읍니다.'},
  topic:{icon:'🔎',label:'주제·문장으로 찾기',desc:'입력한 주제를 중심으로 관련 자료를 검색합니다.'}
};
let mode=null;
document.querySelectorAll('.method-card').forEach(card=>card.addEventListener('click',()=>selectMode(card.dataset.mode)));
$('backToMethods').addEventListener('click',()=>{findScreen.classList.add('hidden');methodScreen.classList.remove('hidden');heroText.textContent='찾고 싶은 자료의 형태를 선택하세요.';statusEl.className='status hidden';resultEl.classList.add('hidden');});
function selectMode(next){mode=next;const c=METHODS[next];selectedIcon.textContent=c.icon;selectedLabel.textContent=c.label;selectedDescription.textContent=c.desc;urlField.classList.toggle('hidden',next!=='url');textField.classList.toggle('hidden',next!=='text');topicField.classList.toggle('hidden',next!=='topic');methodScreen.classList.add('hidden');findScreen.classList.remove('hidden');resultEl.classList.add('hidden');statusEl.className='status hidden';heroText.textContent=`${c.label}을 선택했습니다.`;setTimeout(()=>{(next==='url'?urlEl:next==='text'?textEl:topicEl).focus()},40)}
button.addEventListener('click',async()=>{
  const payload={url:'',text:'',topic:''};
  if(mode==='url') payload.url=urlEl.value.trim(); if(mode==='text') payload.text=textEl.value.trim(); if(mode==='topic') payload.topic=topicEl.value.trim();
  if(!payload.url&&!payload.text&&!payload.topic){showStatus('먼저 자료나 주제를 입력해 주세요.','error');return}
  button.disabled=true; resultEl.classList.add('hidden'); showStatus('핵심 주제를 뽑고 관련 자료를 찾는 중입니다…','success');
  try{const res=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});let data;try{data=await res.json()}catch{throw new Error(`서버가 예상하지 못한 응답을 보냈습니다. HTTP ${res.status}`)}if(!data.ok){showStatus(data.error||'자료 검색에 실패했습니다.','error');return}render(data);showStatus(`관련 자료 ${data.total}개를 찾았습니다.`,'success')}catch(e){showStatus(e.message||'오류가 발생했습니다.','error')}finally{button.disabled=false}
});
function showStatus(msg,kind){statusEl.textContent=msg;statusEl.className=`status ${kind}`}
function render(data){
  resultEl.classList.remove('hidden');
  let html=`<div class="summary"><strong>관련 자료 모음</strong><div class="meta">${data.fetched?`입력 자료: <b>${esc(data.fetched.host)}</b>${data.fetched.title?` · ${esc(data.fetched.title)}`:''}`:'입력 자료를 바탕으로 주제를 만들었습니다.'}</div>`;
  if(data.topics?.length){html+=`<div class="topic-box"><div class="meta"><b>검색에 사용한 핵심 주제</b></div>${data.topics.map(t=>`<span class="topic-chip">${esc(t)}</span>`).join('')}</div>`}
  if(data.searchNote) html+=`<div class="error-note">${esc(data.searchNote)}</div>`;
  html+=`</div>`;
  const groups=[['news','📰','관련 뉴스'],['column','📝','관련 칼럼·오피니언'],['official','🏛️','공식·1차 자료'],['factcheck','🔎','관련 팩트체크 자료']];
  for(const [key,icon,title] of groups){const arr=data.groups?.[key]||[];html+=`<section class="group"><h2 class="group-title">${icon} ${title} <span class="count">${arr.length}</span></h2>`;if(!arr.length)html+=`<div class="empty">이 종류의 자료를 찾지 못했습니다.</div>`;else html+=`<div class="material-grid">${arr.map(renderMaterial).join('')}</div>`;html+=`</section>`}
  resultEl.innerHTML=html;
}
function renderMaterial(x){return `<article class="material-card"><div class="kind">${esc(x.publisher||x.host||'출처 미상')}</div><a href="${safeUrl(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title||'제목 없음')}</a><div class="source-meta">${esc(x.date||'날짜 미상')}${x.host?` · ${esc(x.host)}`:''}</div><div class="why">연관 이유: ${esc(x.why||'핵심 키워드가 검색 결과와 겹칩니다.')}</div></article>`}
function safeUrl(u){try{const x=new URL(u);return x.protocol==='http:'||x.protocol==='https:'?x.href:'#'}catch{return '#'}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
