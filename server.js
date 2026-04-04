const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// 🚀 KRİTİK ÇÖZÜM: Render gibi bulut sistemlerinde gerçek kullanıcı IP'sini okumak için.
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════
//  API ANAHTARLARI (GÜVENLİ YAPI)
// ═══════════════════════════════════════════════
const RAPID_API_KEY = process.env.RAPID_API_KEY;
if (!RAPID_API_KEY) console.warn('⚠️ RAPID_API_KEY env değişkeni tanımlı değil!');

const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';

// ═══════════════════════════════════════════════
//  GÜVENLİK: Temel HTTP başlıkları & CORS
// ═══════════════════════════════════════════════
app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(cors());

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 Dakika
  max: 3000, // Güvenli sınır
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek gönderdiniz. Lütfen bekleyin.' }
});
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); }
}));

// ═══════════════════════════════════════════════
//  GÜVENLİK: Input Validation & Sanitization
// ═══════════════════════════════════════════════
const ALLOWED_SPORTS = new Set([
  'football', 'basketball', 'tennis', 'esports', 'volleyball',
  'ice-hockey', 'american-football', 'motorsport', 'mma',
  'cricket', 'handball', 'rugby', 'baseball'
]);

function validateSport(sport) { return ALLOWED_SPORTS.has(sport); }
function validateDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(new Date(date + 'T00:00:00Z').getTime()); }
function validateId(id) { return /^\d+$/.test(id); }

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").trim();
}

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === 'object') {
    const clean = {};
    for (const [key, val] of Object.entries(obj)) { clean[key] = sanitizeObject(val); }
    return clean;
  }
  return obj;
}

// ═══════════════════════════════════════════════
//  CACHE & API FONKSİYONLARI
// ═══════════════════════════════════════════════
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < 100; i++) cache.delete(oldest[i][0]);
  }
}

async function api(endpoint) {
  if (!RAPID_API_KEY) throw new Error('API anahtarı tanımlı değil');
  const cached = getCached(endpoint);
  if (cached) return cached;
  
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': 'sportapi7.p.rapidapi.com' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(res.status.toString());
  
  const data = await res.json();
  setCache(endpoint, data);
  return data;
}

// Güvenli fetch (SofaScore fallback ve arama için)
async function safeFetch(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!text || text.length < 2) throw new Error('Boş yanıt');
  return JSON.parse(text);
}

function getTRDateString(timestamp) {
  const d = new Date(timestamp * 1000);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  return parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value + '-' + parts.find(p => p.type === 'day').value;
}

function getTRTimeString(timestamp) {
  const d = new Date(timestamp * 1000);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  return parts.find(p => p.type === 'hour').value + ':' + parts.find(p => p.type === 'minute').value;
}

function formatEvent(e) {
  const ts = e.startTimestamp * 1000;
  const status = e.status || {};
  let statusText = 'scheduled';
  let minute = null;

  if (status.type === 'inprogress') {
    statusText = 'live';
    minute = status.description === 'Halftime' ? 'HT' : (e.time?.currentPeriodStartTimestamp
      ? Math.floor((Date.now()/1000 - e.time.currentPeriodStartTimestamp) / 60) + (status.description === '2nd half' ? 45 : 0)
      : status.description || 'Live');
  } else if (status.type === 'finished') statusText = 'finished';
  else if (status.type === 'notstarted' || status.type === 'canceled') statusText = 'scheduled';

  return sanitizeObject({
    id: Number(e.id) || 0,
    status: statusText,
    minute,
    timestamp: ts,
    date: getTRDateString(e.startTimestamp),
    time: getTRTimeString(e.startTimestamp),
    tournament: { id: Number(e.tournament?.uniqueTournament?.id) || 0, name: e.tournament?.uniqueTournament?.name || e.tournament?.name || '' },
    homeTeam: { id: Number(e.homeTeam?.id) || 0, name: e.homeTeam?.name || '', shortName: e.homeTeam?.shortName || e.homeTeam?.name || '', img: `https://api.sofascore.app/api/v1/team/${Number(e.homeTeam?.id) || 0}/image` },
    awayTeam: { id: Number(e.awayTeam?.id) || 0, name: e.awayTeam?.name || '', shortName: e.awayTeam?.shortName || e.awayTeam?.name || '', img: `https://api.sofascore.app/api/v1/team/${Number(e.awayTeam?.id) || 0}/image` },
    homeScore: e.homeScore?.current ?? null, awayScore: e.awayScore?.current ?? null,
    htHome: e.homeScore?.period1 ?? null, htAway: e.awayScore?.period1 ?? null,
    referee: e.referee?.name || null, stadium: e.venue?.stadium?.name || null
  });
}

