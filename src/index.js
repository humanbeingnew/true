const APP_NAME="관련 자료 찾기";
const VERSION="2.1-related-materials";
const MAX_TEXT=16000, MAX_HTML=1200000, FETCH_TIMEOUT_MS=15000, JINA_READER="https://r.jina.ai/";
const MAX_RESULTS_PER_GROUP=8, MAX_TOTAL_RESULTS=28, MAX_SEARCH_QUERIES=12;
const STOPWORDS=new Set("그리고 그러나 또한 있는 있다 있어 없는 없다 한다 했다 된다 됐다 되는 대한 통해 따르는 따르면 관련 이번 당시 현재 이후 이전 정도 때문에 위해 대해 에서 에게 으로 부터 까지 보다 처럼 같은 하는 것으로 것이 은 는 이 가 을 를 도 자료 기사 보도 말 또 뉴스 칼럼 오피니언 사실 검증 확인 내용 가운데 대한 관한 위해 때문 및 수 있는 있다 없다".split(/\s+/));
const OFFICIAL=/((^|\.)gov\.kr$|(^|\.)go\.kr$|(^|\.)korea\.kr$|(^|\.)kostat\.go\.kr$|(^|\.)kosis\.kr$|(^|\.)bok\.or\.kr$|(^|\.)law\.go\.kr$|(^|\.)assembly\.go\.kr$|(^|\.)ac\.kr$|(^|\.)edu$|(^|\.)who\.int$|(^|\.)un\.org$)/i;
const FACT=/팩트체크|사실확인|사실 확인|fact ?check|factcheck/i;
const COLUMN=/칼럼|오피니언|사설|기고|column|opinion/i;

export default {async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/health'&&request.method==='GET') return json({ok:true,app:APP_NAME,version:VERSION});
  if(url.pathname==='/api/search'&&request.method==='POST'){
    try{
      const body=await request.json();
      const sourceUrl=typeof body.url==='string'?body.url.trim():'';
      const inputText=typeof body.text==='string'?body.text.trim():'';
      const topic=typeof body.topic==='string'?body.topic.trim():(typeof body.claim==='string'?body.claim.trim():'');
      let articleText=inputText, fetched=null, searchNote='';
      if(sourceUrl){
        try{
          fetched=await fetchArticle(sourceUrl);
          if(!articleText) articleText=fetched.text;
        }catch(err){
          searchNote='원문을 직접 읽지는 못했지만, URL의 사이트·기사 식별자와 공개 뉴스 검색을 이용해 관련 자료를 계속 찾아봅니다.';
        }
      }
      if(!articleText&&!topic&&!sourceUrl){return json({ok:false,error:'자료 주소, 본문, 또는 주제를 입력해 주세요.'},200)}
      const seed=topic||articleText||urlSearchSeed(sourceUrl);
      const signal=buildSearchSignals(seed, fetched?.title||'');
      if(!signal.tokens.length && !signal.phrases.length)return json({ok:false,error:'검색에 사용할 핵심어를 찾지 못했습니다. 사람·기관·지역·사건·제품 이름처럼 구체적인 내용을 입력해 주세요.'},200);
      const results=await collectRelated(signal, sourceUrl||'');
      return json({ok:true,app:APP_NAME,version:VERSION,fetched:fetched?{title:fetched.title,host:hostFromUrl(sourceUrl),method:fetched.method}:null,topics:signal.tokens.slice(0,8),searches:results.searches,total:results.all.length,groups:groupResults(results.all).groups,searchEngines:results.engines,searchLinks:buildSearchLinks(results.searches),searchNote:searchNote||undefined});
    }catch(err){return json({ok:false,error:'자료 검색 중 오류가 발생했습니다.',detail:String(err?.message||err)},200)}
  }
  return env.ASSETS.fetch(request);
}};

