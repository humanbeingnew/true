const APP_NAME="관련 자료 찾기";
const VERSION="2.0-related-materials";
const MAX_TEXT=16000, MAX_HTML=1200000, FETCH_TIMEOUT_MS=15000, JINA_READER="https://r.jina.ai/";
const MAX_RESULTS_PER_GROUP=8, MAX_TOTAL_RESULTS=28;
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
        try{fetched=await fetchArticle(sourceUrl); if(!articleText) articleText=fetched.text;}
        catch(err){searchNote='입력한 웹페이지를 자동으로 읽지 못했습니다. URL의 제목이나 본문을 알 수 없기 때문에 관련성 높은 검색을 만들 수 없습니다. 같은 내용의 본문을 붙여넣거나 주제·문장으로 다시 검색해 주세요.';}
      }
      if(!articleText&&!topic){return json({ok:false,error:'자료 주소, 본문, 또는 주제를 입력해 주세요.'},200)}
      const topics=buildTopics(topic||articleText);
      if(!topics.length)return json({ok:false,error:'검색할 핵심 주제를 찾지 못했습니다. 사람·기관·장소·숫자 등이 포함된 문장을 입력해 주세요.'},200);
      const results=await collectRelated(topics);
      return json({ok:true,app:APP_NAME,version:VERSION,fetched:fetched?{title:fetched.title,host:hostFromUrl(sourceUrl),method:fetched.method}:null,topics,total:Math.min(results.all.length,MAX_TOTAL_RESULTS),groups:groupResults(results.all).groups,searchNote:searchNote||undefined});
    }catch(err){return json({ok:false,error:'자료 검색 중 오류가 발생했습니다.',detail:String(err?.message||err)},200)}
  }
  return env.ASSETS.fetch(request);
}};

