// 복호화 서비스 워커 (배포 2026-10-22T01:27:29.726Z)
// 잠금 화면에서 가족 비밀번호로 만든 키(IndexedDB)를 꺼내, 게임 파일 요청을 c/*.bin 암호문을 풀어 돌려준다.
// 키가 없거나 틀리면 그냥 네트워크로 넘김 → 잠금 화면(index.html)이 보임.
const ENC_CACHE = 'enc-v1';
const SCOPE = self.registration.scope;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ── IndexedDB 키 ──
function idb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open('family-lock', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
async function kv(op, k, v) {
  const db = await idb();
  return new Promise((ok, no) => {
    const tx = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
    const st = tx.objectStore('kv');
    const r = op === 'get' ? st.get(k) : op === 'del' ? st.delete(k) : st.put(v, k);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

let keyP = null;
let manifestP = null;
const getKey = () => (keyP ??= kv('get', 'key').then((k) => k ?? null).catch(() => null));

async function open(key, buf) {
  const b = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12));
}

/** 네트워크 우선(새 배포 반영), 안 되면 캐시(오프라인) */
async function fetchManifestBytes() {
  const url = new URL('m.bin', SCOPE).href;
  const cache = await caches.open(ENC_CACHE);
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    await cache.put(url, res.clone());
    return res.arrayBuffer();
  } catch (err) {
    const hit = await cache.match(url);
    if (!hit) throw err;
    return hit.arrayBuffer();
  }
}

async function loadManifest() {
  const key = await getKey();
  if (!key) return null;
  try {
    const m = JSON.parse(new TextDecoder().decode(await open(key, await fetchManifestBytes())));
    pruneCache(m);
    return m;
  } catch (err) {
    if (err && err.name === 'OperationError') {
      // 비밀번호가 바뀐 배포: 옛 키를 지우고 잠금 화면으로
      await kv('del', 'key').catch(() => {});
      keyP = null;
    }
    return null;
  }
}

/** 이번 배포에 없는 암호문 조각은 캐시에서 정리 */
async function pruneCache(m) {
  const live = new Set(Object.values(m.files).map(([name]) => new URL(`c/${name}.bin`, SCOPE).href));
  const cache = await caches.open(ENC_CACHE);
  for (const req of await cache.keys()) if (req.url.includes('/c/') && !live.has(req.url)) cache.delete(req);
}

async function blob(name) {
  const url = new URL(`c/${name}.bin`, SCOPE).href;
  const cache = await caches.open(ENC_CACHE);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  // 같은 이름 = 같은 내용이라 한 번 받으면 계속 씀 (오프라인 플레이)
  cache.put(url, res.clone());
  return res.arrayBuffer();
}

async function serve(req, rel) {
  if (req.mode === 'navigate' || !manifestP) manifestP = loadManifest();
  const m = await manifestP;
  if (!m) {
    manifestP = null;
    return fetch(req);
  }
  const entry = m.files[rel];
  if (!entry) return fetch(req);
  const key = await getKey();
  const body = await open(key, await blob(entry[0]));
  return new Response(body, { status: 200, headers: { 'Content-Type': entry[1] } });
}

/** PokéAPI 포켓몬 그림·움직이는 도트(공개 자료): 한 번 받으면 오프라인에서도 */
async function pokeapi(req) {
  const cache = await caches.open('pokeapi-v1');
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req.url, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'GET' && req.url.startsWith('https://raw.githubusercontent.com/PokeAPI/sprites/')) {
    e.respondWith(pokeapi(req).catch(() => fetch(req)));
    return;
  }
  if (req.method !== 'GET' || !req.url.startsWith(SCOPE)) return;
  let rel = decodeURIComponent(new URL(req.url).pathname.slice(new URL(SCOPE).pathname.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  e.respondWith(serve(req, rel).catch(() => fetch(req)));
});

self.addEventListener('message', (e) => {
  // 잠금 화면에서 새 키를 저장한 뒤 알려 줌
  if (e.data === 'key-updated') {
    keyP = null;
    manifestP = null;
  }
});
