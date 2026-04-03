/**
 * VivoScore TEST SUNUCUSU v4
 * ==========================
 * - Port 3001 (production'a dokunmaz)
 * - public-test/ klasöründen HTML sunar
 * - RapidAPI 403 verirse SofaScore direkt API'yi yedek kullanır
 * - Detaylı debug logları
 * 
 * Çalıştırma:
 *   $env:RAPID_API_KEY="anahtariniz"; node test-server.js
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3001;
app.set('trust proxy', 1);

const RAPID_API_KEY = process.env.RAPID_API_KEY;
if (!RAPID_API_KEY) console.warn('\n⚠️  RAPID_API_KEY tanımlı değil!\n');

const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';
const SOFA_URL = 'https://api.sofascore.app/api/v1';
const SOFA_HEADERS = {
  'User-Agent': 'Sofascore/5.11.0 (Android; 10)',
  'Accept': 'application/json',
  'Cache-Control': 'no-cache'
};

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public-test'), {
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const c = res.statusCode < 400 ? '\x1b[32m' : '\x1b[31m';
    if (req.originalUrl.startsWith('/api/'))
      console.log(`${c}${res.statusCode}\x1b[0m ${req.method} ${req.originalUrl} (${ms}ms)`);
  });
  next();
});

// ═══════════════════════════════════════════════
//  VALIDATION
// ═══════════════════════════════════════════════
const ALLOWED_SPORTS = new Set(['football','basketball','tennis','esports','volleyball','ice-hockey','american-football','motorsport','mma','cricket','handball','rugby','baseball']);
function validateSport(s) { return ALLOWED_SPORTS.has(s); }
function validateDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d+'T00:00:00Z').getTime()); }
function validateId(id) { return /^\d+$/.test(id); }
function sanitizeString(s) { if(typeof s!=='string') return s; return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").trim(); }
function sanitizeObject(o) {
  if(o===null||o===undefined) return o; if(typeof o==='string') return sanitizeString(o);
  if(typeof o==='number'||typeof o==='boolean') return o; if(Array.isArray(o)) return o.map(sanitizeObject);
  if(typeof o==='object'){const c={};for(const[k,v]of Object.entries(o))c[k]=sanitizeObject(v);return c;} return o;
}

// ═══════════════════════════════════════════════
//  CACHE
// ═══════════════════════════════════════════════
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCached(k) { const e=cache.get(k); if(e&&Date.now()-e.ts<CACHE_TTL) return e.data; return null; }
function setCache(k,d) { cache.set(k,{data:d,ts:Date.now()}); if(cache.size>500){const o=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts);for(let i=0;i<100;i++)cache.delete(o[i][0]);} }

// ═══════════════════════════════════════════════
//  ÇIFT KATMANLI API (RapidAPI + SofaScore Yedek)
// ═══════════════════════════════════════════════
async function api(endpoint) {
  const cached = getCached('rapid:'+endpoint);
  if (cached) { console.log(`  📦 [CACHE] ${endpoint}`); return cached; }

  // 1. RapidAPI dene
  if (RAPID_API_KEY) {
    try {
      console.log(`  🌐 [RAPID] ${endpoint}`);
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': 'sportapi7.p.rapidapi.com' },
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`  ✅ [RAPID] Başarılı`);
        setCache('rapid:'+endpoint, data);
        return data;
      }
      console.log(`  ❌ [RAPID] ${res.status}`);
    } catch(e) { console.log(`  ❌ [RAPID] ${e.message}`); }
  }

  // 2. SofaScore direkt API (yedek)
  try {
    console.log(`  🔄 [SOFA] ${endpoint}`);
    const res = await fetch(`${SOFA_URL}${endpoint}`, {
      headers: SOFA_HEADERS,
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`  ✅ [SOFA] Başarılı`);
      setCache('rapid:'+endpoint, data);
      return data;
    }
    console.log(`  ❌ [SOFA] ${res.status}`);
    throw new Error('Her iki API de başarısız: SOFA ' + res.status);
  } catch(e) {
    if (e.message.startsWith('Her iki')) throw e;
    console.log(`  ❌ [SOFA] ${e.message}`);
    throw new Error('Tüm API kaynakları başarısız');
  }
}

// ═══════════════════════════════════════════════
//  TÜRKİYE TARİH
// ═══════════════════════════════════════════════
function getTRDateString(ts) { const d=new Date(ts*1000); const p=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d); return p.find(x=>x.type==='year').value+'-'+p.find(x=>x.type==='month').value+'-'+p.find(x=>x.type==='day').value; }
function getTRTimeString(ts) { const d=new Date(ts*1000); const p=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d); return p.find(x=>x.type==='hour').value+':'+p.find(x=>x.type==='minute').value; }

// ═══════════════════════════════════════════════
//  EVENT FORMATTER
// ═══════════════════════════════════════════════
function formatEvent(e) {
  const status = e.status || {};
  let statusText = 'scheduled', minute = null;
  if (status.type === 'inprogress') {
    statusText = 'live';
    minute = status.description === 'Halftime' ? 'HT' : (e.time?.currentPeriodStartTimestamp ? Math.floor((Date.now()/1000 - e.time.currentPeriodStartTimestamp)/60) + (status.description === '2nd half' ? 45 : 0) : status.description || 'Live');
  } else if (status.type === 'finished') statusText = 'finished';
  return sanitizeObject({
    id: Number(e.id)||0, status: statusText, minute, timestamp: e.startTimestamp*1000,
    date: getTRDateString(e.startTimestamp), time: getTRTimeString(e.startTimestamp),
    tournament: { id: Number(e.tournament?.uniqueTournament?.id)||0, name: e.tournament?.uniqueTournament?.name||e.tournament?.name||'' },
    homeTeam: { id: Number(e.homeTeam?.id)||0, name: e.homeTeam?.name||'', shortName: e.homeTeam?.shortName||e.homeTeam?.name||'', img: `https://api.sofascore.app/api/v1/team/${Number(e.homeTeam?.id)||0}/image` },
    awayTeam: { id: Number(e.awayTeam?.id)||0, name: e.awayTeam?.name||'', shortName: e.awayTeam?.shortName||e.awayTeam?.name||'', img: `https://api.sofascore.app/api/v1/team/${Number(e.awayTeam?.id)||0}/image` },
    homeScore: e.homeScore?.current??null, awayScore: e.awayScore?.current??null,
    htHome: e.homeScore?.period1??null, htAway: e.awayScore?.period1??null,
    referee: e.referee?.name||null, stadium: e.venue?.stadium?.name||null
  });
}

// ═══════════════════════════════════════════════
//  PROGRAM (SCHEDULE)
// ═══════════════════════════════════════════════
const eventPool = new Map();
const poolFetchLog = new Map();

app.get('/api/schedule/:sport/:date', async (req, res) => {
  const { sport, date } = req.params;
  if (!validateSport(sport)) return res.status(400).json({ error: 'Geçersiz spor' });
  if (!validateDate(date)) return res.status(400).json({ error: 'Geçersiz tarih' });
  try {
    const prev = new Date(date+'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate()-1);
    for (const d of [date, prev.toISOString().slice(0,10)]) {
      const pk = sport+':'+d;
      if (!poolFetchLog.get(pk) || Date.now()-poolFetchLog.get(pk) > CACHE_TTL) {
        try {
          const data = await api(`/sport/${sport}/scheduled-events/${d}`);
          (data.events||[]).forEach(e => { e._sport = sport; eventPool.set(e.id, e); });
          poolFetchLog.set(pk, Date.now());
        } catch(e) { console.error(`  [POOL] ${d}: ${e.message}`); }
      }
    }
    const events = [];
    for (const [,e] of eventPool) { if (e._sport===sport && getTRDateString(e.startTimestamp)===date) events.push(e); }
    events.sort((a,b) => a.startTimestamp-b.startTimestamp);
    const grouped = {};
    events.forEach(e => { const m=formatEvent(e); const tId=e.tournament?.uniqueTournament?.id||'other'; if(!grouped[tId])grouped[tId]={name:m.tournament.name,matches:[]}; grouped[tId].matches.push(m); });
    res.json({ groups: grouped, date, total: events.length });
  } catch(err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// ═══════════════════════════════════════════════
//  CANLI MAÇLAR
// ═══════════════════════════════════════════════
app.get('/api/live/:sport', async (req, res) => {
  if (!validateSport(req.params.sport)) return res.status(400).json({ error: 'Geçersiz spor' });
  try {
    const data = await api(`/sport/${req.params.sport}/events/live`);
    const g = {};
    (data.events||[]).forEach(e => { const m=formatEvent(e); const tId=e.tournament?.uniqueTournament?.id||'other'; if(!g[tId])g[tId]={name:m.tournament.name,matches:[]}; g[tId].matches.push(m); });
    res.json({ groups: g });
  } catch(err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// ═══════════════════════════════════════════════
//  MAÇ DETAYLARI
// ═══════════════════════════════════════════════
app.get('/api/event/:id/stats', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const d=await api(`/event/${req.params.id}/statistics`); res.json(sanitizeObject({statistics:[],raw:d.statistics})); }
  catch(e) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/lineups', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const d = await api(`/event/${req.params.id}/lineups`);
    const fp = (td) => (td?.players||[]).map(p => sanitizeObject({
      id:Number(p.player?.id)||0, name:p.player?.shortName||p.player?.name||'', number:p.shirtNumber,
      position:p.position, substitute:p.substitute||false,
      rating:p.statistics?.rating?parseFloat(p.statistics.rating).toFixed(1):null,
      img:`https://api.sofascore.app/api/v1/player/${Number(p.player?.id)||0}/image`, stats:p.statistics||{}
    }));
    res.json({ home:{formation:sanitizeString(d.home?.formation||''),players:fp(d.home)}, away:{formation:sanitizeString(d.away?.formation||''),players:fp(d.away)} });
  } catch(e) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/incidents', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const d=await api(`/event/${req.params.id}/incidents`); res.json(sanitizeObject({incidents:d.incidents||[]})); }
  catch(e) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const d=await api(`/event/${req.params.id}`); res.json({event:formatEvent(d.event)}); }
  catch(e) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/h2h', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const d=await api(`/event/${req.params.id}/h2h/events`); res.json({events:(d.events||[]).map(e=>formatEvent(e))}); }
  catch(e) { res.json({ events: [] }); }
});

// ═══════════════════════════════════════════════
//  ARAMA (3 KADEMELİ)
// ═══════════════════════════════════════════════
function validateSearchQuery(q) { if(typeof q!=='string') return false; if(q.length<2||q.length>80) return false; return /^[\p{L}\p{N}\s\-'.]+$/u.test(q); }

app.get('/api/search/:sport', async (req, res) => {
  const { sport } = req.params; const q = (req.query.q||'').trim();
  if (!validateSport(sport)) return res.status(400).json({ error: 'Geçersiz spor' });
  if (!validateSearchQuery(q)) return res.status(400).json({ error: 'Geçersiz sorgu' });

  const cacheKey = `search_${sport}_${q.toLowerCase()}`; 
  const cached = getCached(cacheKey); 
  if (cached) return res.json(cached);

  let data = null, errors = [];

  // S1: SofaScore Mobil API
  try {
    console.log(`  🔍[S1] SofaScore Mobil: q=${q}`);
    const r = await fetch(`https://api.sofascore.app/api/v1/search/all?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Sofascore/5.11.0 (Android; 10)', 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(6000)
    });
    if (r.ok) {
      data = await r.json();
      console.log(`  ✅[S1] ${r.status} - keys: ${Object.keys(data).join(',')}`);
    } else { errors.push(`S1:${r.status}`); console.log(`  ❌[S1] ${r.status}`); }
  } catch(e) { errors.push(`S1:${e.message}`); console.log(`  ❌[S1] ${e.message}`); }

  // S2: SofaScore Web API (farklı User-Agent)
  if (!data || !data.results) {
    try {
      console.log(`  🔍[S2] SofaScore Web: q=${q}`);
      const r = await fetch(`https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(6000)
      });
      if (r.ok) {
        data = await r.json();
        console.log(`  ✅[S2] ${r.status} - keys: ${Object.keys(data).join(',')}`);
      } else { errors.push(`S2:${r.status}`); console.log(`  ❌[S2] ${r.status}`); }
    } catch(e) { errors.push(`S2:${e.message}`); console.log(`  ❌[S2] ${e.message}`); }
  }

  // S3: RapidAPI genel arama
  if ((!data || !data.results) && RAPID_API_KEY) {
    try { console.log(`  🔍[S3] RapidAPI`); data = await api(`/search/${encodeURIComponent(q)}`); console.log(`  ✅[S3]`); }
    catch(e) { errors.push(`S3:${e.message}`); console.log(`  ❌[S3] ${e.message}`); }
  }

  // S4: RapidAPI spora özel
  if ((!data || !data.results) && RAPID_API_KEY) {
    try { console.log(`  🔍[S4] RapidAPI/sport`); data = await api(`/sport/${sport}/search/${encodeURIComponent(q)}`); console.log(`  ✅[S4]`); }
    catch(e) { errors.push(`S4:${e.message}`); console.log(`  ❌[S4] ${e.message}`); }
  }

  if (!data || !data.results) {
    console.error(`  🔍 TÜM ARAMALAR BAŞARISIZ:`, errors.join(' | '));
    if (data) console.error(`  🔍 data keys:`, Object.keys(data));
    return res.status(500).json({ error: 'Arama sunucuları engellendi' });
  }

  try {
    const results = { teams: [], players: [] };
    data.results.forEach(r => {
      if (r.type==='team' && r.entity) results.teams.push(sanitizeObject({
        id:Number(r.entity.id)||0, name:r.entity.name||'', shortName:r.entity.shortName||r.entity.name||'',
        img:`https://api.sofascore.app/api/v1/team/${Number(r.entity.id)||0}/image`,
        country:r.entity.country?.name||'', tournament:r.entity.tournament?.uniqueTournament?.name||r.entity.tournament?.name||''
      }));
      if (r.type==='player' && r.entity) results.players.push(sanitizeObject({
        id:Number(r.entity.id)||0, name:r.entity.name||'', shortName:r.entity.shortName||r.entity.name||'',
        img:`https://api.sofascore.app/api/v1/player/${Number(r.entity.id)||0}/image`,
        position:r.entity.position||'', teamName:r.entity.team?.name||'', teamId:Number(r.entity.team?.id)||0
      }));
    });
    console.log(`  🔍 SONUÇ: ${results.teams.length} takım, ${results.players.length} oyuncu`);
    setCache(cacheKey, results); res.json(results);
  } catch(e) { res.status(500).json({ error: 'Sonuçlar işlenirken hata' }); }
});

// Takım maçları
app.get('/api/team/:id/events', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const d = await api(`/team/${req.params.id}/events/last/0`);
    const n = await api(`/team/${req.params.id}/events/next/0`).catch(()=>({events:[]}));
    const all = [...(d.events||[]),...(n.events||[])];
    all.sort((a,b)=>b.startTimestamp-a.startTimestamp);
    res.json({ matches: all.slice(0,20).map(e=>formatEvent(e)) });
  } catch(e) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// Oranlar (mock)
app.get('/api/odds/:matchId', async (req, res) => {
  if (!validateId(req.params.matchId)) return res.status(400).json({ error: 'Geçersiz ID' });
  const c=getCached(`odds_${req.params.matchId}`); if(c) return res.json(c);
  const o={sport:'football', match:{home:(Math.random()*1.5+1.2).toFixed(2),draw:(Math.random()*1.2+2.8).toFixed(2),away:(Math.random()*2.5+2.5).toFixed(2)}, goals:{over:(Math.random()*0.6+1.5).toFixed(2),under:(Math.random()*0.6+1.6).toFixed(2)}, btts:{yes:(Math.random()*0.4+1.6).toFixed(2),no:(Math.random()*0.4+1.8).toFixed(2)}};
  setCache(`odds_${req.params.matchId}`,o); res.json(o);
});

app.get('/api/debug', (req, res) => { const n=Math.floor(Date.now()/1000); res.json({trDate:getTRDateString(n),trTime:getTRTimeString(n),node:process.version,hasApiKey:!!RAPID_API_KEY,cacheSize:cache.size,poolSize:eventPool.size}); });
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public-test', 'index.html')));
app.use((err,req,res,next) => { console.error('[ERROR]',err.message); res.status(500).json({error:'Sunucu hatası'}); });

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🧪 VivoScore TEST SUNUCUSU v4 AKTİF       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   URL:     http://localhost:${PORT}              ║`);
  console.log(`║   API Key: ${RAPID_API_KEY ? '✅ Tanımlı' : '❌ Eksik'}                        ║`);
  console.log('║   Yedek:   SofaScore Direkt API              ║');
  console.log('║   Klasör:  public-test/                       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