// ═══════════════════════════════════════════════
//  HAVUZ SİSTEMİ (MAÇ TAKVİMİ)
// ═══════════════════════════════════════════════
const eventPool = new Map();
const poolFetchLog = new Map();

app.get('/api/schedule/:sport/:date', async (req, res) => {
  const { sport, date } = req.params;
  if (!validateSport(sport)) return res.status(400).json({ error: 'Geçersiz spor dalı' });
  if (!validateDate(date)) return res.status(400).json({ error: 'Geçersiz tarih formatı (YYYY-MM-DD)' });

  try {
    const prevDay = new Date(date + 'T00:00:00Z');
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    const prevDateStr = prevDay.toISOString().slice(0, 10);

    for (const d of [date, prevDateStr]) {
      const poolKey = sport + ':' + d;
      const lastFetch = poolFetchLog.get(poolKey);
      if (!lastFetch || Date.now() - lastFetch > CACHE_TTL) {
        try {
          const data = await api(`/sport/${sport}/scheduled-events/${d}`);
          (data.events || []).forEach(e => { e._sport = sport; eventPool.set(e.id, e); });
          poolFetchLog.set(poolKey, Date.now());
        } catch(apiErr) { console.error(`[POOL] ${sport}/${d}: ${apiErr.message}`); }
      }
    }

    const events = [];
    for (const [id, e] of eventPool) { if (e._sport === sport && getTRDateString(e.startTimestamp) === date) events.push(e); }
    events.sort((a, b) => a.startTimestamp - b.startTimestamp);

    const grouped = {};
    events.forEach(e => {
      const m = formatEvent(e);  
      const tId = e.tournament?.uniqueTournament?.id || 'other';
      if (!grouped[tId]) grouped[tId] = { name: m.tournament.name, matches: [] };
      grouped[tId].matches.push(m);
    });

    res.json({ groups: grouped, date, total: events.length });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 172800;
  for (const [id, e] of eventPool) { if (e.startTimestamp < cutoff) eventPool.delete(id); }
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════
//  YENİ ORAN SİSTEMİ (Doğrudan SportAPI7)
// ═══════════════════════════════════════════════
app.get('/api/odds/:matchId', async (req, res) => {
  if (!validateId(req.params.matchId)) return res.status(400).json({ error: 'Geçersiz ID' });
  const { matchId } = req.params;
  
  const cachedOdds = getCached(`odds_${matchId}`);
  if (cachedOdds) return res.json(cachedOdds);
  
  let oddsData = null;
  let sport = 'football';

  try {
    const matchEvent = eventPool.get(Number(matchId));
    if (matchEvent) { sport = matchEvent._sport || 'football'; }

    // API'den 1 Numaralı sağlayıcının oranlarını çek
    const rawOdds = await api(`/event/${matchId}/odds/1/all`);

    if (rawOdds && rawOdds.markets) {
        if (sport === 'basketball') {
            oddsData = { sport: 'basketball', match: {}, totals: {}, handicap: {} };
            rawOdds.markets.forEach(m => {
                if (m.marketName === 'Match winner' || m.id === 1) {
                    oddsData.match.home = m.choices.find(c => c.name === '1')?.fractionValue || m.choices[0]?.fractionValue || '1.90';
                    oddsData.match.away = m.choices.find(c => c.name === '2')?.fractionValue || m.choices[1]?.fractionValue || '1.90';
                }
                if (m.marketName === 'Total' || m.id === 2) {
                    oddsData.totals.line = m.choices[0]?.initialFractionValue || 150.5;
                    oddsData.totals.over = m.choices.find(c => c.name === 'Over')?.fractionValue || '1.85';
                    oddsData.totals.under = m.choices.find(c => c.name === 'Under')?.fractionValue || '1.85';
                }
                if (m.marketName === 'Handicap' || m.id === 3) {
                    oddsData.handicap.line = m.choices[0]?.initialFractionValue || '-5.5';
                    oddsData.handicap.home = m.choices.find(c => c.name === '1')?.fractionValue || '1.90';
                    oddsData.handicap.away = m.choices.find(c => c.name === '2')?.fractionValue || '1.90';
                }
            });
        } else {
            oddsData = { sport: 'football', match: {}, goals: {}, btts: {} };
            rawOdds.markets.forEach(m => {
                if (m.marketName === 'Full time' || m.marketName === '1x2' || m.id === 1 || m.id === 11) {
                    oddsData.match.home = m.choices.find(c => c.name === '1')?.fractionValue || '2.10';
                    oddsData.match.draw = m.choices.find(c => c.name === 'X')?.fractionValue || '3.20';
                    oddsData.match.away = m.choices.find(c => c.name === '2')?.fractionValue || '2.80';
                }
                if (m.marketName === 'Total' || m.id === 2 || m.id === 12) {
                    const overUnderChoices = m.choices.filter(c => c.initialFractionValue === "2.5" || c.name.includes("2.5"));
                    if (overUnderChoices.length > 0) {
                       oddsData.goals.over = overUnderChoices.find(c => c.name === 'Over')?.fractionValue || '1.80';
                       oddsData.goals.under = overUnderChoices.find(c => c.name === 'Under')?.fractionValue || '1.90';
                    } else if (m.choices.length >= 2) {
                       oddsData.goals.over = m.choices[0].fractionValue;
                       oddsData.goals.under = m.choices[1].fractionValue;
                    }
                }
                if (m.marketName === 'Both teams to score' || m.id === 3 || m.id === 13) {
                    oddsData.btts.yes = m.choices.find(c => c.name === 'Yes')?.fractionValue || '1.75';
                    oddsData.btts.no = m.choices.find(c => c.name === 'No')?.fractionValue || '2.00';
                }
            });
        }
    } else {
        throw new Error('Oran verisi boş');
    }
  } catch (error) {
    // API'de oran yoksa UI çökmemesi için rastgele üret (Mevcut mantık)
    if (sport === 'basketball') {
        oddsData = { sport: 'basketball', match: { home: (Math.random()*(0.8)+1.2).toFixed(2), away: (Math.random()*(0.8)+1.8).toFixed(2) }, totals: { line: (Math.floor(Math.random() * 40) + 140) + 0.5, over: 1.85, under: 1.85 }, handicap: { line: "-" + ((Math.floor(Math.random() * 10) + 2) + 0.5), home: 1.90, away: 1.90 } };
    } else {
        oddsData = { sport: 'football', match: { home: (Math.random()*(1.5)+1.2).toFixed(2), draw: (Math.random()*(1.2)+2.8).toFixed(2), away: (Math.random()*(2.5)+2.5).toFixed(2) }, goals: { over: (Math.random()*(0.6)+1.5).toFixed(2), under: (Math.random()*(0.6)+1.6).toFixed(2) }, btts: { yes: (Math.random()*(0.4)+1.6).toFixed(2), no: (Math.random()*(0.4)+1.8).toFixed(2) } };
    }
  }

  setCache(`odds_${matchId}`, oddsData);
  res.json(oddsData);
});

// ═══════════════════════════════════════════════
//  DİĞER MAÇ BİLGİLERİ (Canlı, Detaylar vs.)
// ═══════════════════════════════════════════════
app.get('/api/live/:sport', async (req, res) => {
  if (!validateSport(req.params.sport)) return res.status(400).json({ error: 'Geçersiz spor' });
  try {
    const data = await api(`/sport/${req.params.sport}/events/live`);
    const grouped = {};
    (data.events || []).forEach(e => {
      const m = formatEvent(e);
      const tId = e.tournament?.uniqueTournament?.id || 'other';
      if (!grouped[tId]) grouped[tId] = { name: m.tournament.name, matches: [] };
      grouped[tId].matches.push(m);
    });
    res.json({ groups: grouped });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/stats', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}/statistics`); res.json(sanitizeObject({ statistics: [], raw: data.statistics })); } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// KADRO SİSTEMİ (SAKAT VE CEZALILAR EKLENDİ)
app.get('/api/event/:id/lineups', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const data = await api(`/event/${req.params.id}/lineups`);
    
    const formatPlayers = (td) => (td?.players || []).map(p => sanitizeObject({
      id: Number(p.player?.id) || 0, 
      name: p.player?.shortName || p.player?.name || '', 
      number: p.shirtNumber, 
      position: p.position, 
      substitute: p.substitute || false,
      rating: p.statistics?.rating ? parseFloat(p.statistics.rating).toFixed(1) : null, 
      img: `https://api.sofascore.app/api/v1/player/${Number(p.player?.id) || 0}/image`, 
      stats: p.statistics || {}
    }));

    const formatMissing = (td) => (td?.missing || []).map(p => sanitizeObject({
      id: Number(p.player?.id) || 0, 
      name: p.player?.shortName || p.player?.name || '', 
      type: p.type || '',
      reason: p.reason || ''
    }));

    res.json({ 
        home: { 
            formation: sanitizeString(data.home?.formation || ''), 
            players: formatPlayers(data.home),
            missing: formatMissing(data.home)
        }, 
        away: { 
            formation: sanitizeString(data.away?.formation || ''), 
            players: formatPlayers(data.away),
            missing: formatMissing(data.away)
        } 
    });
  } catch (err) { 
    res.status(500).json({ error: 'Sunucu hatası' }); 
  }
});

app.get('/api/event/:id/incidents', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}/incidents`); res.json(sanitizeObject({ incidents: data.incidents || [] })); } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}`); res.json({ event: formatEvent(data.event) }); } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/h2h', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}/h2h/events`); res.json({ events: (data.events || []).map(e => formatEvent(e)) }); } catch (err) { res.json({ events: [] }); }
});

