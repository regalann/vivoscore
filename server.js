const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const RAPID_API_KEY = process.env.RAPID_API_KEY || "03947fd0b1mshc18ef7cc86815b9p1068cdjsnca79c2737b74";
const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 dakika (2 API call/tarih olduğu için biraz uzun tutuyoruz)

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

async function api(endpoint) {
  const cached = getCached(endpoint);
  if (cached) { console.log(`[CACHE HIT] ${endpoint}`); return cached; }
  console.log(`[API CALL] ${endpoint}`);
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'x-rapidapi-key': RAPID_API_KEY,
      'x-rapidapi-host': 'sportapi7.p.rapidapi.com'
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[API HATA] ${endpoint} → ${res.status} ${res.statusText}`, body.slice(0, 200));
    throw new Error(`API ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  console.log(`[API OK] ${endpoint} → ${data.events ? data.events.length + ' events' : 'data received'}`);
  setCache(endpoint, data);
  return data;
}

// ─── GÜVENİLİR TÜRKİYE TARİH FONKSİYONU ───
// Intl 'en-CA' locale bazı Node.js sürümlerinde YYYY-MM-DD yerine farklı format verebilir
// Bu yüzden formatToParts kullanarak elle birleştiriyoruz
function getTRDateString(timestamp) {
  const d = new Date(timestamp * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + dd;
}

function getTRTimeString(timestamp) {
  const d = new Date(timestamp * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour').value;
  const min = parts.find(p => p.type === 'minute').value;
  return h + ':' + min;
}

// Debug endpoint — tarayıcıdan /api/debug çağırarak tarih fonksiyonlarını test et
app.get('/api/debug', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const testDate = getTRDateString(now);
  const testTime = getTRTimeString(now);
  res.json({
    serverTime: new Date().toISOString(),
    trDate: testDate,
    trTime: testTime,
    nodeVersion: process.version,
    test: 'Bu değerler YYYY-MM-DD ve HH:MM formatında olmalı'
  });
});

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

  return {
    id: e.id, status: statusText, minute, timestamp: ts,
    date: getTRDateString(e.startTimestamp),
    time: getTRTimeString(e.startTimestamp),
    tournament: { id: e.tournament?.uniqueTournament?.id, name: e.tournament?.uniqueTournament?.name || e.tournament?.name },
    homeTeam: { id: e.homeTeam?.id, name: e.homeTeam?.name, shortName: e.homeTeam?.shortName || e.homeTeam?.name, img: `https://api.sofascore.app/api/v1/team/${e.homeTeam?.id}/image` },
    awayTeam: { id: e.awayTeam?.id, name: e.awayTeam?.name, shortName: e.awayTeam?.shortName || e.awayTeam?.name, img: `https://api.sofascore.app/api/v1/team/${e.awayTeam?.id}/image` },
    homeScore: e.homeScore?.current ?? null, awayScore: e.awayScore?.current ?? null,
    htHome: e.homeScore?.period1 ?? null, htAway: e.awayScore?.period1 ?? null,
    referee: e.referee?.name || null, stadium: e.venue?.stadium?.name || null
  };
}

// ORAN MOTORU
app.get('/api/odds/:matchId', async (req, res) => {
  const { matchId } = req.params;
  try {
    const cachedOdds = getCached(`odds_${matchId}`);
    if (cachedOdds) return res.json(cachedOdds);
    const oddsData = {
      match: { home: (Math.random()*(1.5)+1.2).toFixed(2), draw: (Math.random()*(1.2)+2.8).toFixed(2), away: (Math.random()*(2.5)+2.5).toFixed(2) },
      goals: { over: (Math.random()*(0.6)+1.5).toFixed(2), under: (Math.random()*(0.6)+1.6).toFixed(2) },
      btts: { yes: (Math.random()*(0.4)+1.6).toFixed(2), no: (Math.random()*(0.4)+1.8).toFixed(2) }
    };
    setCache(`odds_${matchId}`, oddsData);
    res.json(oddsData);
  } catch (err) { res.status(500).json({ error: "error" }); }
});

// ─── HAVUZ SİSTEMİ: Tüm maçları depola, client filtrelesin ───
const eventPool = new Map();  // eventId -> raw event
const poolFetchLog = new Map(); // "sport:utcDate" -> fetch zamanı

