const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════
//  GÜVENLİK: API Key sadece environment variable'dan
// ═══════════════════════════════════════════════
const RAPID_API_KEY = process.env.RAPID_API_KEY;
if (!RAPID_API_KEY) console.warn('⚠️ RAPID_API_KEY env değişkeni tanımlı değil!');
const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';

// ═══════════════════════════════════════════════
//  GÜVENLİK: Helmet — CSP Kapatıldı
// ═══════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false, 
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  referrerPolicy: { policy: "no-referrer" },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ═══════════════════════════════════════════════
//  GÜVENLİK: CORS
// ═══════════════════════════════════════════════
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true,
  methods: ['GET'],
  optionsSuccessStatus: 200
}));

// ═══════════════════════════════════════════════
//  GÜVENLİK: Rate Limiting
// ═══════════════════════════════════════════════
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,   // 1 dakika
  max: 60,                   // dakikada max 60 istek
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek gönderdiniz. Lütfen bekleyin.' }
});
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '10kb' }));

// ═══════════════════════════════════════════════
//  🚀 KRİTİK DÜZELTME: AKILLI ÖNBELLEK (SMART CACHE)
// ═══════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Eğer dosya HTML ise ASLA önbelleğe alma (Anında güncellensin)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // JS, CSS vb. diğer dosyaları 1 saat önbellekte tut
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// ═══════════════════════════════════════════════
//  GÜVENLİK: Input Validation
// ═══════════════════════════════════════════════
const ALLOWED_SPORTS = new Set([
  'football', 'basketball', 'tennis', 'esports', 'volleyball',
  'ice-hockey', 'american-football', 'motorsport', 'mma',
  'cricket', 'handball', 'rugby', 'baseball'
]);

function validateSport(sport) {
  return ALLOWED_SPORTS.has(sport);
}

function validateDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(new Date(date + 'T00:00:00Z').getTime());
}

function validateId(id) {
  return /^\d+$/.test(id);
}

// ═══════════════════════════════════════════════
//  GÜVENLİK: XSS Sanitization
// ═══════════════════════════════════════════════
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === 'object') {
    const clean = {};
    for (const [key, val] of Object.entries(obj)) {
      clean[key] = sanitizeObject(val);
    }
    return clean;
  }
  return obj;
}

// ═══════════════════════════════════════════════
//  CACHE & API
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
  console.log(`[API] ${endpoint}`);
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'x-rapidapi-key': RAPID_API_KEY,
      'x-rapidapi-host': 'sportapi7.p.rapidapi.com'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[API HATA] ${endpoint} → ${res.status}`, body.slice(0, 200));
    throw new Error(`API ${res.status}`);
  }
  const data = await res.json();
  setCache(endpoint, data);
  return data;
}

// ═══════════════════════════════════════════════
//  TÜRKİYE TARİH FONKSİYONLARI
// ═══════════════════════════════════════════════
function getTRDateString(timestamp) {
  const d = new Date(timestamp * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  return parts.find(p => p.type === 'year').value + '-' +
         parts.find(p => p.type === 'month').value + '-' +
         parts.find(p => p.type === 'day').value;
}

function getTRTimeString(timestamp) {
  const d = new Date(timestamp * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  return parts.find(p => p.type === 'hour').value + ':' +
         parts.find(p => p.type === 'minute').value;
}

// ═══════════════════════════════════════════════
//  EVENT FORMATTER (sanitized output)
// ═══════════════════════════════════════════════
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
    tournament: {
      id: Number(e.tournament?.uniqueTournament?.id) || 0,
      name: e.tournament?.uniqueTournament?.name || e.tournament?.name || ''
    },
    homeTeam: {
      id: Number(e.homeTeam?.id) || 0,
      name: e.homeTeam?.name || '',
      shortName: e.homeTeam?.shortName || e.homeTeam?.name || '',
      img: `https://api.sofascore.app/api/v1/team/${Number(e.homeTeam?.id) || 0}/image`
    },
    awayTeam: {
      id: Number(e.awayTeam?.id) || 0,
      name: e.awayTeam?.name || '',
      shortName: e.awayTeam?.shortName || e.awayTeam?.name || '',
      img: `https://api.sofascore.app/api/v1/team/${Number(e.awayTeam?.id) || 0}/image`
    },
    homeScore: e.homeScore?.current ?? null,
    awayScore: e.awayScore?.current ?? null,
    htHome: e.homeScore?.period1 ?? null,
    htAway: e.awayScore?.period1 ?? null,
    referee: e.referee?.name || null,
    stadium: e.venue?.stadium?.name || null
  });
}