app.get('/api/team/:id/events', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const data = await api(`/team/${req.params.id}/events/last/0`);
    const nextData = await api(`/team/${req.params.id}/events/next/0`).catch(() => ({ events: [] }));
    const allEvents = [...(data.events || []), ...(nextData.events || [])];
    allEvents.sort((a, b) => b.startTimestamp - a.startTimestamp);
    res.json({ matches: allEvents.slice(0, 20).map(e => formatEvent(e)) });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// ═══════════════════════════════════════════════
//  OYUNCU DETAYLARI (Maçlar, Kariyer, Analiz)
// ═══════════════════════════════════════════════
app.get('/api/player/:id/details', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const pId = req.params.id;
    let eventsData = { events: [] }; let transferData = { transferHistory: [] }; let charData = { characteristics: {} };

    try { eventsData = await api(`/player/${pId}/events/last/0`); } catch(e) {}
    try { transferData = await safeFetch(`https://api.sofascore.app/api/v1/player/${pId}/transfer-history`, { 'User-Agent': 'Mozilla/5.0' }); } catch(e) {}
    try { charData = await safeFetch(`https://api.sofascore.app/api/v1/player/${pId}/characteristics`, { 'User-Agent': 'Mozilla/5.0' }); } catch(e) {}
    
    res.json({
      matches: (eventsData.events || []).slice(0, 10).map(e => formatEvent(e)),
      transfers: transferData.transferHistory || [],
      characteristics: charData.characteristics || {}
    });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// ═══════════════════════════════════════════════
//  ARAMA SİSTEMİ (Fallback Destekli)
// ═══════════════════════════════════════════════
function validateSearchQuery(q) {
  if (typeof q !== 'string') return false; if (q.length < 2 || q.length > 80) return false;
  return /^[\p{L}\p{N}\s\-'.]+$/u.test(q);
}

app.get('/api/search/:sport', async (req, res) => {
  const { sport } = req.params; const q = (req.query.q || '').trim();
  if (!validateSport(sport) || !validateSearchQuery(q)) return res.status(400).json({ error: 'Geçersiz arama' });

  const cacheKey = `search_${sport}_${q.toLowerCase()}`;
  const cached = getCached(cacheKey); if (cached) return res.json(cached);

  let data = null; let errors = [];

  try { data = await safeFetch(`https://api.sofascore.app/api/v1/search/all?q=${encodeURIComponent(q)}`, { 'User-Agent': 'Dalvik/2.1.0' }); } catch(e) { errors.push(`S1:${e.message}`); }
  if (!data || !data.results) { try { data = await safeFetch(`https://www.sofascore.com/api/v1/search/all?q=${encodeURIComponent(q)}`, { 'User-Agent': 'Mozilla/5.0' }); } catch(e) { errors.push(`S2:${e.message}`); } }
  if (!data || !data.results) { try { data = await api(`/search/${encodeURIComponent(q)}`); } catch(e) { errors.push(`S3:${e.message}`); } }
  
  if (!data || !data.results) return res.status(500).json({ error: 'Arama servisi anlık ulaşılamıyor.' });

  try {
    const results = { teams: [], players: [] };
    data.results.forEach(r => {
      if (r.type === 'team' && r.entity) { results.teams.push(sanitizeObject({ id: Number(r.entity.id) || 0, name: r.entity.name || '', shortName: r.entity.shortName || r.entity.name || '', img: `https://api.sofascore.app/api/v1/team/${Number(r.entity.id) || 0}/image`, tournament: r.entity.tournament?.name || '' })); }
      if (r.type === 'player' && r.entity) { results.players.push(sanitizeObject({ id: Number(r.entity.id) || 0, name: r.entity.name || '', position: r.entity.position || '', teamName: r.entity.team?.name || '', img: `https://api.sofascore.app/api/v1/player/${Number(r.entity.id) || 0}/image` })); }
    });
    setCache(cacheKey, results); res.json(results);
  } catch (err) { res.status(500).json({ error: 'Sonuçlar işlenemedi' }); }
});

if (process.env.NODE_ENV !== 'production') {
  app.get('/api/debug', (req, res) => { res.json({ trDate: getTRDateString(Math.floor(Date.now() / 1000)) }); });
}

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => { console.error('[HATA]', err.message); res.status(500).json({ error: 'Sunucu hatası' }); });

app.listen(PORT, () => console.log(`🟢 VivoScore Güvenli Mod (Tek API) Aktif: Port ${PORT}`));