app.get('/api/schedule/:sport/:date', async (req, res) => {
  try {
    const { sport, date } = req.params;
    console.log(`[SCHEDULE] İstenen TR tarih: ${date} | Spor: ${sport}`);
    
    // İstanbul UTC+3 → TR gününü kapsamak için hem istenilen hem önceki UTC günü çekmeliyiz
    // Ama akıllı cache ile gereksiz API çağrısı yapmayız
    const prevDay = new Date(date + 'T00:00:00Z');
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    const prevDateStr = prevDay.toISOString().slice(0, 10);
    
    const datesToFetch = [date, prevDateStr];
    
    for (const d of datesToFetch) {
      const poolKey = sport + ':' + d;
      const lastFetch = poolFetchLog.get(poolKey);
      if (!lastFetch || Date.now() - lastFetch > CACHE_TTL) {
        try {
          const data = await api(`/sport/${sport}/scheduled-events/${d}`);
          const evts = data.events || [];
          console.log(`[POOL] ${sport}/${d} → ${evts.length} maç havuza eklendi`);
          evts.forEach(e => { e._sport = sport; eventPool.set(e.id, e); });
          poolFetchLog.set(poolKey, Date.now());
        } catch(apiErr) {
          console.error(`[POOL HATA] ${d}: ${apiErr.message}`);
        }
      } else {
        console.log(`[POOL CACHE] ${d} zaten havuzda`);
      }
    }
    
    // Havuzdan spor + Türkiye tarihine göre filtrele
    const events = [];
    for (const [id, e] of eventPool) {
      if (e._sport !== sport) continue;
      const trDate = getTRDateString(e.startTimestamp);
      if (trDate === date) events.push(e);
    }
    
    events.sort((a, b) => a.startTimestamp - b.startTimestamp);
    console.log(`[SCHEDULE] ${sport}/${date} → Havuz: ${eventPool.size} toplam, Bu spor+gün: ${events.length} maç`);
    
    // Debug: ilk 3 maçın bilgilerini logla
    if (events.length > 0) {
      events.slice(0, 3).forEach(e => {
        console.log(`  → ${getTRDateString(e.startTimestamp)} ${getTRTimeString(e.startTimestamp)} | ${e.homeTeam?.shortName} vs ${e.awayTeam?.shortName}`);
      });
    } else if (eventPool.size > 0) {
      // Filtre 0 döndüyse havuzdaki tarihleri göster (debug)
      const sampleDates = new Set();
      for (const [id, e] of eventPool) {
        sampleDates.add(getTRDateString(e.startTimestamp));
        if (sampleDates.size >= 5) break;
      }
      console.log(`[DEBUG] Havuzdaki TR tarihleri: ${[...sampleDates].join(', ')} | Aranan: ${date}`);
    }
    
    const grouped = {};
    events.forEach(e => {
      const m = formatEvent(e);
      const tId = e.tournament?.uniqueTournament?.id || 'other';
      if (!grouped[tId]) grouped[tId] = { name: m.tournament.name, matches: [] };
      grouped[tId].matches.push(m);
    });
    
    res.json({ groups: grouped, date: date, total: events.length, poolSize: eventPool.size });
  } catch (err) {
    console.error(`[SCHEDULE HATA] ${req.params.date}:`, err.message);
    res.status(500).json({ error: err.message, date: req.params.date });
  }
});

// Havuzu periyodik temizle (24 saatten eski maçları sil)
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 172800; // 48 saat
  let cleaned = 0;
  for (const [id, e] of eventPool) {
    if (e.startTimestamp < cutoff) { eventPool.delete(id); cleaned++; }
  }
  if (cleaned > 0) console.log(`[POOL CLEANUP] ${cleaned} eski maç silindi, kalan: ${eventPool.size}`);
}, 30 * 60 * 1000);

app.get('/api/live/:sport', async (req, res) => {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/event/:id/stats', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/statistics`);
    res.json({ statistics: [], raw: data.statistics });
  } catch (err) { res.status(500).json({ error: "err" }); }
});

app.get('/api/event/:id/lineups', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/lineups`);
    const formatPlayers = (td) => (td?.players || []).map(p => ({
        id: p.player?.id, name: p.player?.shortName || p.player?.name,
        number: p.shirtNumber, position: p.position, substitute: p.substitute || false,
        rating: p.statistics?.rating ? parseFloat(p.statistics.rating).toFixed(1) : null,
        img: `https://api.sofascore.app/api/v1/player/${p.player?.id}/image`,
        stats: p.statistics || {}
    }));
    res.json({
      home: { formation: data.home?.formation, players: formatPlayers(data.home) },
      away: { formation: data.away?.formation, players: formatPlayers(data.away) }
    });
  } catch (err) { res.status(500).json({ error: "err" }); }
});

app.get('/api/event/:id/incidents', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/incidents`);
    res.json({ incidents: data.incidents || [] });
  } catch (err) { res.status(500).json({ error: "err" }); }
});

app.get('/api/event/:id', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}`);
    res.json({ event: formatEvent(data.event) });
  } catch (err) { res.status(500).json({ error: "err" }); }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`🟢 VivoScore Pro Fix Aktif: ${PORT}`));
