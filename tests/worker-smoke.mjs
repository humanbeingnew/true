import worker from '../src/index.js';

function response(body, status = 200, contentType = 'text/html') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

async function request(payload, fetchImpl, path = '/api/check') {
  globalThis.fetch = fetchImpl;
  const req = new Request(`https://test.local${path}`, {
    method: path === '/api/check' ? 'POST' : 'GET',
    headers: path === '/api/check' ? { 'content-type': 'application/json' } : {},
    body: path === '/api/check' ? JSON.stringify(payload) : undefined
  });
  const env = { ASSETS: { fetch: () => new Response('asset') } };
  const res = await worker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

const longArticle = ('정부는 2026년에 새로운 정책을 시행했다. 관련 기관은 100만 명이 참여했다고 발표했다. ' +
  '이 정책은 전국에서 적용된다. 추가 설명과 통계 기준을 확인해야 한다. ').repeat(8);
const articleHtml = `<html><head><title>테스트 기사</title></head><body><article>${longArticle}</article></body></html>`;
const emptyRss = '<?xml version="1.0"?><rss><channel></channel></rss>';

const tests = [];

tests.push(['health endpoint', async () => {
  const out = await request({}, async () => response(''), '/api/health');
  if (out.status !== 200 || out.data.ok !== true) throw new Error('health failed');
}]);

tests.push(['URL direct read', async () => {
  const out = await request({ url: 'https://www.example.com/article' }, async (input) => {
    const u = String(input);
    if (u.startsWith('https://www.example.com')) return response(articleHtml);
    if (u.startsWith('https://news.google.com')) return response(emptyRss, 200, 'application/rss+xml');
    return response('', 404);
  });
  if (out.status !== 200 || out.data.ok !== true || out.data.fetched?.method !== 'direct') throw new Error('direct URL read failed');
}]);

tests.push(['URL Jina fallback', async () => {
  const out = await request({ url: 'https://blocked.example.com/article?x=1' }, async (input) => {
    const u = String(input);
    if (u.startsWith('https://blocked.example.com')) return response('blocked', 403);
    if (u.startsWith('https://r.jina.ai/https%3A%2F%2Fblocked.example.com')) {
      return response('# 보조 기사 제목\n\n' + longArticle, 200, 'text/plain');
    }
    if (u.startsWith('https://news.google.com')) return response(emptyRss, 200, 'application/rss+xml');
    return response('', 404);
  });
  if (out.status !== 200 || out.data.ok !== true || out.data.fetched?.method !== 'jina-reader') throw new Error('Jina fallback failed');
}]);

tests.push(['URL double failure stays controlled', async () => {
  const out = await request({ url: 'https://blocked.example.com/article' }, async (input) => {
    const u = String(input);
    if (u.startsWith('https://blocked.example.com')) return response('', 403);
    if (u.startsWith('https://r.jina.ai/')) return response('', 503);
    return response('', 404);
  });
  if (out.status !== 200 || out.data.ok !== false || !out.data.suggestion) throw new Error('double failure was not controlled');
}]);

tests.push(['specific claim mode', async () => {
  const out = await request({ claim: '2026년에 어떤 정책이 시행되었다.' }, async (input) => {
    const u = String(input);
    if (u.startsWith('https://news.google.com')) return response(emptyRss, 200, 'application/rss+xml');
    return response('', 404);
  });
  if (out.status !== 200 || out.data.ok !== true || out.data.claims?.length !== 1) throw new Error('claim mode failed');
}]);

for (const [name, fn] of tests) {
  await fn();
  console.log(`PASS ${name}`);
}
console.log(`ALL PASS (${tests.length} tests)`);