async function collectRelated(signal, sourceUrl=''){
  const bases=buildBaseQueries(signal);
  const queryPlan=[];
  for(const base of bases){
    queryPlan.push({type:'news',q:base});
    queryPlan.push({type:'column',q:`${base} 칼럼`});
    queryPlan.push({type:'official',q:`${base} 공식 자료`});
    queryPlan.push({type:'factcheck',q:`${base} 팩트체크`});
  }
  const uniquePlan=dedupeQueries(queryPlan).slice(0,MAX_SEARCH_QUERIES);
  const chunks=await Promise.all(uniquePlan.map(async item=>{
    const [g,b,w]=await Promise.all([googleNewsSearch(item.q),bingNewsSearch(item.q),bingWebSearch(item.q)]);
    return [
      ...g.map(r=>({...r,searchType:item.type,engine:'Google News'})),
      ...b.map(r=>({...r,searchType:item.type,engine:'Bing News'})),
      ...w.map(r=>({...r,searchType:item.type,engine:'Bing Web'}))
    ];
  }));
  const all=rankAndDedupe(signal,chunks.flat(),sourceUrl).slice(0,MAX_TOTAL_RESULTS);
  return {all,searches:uniquePlan.map(x=>x.q),engines:['Google News','Bing News','Bing Web']};
}
function buildSearchSignals(text,title=''){
  const source=cleanText(`${title} ${text}`);
  const raw=compactTokens(source);
  const normalized=raw.map(stem).filter(t=>t.length>=2&&!STOPWORDS.has(t));
  const freq=new Map(); for(const t of normalized)freq.set(t,(freq.get(t)||0)+1);
  const tokenScores=[...freq.entries()].map(([t,n])=>{let score=n*2; if(t.length>=4)score+=1; if(/\d/.test(t))score+=1.5; if(/^[A-Za-z0-9-]+$/.test(t))score+=.2; return [t,score]})
    .sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  const phrases=[];
  const phraseSources=[title, text];
  for(const ps of phraseSources){
    const ct=compactTokens(ps).map(stem).filter(t=>t.length>=2&&!STOPWORDS.has(t));
    for(let i=0;i<ct.length-1&&phrases.length<16;i++){
      const a=ct[i], b=ct[i+1]; if(a===b)continue; const ph=`${a} ${b}`; if(!phrases.includes(ph))phrases.push(ph);
    }
    if(phrases.length>=16)break;
  }
  const nums=(source.match(/\b\d+(?:[.,]\d+)?%?\b/g)||[]).slice(0,5);
  for(const n of nums) if(!tokenScores.includes(n)) tokenScores.push(n);
  const usefulPhrases=phrases.filter(ph=>ph.split(' ').some(t=>tokenScores.slice(0,10).includes(t)));
  return {tokens:Array.from(new Set(tokenScores)).slice(0,10),phrases:Array.from(new Set(usefulPhrases)).slice(0,8)};
}
function buildBaseQueries(signal){
  const q=[];
  if(signal.phrases.length) q.push(`"${signal.phrases[0]}"`);
  for(let i=0;i<signal.tokens.length&&q.length<3;i+=2){
    const parts=signal.tokens.slice(i,i+3); if(parts.length>=2)q.push(parts.join(' '));
  }
  if(signal.tokens.length>=3) q.push(signal.tokens.slice(0,3).join(' '));
  return Array.from(new Set(q.map(x=>x.trim()).filter(x=>x.length>=2))).slice(0,3);
}
function dedupeQueries(items){const seen=new Set();return items.filter(x=>{const k=`${x.type}|${x.q.toLowerCase()}`;if(seen.has(k))return false;seen.add(k);return true})}
function rankAndDedupe(signal,items,sourceUrl=''){
  const seen=new Set(), out=[], excluded=canonicalUrl(sourceUrl);
  for(const item of items){const key=canonicalUrl(item.url);if(!item.title||!key||seen.has(key)||key===excluded)continue;seen.add(key);const score=relatedness(signal,item);out.push({...item,relevance:score,why:explainWhy(signal,item,score)})}
  return out.sort((a,b)=>b.relevance-a.relevance);
}
function relatedness(signal,item){
  const a=new Set([...signal.tokens,...signal.phrases.flatMap(x=>x.split(' '))].map(stem).filter(Boolean));
  const blob=`${item.title||''} ${item.publisher||''} ${item.host||''} ${item.description||''}`;
  const bt=new Set(keywordTokens(blob)); let hit=0;for(const t of a)if(bt.has(t))hit++;
  const phraseHit=signal.phrases.some(p=>blob.toLowerCase().includes(p.toLowerCase()));
  let s=Math.min(.72, hit/Math.max(4,a.size)*1.8); if(phraseHit)s+=.22;
  if(OFFICIAL.test(item.host||''))s+=.04; if(FACT.test(`${item.title||''} ${item.host||''}`))s+=.04; if(COLUMN.test(`${item.title||''} ${item.publisher||''}`))s+=.03;
  return Math.min(1,Math.round(s*100)/100);
}
function explainWhy(signal,item,score){
  const blob=keywordTokens(`${item.title||''} ${item.publisher||''} ${item.description||''}`);
  const hits=signal.tokens.filter(t=>blob.includes(t)).slice(0,4);
  const phrase=signal.phrases.find(p=>`${item.title||''} ${item.description||''}`.toLowerCase().includes(p.toLowerCase()));
  if(phrase)return `핵심 구절 “${phrase}”가 검색 결과와 직접 겹칩니다.`;
  if(hits.length)return `핵심어 ${hits.map(x=>'“'+x+'”').join(', ')}가 제목·요약과 겹칩니다.`;
  return '검색 주제와 맥락상 가까운 결과입니다.';
}
function buildSearchLinks(searches){
  const q=searches?.[0]||'';
  return q?[
    {name:'Google News',url:`https://news.google.com/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`},
    {name:'Bing News',url:`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&setlang=ko-KR&mkt=ko-KR`},
    {name:'Bing Web',url:`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=ko-KR`}
  ]:[];
}
function groupResults(items){
  const groups={news:[],column:[],official:[],factcheck:[]};
  for(const item of items){const k=classify(item);if(groups[k].length<MAX_RESULTS_PER_GROUP)groups[k].push(item)}
  return {groups};
}
function classify(item){
  const blob=`${item.title||''} ${item.publisher||''} ${item.host||''}`;
  if(FACT.test(blob)) return 'factcheck';
  if(OFFICIAL.test(item.host||'')) return 'official';
  if(COLUMN.test(blob)) return 'column';
  return 'news';
}
function keywordTokens(text){return compactTokens(text).map(stem).filter(t=>t.length>=2&&!STOPWORDS.has(t)).slice(0,60)}
function compactTokens(text){return cleanText(text).replace(/https?:\/\/\S+/gi,' ').replace(/[“”‘’"'`]/g,' ').split(/\s+/).map(t=>t.replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu,'')).filter(Boolean)}
function stem(t){return String(t).replace(/(되었습니다|되었다|하였다|했어요|했다|한다|된다|됐다|이다|이라는|이라고|있다|없다)$/u,'').replace(/(으로|에서|에게|까지|부터|처럼|보다|만|도|와|과|로|의|에|이|가|을|를|은|는)$/u,'')}
async function googleNewsSearch(query){const u=new URL('https://news.google.com/rss/search');u.searchParams.set('q',`${query} when:7d`);u.searchParams.set('hl','ko');u.searchParams.set('gl','KR');u.searchParams.set('ceid','KR:ko');try{const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0 RelatedMaterialFinder/2.1','accept':'application/rss+xml, application/xml, text/xml'}});if(!res.ok)return[];return parseRss(await res.text()).slice(0,10)}catch{return[]}}
async function bingNewsSearch(query){const u=new URL('https://www.bing.com/news/search');u.searchParams.set('q',query);u.searchParams.set('format','rss');u.searchParams.set('setlang','ko-KR');u.searchParams.set('mkt','ko-KR');try{const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0 RelatedMaterialFinder/2.1','accept':'application/rss+xml, application/xml, text/xml'}});if(!res.ok)return[];return parseRss(await res.text()).slice(0,10)}catch{return[]}}
async function bingWebSearch(query){const u=new URL('https://www.bing.com/search');u.searchParams.set('q',query);u.searchParams.set('format','rss');u.searchParams.set('setlang','ko-KR');try{const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0 RelatedMaterialFinder/2.1','accept':'application/rss+xml, application/xml, text/xml'}});if(!res.ok)return[];return parseRss(await res.text()).slice(0,10)}catch{return[]}}
function parseRss(xml){const out=[];const items=String(xml).match(/<item>[\s\S]*?<\/item>/gi)||[];for(const item of items.slice(0,20)){const title=xmlTag(item,'title'),link=xmlTag(item,'link'),pubDate=xmlTag(item,'pubDate'),source=xmlTag(item,'source'),sourceUrl=xmlAttr(item,'source','url'),description=xmlTag(item,'description');if(title&&link)out.push({title:decodeXml(stripHtml(title)),url:decodeXml(link),date:decodeXml(stripHtml(pubDate||'')),publisher:decodeXml(stripHtml(source||'')),description:cleanText(stripHtml(decodeXml(description||''))),host:hostFromUrl(sourceUrl||link)})}return out}
function stripHtml(s){return String(s||'').replace(/<br\s*\/?>(?=.)/gi,' ').replace(/<[^>]+>/g,' ')}
function xmlTag(s,tag){const m=s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i'));return m?m[1]:''}
function xmlAttr(s,tag,attr){const m=s.match(new RegExp(`<${tag}[^>]*>\\b${attr}=["']([^"']+)["'][^>]*>`,'i'));return m?m[1]:''}
function canonicalUrl(u){try{const x=new URL(u);x.hash='';return x.href}catch{return ''}}
async function fetchArticle(sourceUrl){let u;try{u=new URL(sourceUrl)}catch{throw new Error('URL 형식이 올바르지 않습니다.')}if(!/^https?:$/.test(u.protocol))throw new Error('http 또는 https URL만 사용할 수 있습니다.');if(isPrivateOrLocalHost(u.hostname))throw new Error('내부 또는 로컬 주소는 읽을 수 없습니다.');
  let direct=null;try{direct=await fetchWithTimeout(u.href,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 RelatedMaterialFinder/2.0','accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'}})}catch{}
  if(direct?.ok){const html=await readLimitedText(direct,MAX_HTML);const text=extractReadableText(html);if(text.length>=120)return{title:extractTitle(html),text,method:'direct'}}
  try{const reader=await fetchWithTimeout(JINA_READER+u.href,{headers:{accept:'text/plain,text/markdown;q=0.9'}});if(reader?.ok){const text=cleanText(await readLimitedText(reader,MAX_TEXT));if(text.length>=120)return{title:titleFromReader(text)||u.hostname,text,method:'jina-reader'}}}catch{}
  throw new Error('원문 읽기 실패')}
function extractReadableText(html){let s=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<noscript[\s\S]*?<\/noscript>/gi,' ').replace(/<svg[\s\S]*?<\/svg>/gi,' ');const rs=[/<article[^>]*>([\s\S]*?)<\/article>/i,/<main[^>]*>([\s\S]*?)<\/main>/i,/<div[^>]+(?:id|class)=["'][^"']*(?:article|content|entry-content|post-content|news-article|article-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i];let chosen='';for(const r of rs){const m=s.match(r);if(m?.[1]&&m[1].length>120){chosen=m[1];break}}return cleanText((chosen||s).replace(/<[^>]+>/g,' '))}
function extractTitle(html){const m=String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);return m?cleanText(decodeXml(m[1])):''}
function urlSearchSeed(sourceUrl){try{const u=new URL(sourceUrl);const parts=u.pathname.split('/').filter(Boolean);return `${u.hostname} ${parts.slice(-2).join(' ')}`;}catch{return ''}}
function titleFromReader(text){const lines=text.split(/\n+/).map(x=>x.trim()).filter(Boolean);return lines.slice(0,8).find(x=>x.length>=4&&x.length<=180&&!/^https?:\/\//i.test(x))||''}
function cleanText(s){return decodeXml(String(s||'')).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim()}
function decodeXml(s){return String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))}
function hostFromUrl(u){try{return new URL(decodeXml(u)).hostname.replace(/^www\./,'')}catch{return ''}}
function isPrivateOrLocalHost(h){const s=String(h||'').toLowerCase();return s==='localhost'||s==='127.0.0.1'||s==='::1'||/^10\./.test(s)||/^192\.168\./.test(s)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)}
async function fetchWithTimeout(input,init={}){const c=new AbortController(),timer=setTimeout(()=>c.abort(),FETCH_TIMEOUT_MS);try{return await fetch(input,{...init,signal:c.signal})}finally{clearTimeout(timer)}}
async function readLimitedText(res,limit){return(await res.text()).slice(0,limit)}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