async function collectRelated(topics){
  const q=topics.slice(0,6).join(' ');
  const queries=[
    {type:'news',q:q},
    {type:'column',q:`${q} 칼럼 오피니언 사설 기고`},
    {type:'official',q:`${q} 공식 발표 자료 통계 보고서`},
    {type:'official',q:`${q} site:gov.kr`},
    {type:'factcheck',q:`${q} 팩트체크 사실확인`},
    {type:'news',q:`${topics.slice(0,4).join(' ')} ${topics.length>4?topics[4]:''}`}
  ];
  const chunks=await Promise.all(queries.map(async item=>{const rows=await googleNewsSearch(item.q);return rows.map(r=>({...r,searchType:item.type}))}));
  const all=rankAndDedupe(topics,chunks.flat()).slice(0,MAX_TOTAL_RESULTS);
  return {all};
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
function rankAndDedupe(topics,items){
  const seen=new Set(), out=[];
  for(const item of items){const key=canonicalUrl(item.url);if(!item.title||!key||seen.has(key))continue;seen.add(key);const score=relatedness(topics,item);out.push({...item,relevance:score,why:explainWhy(topics,item,score)})}
  return out.sort((a,b)=>b.relevance-a.relevance);
}
function relatedness(topics,item){
  const a=new Set(keywordTokens(topics.join(' '))), b=new Set(keywordTokens(`${item.title||''} ${item.publisher||''}`));
  if(!a.size||!b.size)return 0;
  let hit=0;for(const t of a)if(b.has(t))hit++;
  let s=hit/Math.min(a.size,b.size);
  if(OFFICIAL.test(item.host||''))s+=0.06; if(FACT.test(`${item.title||''} ${item.host||''}`))s+=0.04; if(COLUMN.test(`${item.title||''} ${item.publisher||''}`))s+=0.03;
  return Math.min(1,Math.round(s*100)/100);
}
function explainWhy(topics,item,score){
  const hits=keywordTokens(topics.join(' ')).filter(t=>keywordTokens(`${item.title||''} ${item.publisher||''}`).includes(t)).slice(0,4);
  return hits.length?`핵심어 ${hits.map(x=>'“'+x+'”').join(', ')}가 제목·출처 정보와 겹칩니다.`:`검색 주제와 전체 맥락이 가까운 결과로 수집되었습니다.`;
}
function buildTopics(text){
  const tokens=keywordTokens(text); const numeric=(String(text).match(/\d+(?:[.,]\d+)?%?/g)||[]).slice(0,3);
  const scored=[]; for(const token of tokens){let s=1; if(/\d/.test(token))s+=1; if(token.length>=4)s+=.5; scored.push([token,s])}
  const top=scored.sort((a,b)=>b[1]-a[1]).map(x=>x[0]).slice(0,8);
  for(const n of numeric)if(!top.includes(n))top.push(n);
  return Array.from(new Set(top)).slice(0,10);
}
function keywordTokens(text){return compactTokens(text).map(stem).filter(t=>t.length>=2&&!STOPWORDS.has(t)).slice(0,40)}
function compactTokens(text){return cleanText(text).replace(/https?:\/\/\S+/gi,' ').replace(/[“”‘’"'`]/g,' ').split(/\s+/).map(t=>t.replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu,'')).filter(Boolean)}
function stem(t){return String(t).replace(/(되었습니다|되었다|하였다|했어요|했다|한다|된다|됐다|이다|이라는|이라고|있다|없다)$/u,'').replace(/(으로|에서|에게|까지|부터|처럼|보다|만|도|와|과|로|의|에|이|가|을|를|은|는)$/u,'')}
async function googleNewsSearch(query){const u=new URL('https://news.google.com/rss/search');u.searchParams.set('q',query);u.searchParams.set('hl','ko');u.searchParams.set('gl','KR');u.searchParams.set('ceid','KR:ko');try{const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0 RelatedMaterialFinder/2.0','accept':'application/rss+xml, application/xml, text/xml'}});if(!res.ok)return[];return parseRss(await res.text())}catch{return[]}}
function parseRss(xml){const out=[];const items=String(xml).match(/<item>[\s\S]*?<\/item>/g)||[];for(const item of items.slice(0,12)){const title=xmlTag(item,'title'),link=xmlTag(item,'link'),pubDate=xmlTag(item,'pubDate'),source=xmlTag(item,'source'),sourceUrl=xmlAttr(item,'source','url');if(title&&link)out.push({title:decodeXml(title),url:decodeXml(link),date:decodeXml(pubDate||''),publisher:decodeXml(source||''),host:hostFromUrl(sourceUrl||link)})}return out}
function xmlTag(s,tag){const m=s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i'));return m?m[1]:''}
function xmlAttr(s,tag,attr){const m=s.match(new RegExp(`<${tag}[^>]*>\\b${attr}=["']([^"']+)["'][^>]*>`,'i'));return m?m[1]:''}
function canonicalUrl(u){try{const x=new URL(u);x.hash='';return x.href}catch{return ''}}
async function fetchArticle(sourceUrl){let u;try{u=new URL(sourceUrl)}catch{throw new Error('URL 형식이 올바르지 않습니다.')}if(!/^https?:$/.test(u.protocol))throw new Error('http 또는 https URL만 사용할 수 있습니다.');if(isPrivateOrLocalHost(u.hostname))throw new Error('내부 또는 로컬 주소는 읽을 수 없습니다.');
  let direct=null;try{direct=await fetchWithTimeout(u.href,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 RelatedMaterialFinder/2.0','accept':'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'}})}catch{}
  if(direct?.ok){const html=await readLimitedText(direct,MAX_HTML);const text=extractReadableText(html);if(text.length>=120)return{title:extractTitle(html),text,method:'direct'}}
  try{const reader=await fetchWithTimeout(JINA_READER+encodeURIComponent(u.href),{headers:{accept:'text/plain,text/markdown;q=0.9'}});if(reader?.ok){const text=cleanText(await readLimitedText(reader,MAX_TEXT));if(text.length>=120)return{title:titleFromReader(text)||u.hostname,text,method:'jina-reader'}}}catch{}
  throw new Error('원문 읽기 실패')}
function extractReadableText(html){let s=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<noscript[\s\S]*?<\/noscript>/gi,' ').replace(/<svg[\s\S]*?<\/svg>/gi,' ');const rs=[/<article[^>]*>([\s\S]*?)<\/article>/i,/<main[^>]*>([\s\S]*?)<\/main>/i,/<div[^>]+(?:id|class)=["'][^"']*(?:article|content|entry-content|post-content|news-article|article-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i];let chosen='';for(const r of rs){const m=s.match(r);if(m?.[1]&&m[1].length>120){chosen=m[1];break}}return cleanText((chosen||s).replace(/<[^>]+>/g,' '))}
function extractTitle(html){const m=String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);return m?cleanText(decodeXml(m[1])):''}
function titleFromReader(text){const lines=text.split(/\n+/).map(x=>x.trim()).filter(Boolean);return lines.slice(0,8).find(x=>x.length>=4&&x.length<=180&&!/^https?:\/\//i.test(x))||''}
function cleanText(s){return decodeXml(String(s||'')).replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim()}
function decodeXml(s){return String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))}
function hostFromUrl(u){try{return new URL(decodeXml(u)).hostname.replace(/^www\./,'')}catch{return ''}}
function isPrivateOrLocalHost(h){const s=String(h||'').toLowerCase();return s==='localhost'||s==='127.0.0.1'||s==='::1'||/^10\./.test(s)||/^192\.168\./.test(s)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)}
async function fetchWithTimeout(input,init={}){const c=new AbortController(),timer=setTimeout(()=>c.abort(),FETCH_TIMEOUT_MS);try{return await fetch(input,{...init,signal:c.signal})}finally{clearTimeout(timer)}}
async function readLimitedText(res,limit){return(await res.text()).slice(0,limit)}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