// ═══════════════════════════════════════════════
//  ORAN MOTORU
// ═══════════════════════════════════════════════
app.get('/api/odds/:matchId', (req, res) => {
  if (!validateId(req.params.matchId)) return res.status(400).json({ error: 'Geçersiz ID' });
  const { matchId } = req.params;
  const cachedOdds = getCached(`odds_${matchId}`);
  if (cachedOdds) return res.json(cachedOdds);
  const oddsData = {
    match: { home: (Math.random()*(1.5)+1.2).toFixed(2), draw: (Math.random()*(1.2)+2.8).toFixed(2), away: (Math.random()*(2.5)+2.5).toFixed(2) },
    goals: { over: (Math.random()*(0.6)+1.5).toFixed(2), under: (Math.random()*(0.6)+1.6).toFixed(2) },
    btts: { yes: (Math.random()*(0.4)+1.6).toFixed(2), no: (Math.random()*(0.4)+1.8).toFixed(2) }
  };
  setCache(`odds_${matchId}`, oddsData);
  res.json(oddsData);
});

// ═══════════════════════════════════════════════
//  HAVUZ SİSTEMİ
// ═══════════════════════════════════════════════
const eventPool = new Map();
const poolFetchLog = new Map();

app.get('/api/schedule/:sport/:date', async (req, res) => {
  const { sport, date } = req.params;

  if (!validateSport(sport)) return res.status(400).json({ error: 'Geçersiz spor dalı' });
  if (!validateDate(date)) return res.status(400).json({ error: 'Geçersiz tarih formatı' });

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
        } catch(apiErr) {
          console.error(`[POOL] ${sport}/${d}: ${apiErr.message}`);
        }
      }
    }

    const events = [];
    for (const [id, e] of eventPool) {
      if (e._sport === sport && getTRDateString(e.startTimestamp) === date) events.push(e);
    }
    events.sort((a, b) => a.startTimestamp - b.startTimestamp);

    const grouped = {};
    events.forEach(e => {
      const m = formatEvent(e);
      const tId = e.tournament?.uniqueTournament?.id || 'other';
      if (!grouped[tId]) grouped[tId] = { name: m.tournament.name, matches: [] };
      grouped[tId].matches.push(m);
    });

    res.json({ groups: grouped, date, total: events.length });
  } catch (err) {
    console.error(`[SCHEDULE] ${date}:`, err.message);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 172800;
  for (const [id, e] of eventPool) {
    if (e.startTimestamp < cutoff) eventPool.delete(id);
  }
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════
//  CANLI MAÇLAR VE DETAYLAR
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
  try {
    const data = await api(`/event/${req.params.id}/statistics`);
    res.json(sanitizeObject({ statistics: [], raw: data.statistics }));
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

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
    res.json({
      home: { formation: sanitizeString(data.home?.formation || ''), players: formatPlayers(data.home) },
      away: { formation: sanitizeString(data.away?.formation || ''), players: formatPlayers(data.away) }
    });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/incidents', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const data = await api(`/event/${req.params.id}/incidents`);
    res.json(sanitizeObject({ incidents: data.incidents || [] }));
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const data = await api(`/event/${req.params.id}`);
    res.json({ event: formatEvent(data.event) });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('[UNHANDLED]', err.message);
  res.status(500).json({ error: 'Beklenmeyen sunucu hatası' });
});

app.listen(PORT, () => console.log
