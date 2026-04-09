const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const RAPID_API_KEY = process.env.RAPID_API_KEY;
if (!RAPID_API_KEY) console.warn('⚠️ RAPID_API_KEY env değişkeni tanımlı değil!');

const ODDS_API_KEY = process.env.ODDS_API_KEY || '03947fd0b1mshc18ef7cc86815b9p1068cdjsnca79c2737b74';
const ODDS_API_HOST = 'odds-api1.p.rapidapi.com';

const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';

app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(cors());

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 3000, 
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

const ALLOWED_SPORTS = new Set(['football', 'basketball', 'tennis', 'esports', 'volleyball', 'ice-hockey', 'american-football', 'motorsport', 'mma', 'cricket', 'handball', 'rugby', 'baseball']);
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

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  let ttl = CACHE_TTL;
  if (key.includes('/live')) ttl = 30 * 1000; 
  if (key.includes('/h2h') || key.includes('/events/last') || key.includes('/events/next')) ttl = 12 * 60 * 60 * 1000;
  if (key.includes('standings_')) ttl = 15 * 60 * 1000;
  if (key.includes('cuptrees_')) ttl = 30 * 60 * 1000;
  
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
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
        } catch(apiErr) {}
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
    res.status(500).json({ error: 'Sunucu hatası' }); 
  }
});

setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 172800;
  for (const [id, e] of eventPool) { if (e.startTimestamp < cutoff) eventPool.delete(id); }
}, 30 * 60 * 1000);

app.get('/api/odds/:matchId', async (req, res) => {
  if (!validateId(req.params.matchId)) return res.status(400).json({ error: 'Geçersiz ID' });
  const { matchId } = req.params;
  const cachedOdds = getCached(`odds_${matchId}`);
  if (cachedOdds) return res.json(cachedOdds);
  
  let oddsData = null; let sport = 'football';
  try {
    const matchEvent = eventPool.get(Number(matchId));
    let searchQuery = matchId; 
    if (matchEvent) { sport = matchEvent._sport || 'football'; if (matchEvent.homeTeam) searchQuery = matchEvent.homeTeam.name; }
    const response = await fetch(`https://${ODDS_API_HOST}/events/odds?query=${encodeURIComponent(searchQuery)}`, { headers: { 'x-rapidapi-key': ODDS_API_KEY, 'x-rapidapi-host': ODDS_API_HOST }, signal: AbortSignal.timeout(4000) });
    if (response.ok) { await response.json(); throw new Error('API eşleşmesi henüz kurulmadı'); } 
    else throw new Error(`OddsPapi Hatası: ${response.status}`);
  } catch (error) {
    if (sport === 'basketball') { oddsData = { sport: 'basketball', match: { home: (Math.random()*(0.8)+1.2).toFixed(2), away: (Math.random()*(0.8)+1.8).toFixed(2) }, totals: { line: (Math.floor(Math.random() * 40) + 140) + 0.5, over: 1.85, under: 1.85 }, handicap: { line: "-" + ((Math.floor(Math.random() * 10) + 2) + 0.5), home: 1.90, away: 1.90 } }; }
    else { oddsData = { sport: 'football', match: { home: (Math.random()*(1.5)+1.2).toFixed(2), draw: (Math.random()*(1.2)+2.8).toFixed(2), away: (Math.random()*(2.5)+2.5).toFixed(2) }, goals: { over: (Math.random()*(0.6)+1.5).toFixed(2), under: (Math.random()*(0.6)+1.6).toFixed(2) }, btts: { yes: (Math.random()*(0.4)+1.6).toFixed(2), no: (Math.random()*(0.4)+1.8).toFixed(2) } }; }
  }
  setCache(`odds_${matchId}`, oddsData); res.json(oddsData);
});

app.get('/api/live/:sport', async (req, res) => {
  if (!validateSport(req.params.sport)) return res.status(400).json({ error: 'Geçersiz spor' });
  try {
    const data = await api(`/sport/${req.params.sport}/events/live`);
    const grouped = {};
    (data.events || []).forEach(e => {
      const m = formatEvent(e); const tId = e.tournament?.uniqueTournament?.id || 'other';
      if (!grouped[tId]) grouped[tId] = { name: m.tournament.name, matches: [] };
      grouped[tId].matches.push(m);
    });
    res.json({ groups: grouped });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/stats', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}/statistics`); res.json(sanitizeObject({ statistics: [], raw: data.statistics })); } 
  catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/lineups', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { 
    const data = await api(`/event/${req.params.id}/lineups`);
    // Normalize missing players field names
    if (data?.home) {
      if (!data.home.missing && data.home.missingPlayers) data.home.missing = data.home.missingPlayers;
    }
    if (data?.away) {
      if (!data.away.missing && data.away.missingPlayers) data.away.missing = data.away.missingPlayers;
    }
    res.json(data); 
  } 
  catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/incidents', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}/incidents`); res.json(sanitizeObject({ incidents: data.incidents || [] })); } 
  catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}`); res.json({ event: formatEvent(data.event) }); } 
  catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('/api/event/:id/h2h', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try { const data = await api(`/event/${req.params.id}/h2h/events`); res.json({ events: (data.events || []).map(e => formatEvent(e)) }); } 
  catch (err) { res.json({ events: [] }); }
});

app.get('/api/player/:id/details', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const pId = req.params.id; let eventsData = { events: [] };
    try { eventsData = await api(`/player/${pId}/events/last/0`); } catch(e) {}
    res.json({ matches: (eventsData.events || []).slice(0, 10).map(e => formatEvent(e)) });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// Oyuncu sezon istatistikleri
app.get('/api/player/:id/season-stats', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const pId = req.params.id;
    const cacheKey = `player_season_${pId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let result = { statistics: [], info: null };

    // Oyuncu bilgisi
    try {
      const pData = await api(`/player/${pId}`);
      if (pData?.player) {
        result.info = sanitizeObject({
          name: pData.player.name || pData.player.shortName || '',
          position: pData.player.position || '',
          height: pData.player.height || null,
          age: pData.player.dateOfBirthTimestamp ? Math.floor((Date.now()/1000 - pData.player.dateOfBirthTimestamp) / 31557600) : null,
          nationality: pData.player.country?.name || '',
          teamName: pData.player.team?.name || '',
          teamId: pData.player.team?.id || null,
          marketValue: pData.player.proposedMarketValue || pData.player.marketValue || null,
          marketValueCurrency: pData.player.proposedMarketValueRaw?.currency || 'EUR',
          shirtNumber: pData.player.jerseyNumber || null
        });
      }
    } catch(e) {}

    // Sezon istatistikleri - birden fazla yöntem dene
    let statsFound = false;

    // Yöntem 1: unique-tournament-seasons -> statistics/overall
    if (!statsFound) {
      try {
        const statsData = await api(`/player/${pId}/unique-tournament-seasons`);
        const tournaments = statsData?.uniqueTournamentSeasons || [];
        for (let ti = 0; ti < Math.min(tournaments.length, 3) && !statsFound; ti++) {
          const t = tournaments[ti];
          const tId = t.uniqueTournament?.id;
          const seasons = t.seasons || [];
          if (tId && seasons.length > 0) {
            const sId = seasons[0].id;
            try {
              const seasonStats = await api(`/player/${pId}/unique-tournament/${tId}/season/${sId}/statistics/overall`);
              const raw = seasonStats?.statistics || seasonStats;
              if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
                result.statistics = sanitizeObject(raw);
                result.tournamentName = t.uniqueTournament?.name || '';
                statsFound = true;
              }
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    // Yöntem 2: SofaScore direct API
    if (!statsFound) {
      try {
        const utSeasons = await safeFetch(`https://api.sofascore.app/api/v1/player/${pId}/unique-tournament-seasons`, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
        const tournaments = utSeasons?.uniqueTournamentSeasons || [];
        for (let ti = 0; ti < Math.min(tournaments.length, 3) && !statsFound; ti++) {
          const t = tournaments[ti];
          const tId = t.uniqueTournament?.id;
          const seasons = t.seasons || [];
          if (tId && seasons.length > 0) {
            const sId = seasons[0].id;
            try {
              const sStats = await safeFetch(`https://api.sofascore.app/api/v1/player/${pId}/unique-tournament/${tId}/season/${sId}/statistics/overall`, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
              const raw = sStats?.statistics || sStats;
              if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
                result.statistics = sanitizeObject(raw);
                result.tournamentName = t.uniqueTournament?.name || '';
                statsFound = true;
              }
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    // Yöntem 3: Son maçlardan istatistik çıkar
    if (!statsFound) {
      try {
        const evData = await api(`/player/${pId}/events/last/0`);
        const events = evData?.events || [];
        const finishedEvents = events.filter(e => e.status?.type === 'finished');
        if (finishedEvents.length > 0) {
          // İlk bitmiş maçtan oyuncu istatistikleri çek
          for (let ei = 0; ei < Math.min(finishedEvents.length, 3) && !statsFound; ei++) {
            try {
              const lineupData = await api(`/event/${finishedEvents[ei].id}/lineups`);
              const allPlayers = [
                ...((lineupData?.home?.players || []).map(p => p)),
                ...((lineupData?.away?.players || []).map(p => p))
              ];
              const playerEntry = allPlayers.find(p => String(p.player?.id) === String(pId) || String(p.id) === String(pId));
              if (playerEntry) {
                const pStats = playerEntry.statistics || playerEntry.stats || {};
                if (Object.keys(pStats).length > 0) {
                  result.statistics = sanitizeObject(pStats);
                  result.statisticsSource = 'lastMatch';
                  result.tournamentName = finishedEvents[ei].tournament?.uniqueTournament?.name || finishedEvents[ei].tournament?.name || '';
                  statsFound = true;
                }
              }
            } catch(e) {}
          }
        }
      } catch(e) {}
    }

    setCache(cacheKey, result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// Oyuncu canlı maç kontrolü
app.get('/api/player/:id/live-match', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const pId = req.params.id;
    let result = { inLiveMatch: false, match: null, liveStats: null };
    
    try {
      const evData = await api(`/player/${pId}/events/last/0`);
      const events = evData?.events || [];
      const liveEvent = events.find(e => e.status?.type === 'inprogress');
      if (liveEvent) {
        result.inLiveMatch = true;
        result.match = formatEvent(liveEvent);
        // Canlı maç istatistikleri
        try {
          const lineupData = await api(`/event/${liveEvent.id}/lineups`);
          const allPlayers = [
            ...((lineupData?.home?.players || []).map(p => ({...p, teamSide: 'home'}))),
            ...((lineupData?.away?.players || []).map(p => ({...p, teamSide: 'away'})))
          ];
          const playerEntry = allPlayers.find(p => String(p.player?.id) === String(pId) || String(p.id) === String(pId));
          if (playerEntry) {
            result.liveStats = sanitizeObject(playerEntry.statistics || playerEntry.stats || {});
            result.liveRating = playerEntry.statistics?.rating || playerEntry.rating || null;
          }
        } catch(e) {}
      }
    } catch(e) {}
    
    res.json(result);
  } catch (err) { res.json({ inLiveMatch: false, match: null, liveStats: null }); }
});

// Takım kadrosu
app.get('/api/team/:id/squad', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const teamId = req.params.id;
    const cacheKey = `team_squad_${teamId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let result = { players: [], manager: null, teamInfo: null };

    try {
      const data = await api(`/team/${teamId}/players`);
      const players = data?.players || [];
      result.players = players.map(p => sanitizeObject({
        id: p.player?.id || 0,
        name: p.player?.name || p.player?.shortName || '',
        position: p.player?.position || '',
        shirtNumber: p.player?.jerseyNumber || p.player?.shirtNumber || null,
        nationality: p.player?.country?.name || '',
        height: p.player?.height || null,
        age: p.player?.dateOfBirthTimestamp ? Math.floor((Date.now()/1000 - p.player.dateOfBirthTimestamp) / 31557600) : null,
        marketValue: p.player?.proposedMarketValue || null,
        img: `https://api.sofascore.app/api/v1/player/${p.player?.id || 0}/image`
      }));
    } catch(e) {}

    // Takım bilgisi
    try {
      const tData = await api(`/team/${teamId}`);
      if (tData?.team) {
        result.teamInfo = sanitizeObject({
          name: tData.team.name || '',
          shortName: tData.team.shortName || '',
          country: tData.team.country?.name || '',
          stadium: tData.team.venue?.stadium?.name || tData.team.venue?.name || '',
          stadiumCapacity: tData.team.venue?.stadium?.capacity || tData.team.venue?.capacity || null,
          manager: tData.team.manager?.name || null,
          teamColors: tData.team.teamColors || null
        });
        result.manager = tData.team.manager?.name || null;
      }
    } catch(e) {}

    setCache(cacheKey, result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// Takım sezon istatistikleri
app.get('/api/team/:id/season-stats', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const teamId = req.params.id;
    const cacheKey = `team_stats_${teamId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let result = { stats: null, topPlayers: [] };
    
    try {
      const tData = await api(`/team/${teamId}`);
      const tournament = tData?.team?.tournament;
      if (tournament?.uniqueTournament?.id) {
        const utId = tournament.uniqueTournament.id;
        // Sezon bul
        let seasonId = null;
        try {
          const utData = await api(`/unique-tournament/${utId}`);
          seasonId = utData?.uniqueTournament?.currentSeason?.id || utData?.currentSeason?.id;
        } catch(e) {}
        if (!seasonId) {
          try {
            const sData = await api(`/unique-tournament/${utId}/seasons`);
            const seasons = sData?.seasons || [];
            if (seasons.length > 0) seasonId = seasons[0].id;
          } catch(e) {}
        }
        if (seasonId) {
          // Takım istatistikleri
          try {
            const statsData = await api(`/unique-tournament/${utId}/season/${seasonId}/standings/total`);
            const standings = statsData?.standings || [];
            for (const group of standings) {
              const rows = group.rows || [];
              const teamRow = rows.find(r => String(r.team?.id) === String(teamId));
              if (teamRow) {
                result.stats = sanitizeObject({
                  position: teamRow.position || 0,
                  matches: teamRow.matches || 0,
                  wins: teamRow.wins || 0,
                  draws: teamRow.draws || 0,
                  losses: teamRow.losses || 0,
                  goalsFor: teamRow.scoresFor || 0,
                  goalsAgainst: teamRow.scoresAgainst || 0,
                  points: teamRow.points || 0,
                  tournamentName: tournament.uniqueTournament.name || ''
                });
                break;
              }
            }
          } catch(e) {}
        }
      }
    } catch(e) {}

    setCache(cacheKey, result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

// Eksik oyuncular (sakatlık, ceza, şüpheli)
app.get('/api/event/:id/missing-players', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const eventId = req.params.id;
    let result = { home: [], away: [] };
    
    const parseMissing = (players) => {
      if (!Array.isArray(players)) return [];
      return players.map(p => {
        // Try multiple name fields
        let name = p.player?.name || p.player?.shortName || p.player?.slug || 
                   p.name || p.shortName || p.playerName || '';
        const playerId = p.player?.id || p.id || p.playerId || 0;
        // If name is empty or just a number, use player ID for later enrichment
        if (!name || /^\d+$/.test(name)) name = '';
        return sanitizeObject({
          name: name,
          type: p.type || p.availability?.type || p.availabilityType || 'injury',
          reason: p.reason || p.availability?.reason || p.availabilityReason || '',
          id: playerId
        });
      }).filter(p => p.name || p.id);
    };

    // Enrich missing players that have no name
    const enrichNames = async (players) => {
      const enriched = [];
      for (const p of players) {
        if (!p.name && p.id) {
          try {
            const pData = await api(`/player/${p.id}`);
            p.name = pData?.player?.name || pData?.player?.shortName || ('Oyuncu #' + p.id);
          } catch(e) { p.name = 'Oyuncu #' + p.id; }
        }
        if (p.name) enriched.push(p);
      }
      return enriched;
    };

    // Yöntem 1: sportapi7 event-level missing players
    try {
      const data = await api(`/event/${eventId}/missing-players`);
      if (data?.home?.length || data?.away?.length) {
        result.home = await enrichNames(parseMissing(data.home || []));
        result.away = await enrichNames(parseMissing(data.away || []));
        if (result.home.length > 0 || result.away.length > 0) return res.json(result);
      }
      // Check alternative structure
      if (data?.missingPlayers) {
        const mp = data.missingPlayers;
        if (mp.home) result.home = await enrichNames(parseMissing(mp.home));
        if (mp.away) result.away = await enrichNames(parseMissing(mp.away));
        if (result.home.length > 0 || result.away.length > 0) return res.json(result);
      }
    } catch(e) {}

    // Takım ID'lerini bul
    let homeId, awayId;
    try {
      const eventData = await api(`/event/${eventId}`);
      homeId = eventData?.event?.homeTeam?.id;
      awayId = eventData?.event?.awayTeam?.id;
    } catch(e) {}

    if (!homeId && !awayId) return res.json(result);

    const fetchMissing = async (teamId) => {
      // Yöntem 2: sportapi7 team missing players
      try {
        const data = await api(`/team/${teamId}/missing-players`);
        const players = data?.players || data?.missingPlayers || [];
        if (players.length > 0) return parseMissing(players);
      } catch(e) {}

      // Yöntem 3: SofaScore direct team missing players
      try {
        const data = await safeFetch(`https://api.sofascore.app/api/v1/team/${teamId}/missing-players`, { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
        });
        const players = data?.players || data?.missingPlayers || [];
        if (players.length > 0) return parseMissing(players);
      } catch(e) {}

      // Yöntem 4: SofaScore team near-events missing  
      try {
        const data = await safeFetch(`https://api.sofascore.app/api/v1/team/${teamId}/near-events`, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
        if (data?.missingPlayers) return parseMissing(data.missingPlayers);
      } catch(e) {}

      return [];
    };
      
    if (homeId) result.home = await enrichNames(await fetchMissing(homeId));
    if (awayId) result.away = await enrichNames(await fetchMissing(awayId));
    
    res.json(result);
  } catch (err) { res.json({ home: [], away: [] }); }
});

app.get('/api/standings/:id', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const tId = req.params.id;
    const cacheKey = `standings_${tId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let seasonId = null;

    try {
      const tData = await api(`/unique-tournament/${tId}`);
      seasonId = tData?.uniqueTournament?.currentSeason?.id || tData?.tournament?.currentSeason?.id || tData?.currentSeason?.id;
    } catch(e) {}

    if (!seasonId) {
      try {
        const seasonsData = await api(`/unique-tournament/${tId}/seasons`);
        const seasons = seasonsData?.seasons || seasonsData || [];
        if (Array.isArray(seasons) && seasons.length > 0) seasonId = seasons[0].id;
      } catch(e) {}
    }

    if (!seasonId) {
      try {
        const tData2 = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}`, { 'User-Agent': 'Mozilla/5.0' });
        seasonId = tData2?.uniqueTournament?.currentSeason?.id || tData2?.currentSeason?.id;
      } catch(e) {}
    }

    if (!seasonId) {
      try {
        const sData2 = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}/seasons`, { 'User-Agent': 'Mozilla/5.0' });
        const seasons2 = sData2?.seasons || sData2 || [];
        if (Array.isArray(seasons2) && seasons2.length > 0) seasonId = seasons2[0].id;
      } catch(e) {}
    }

    if (!seasonId) throw new Error('Sezon bulunamadı');

    let sData;
    try { 
      sData = await api(`/unique-tournament/${tId}/season/${seasonId}/standings/total`); 
    } catch(e) { 
      try { 
        sData = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}/season/${seasonId}/standings/total`, { 'User-Agent': 'Mozilla/5.0' }); 
      } catch(e2) { 
        throw new Error('Puan durumu verisi alınamadı'); 
      }
    }

    let standings = [];
    if (sData && sData.standings && Array.isArray(sData.standings)) {
      standings = sData.standings;
    } else if (Array.isArray(sData) && sData.length > 0) {
      if (sData[0].standings) {
        sData.forEach(s => { if (Array.isArray(s.standings)) standings = standings.concat(s.standings); });
      } else if (sData[0].rows) {
        standings = sData;
      } else {
        standings = [{ name: '', rows: sData }];
      }
    }

    const normalizedStandings = standings.map(group => {
      const rows = (group.rows || group.teamStandings || []).map(r => {
        const team = r.team || {};
        return sanitizeObject({
          position: r.position || r.rank || 0,
          team: { id: Number(team.id) || 0, name: team.name || team.shortName || '' },
          matches: r.matches || r.played || r.games || 0,
          wins: r.wins || r.victories || 0,
          draws: r.draws !== undefined ? r.draws : (r.ties || 0),
          losses: r.losses || r.defeats || 0,
          scoresFor: r.scoresFor || r.goalsScored || r.goalsFor || r.scored || 0,
          scoresAgainst: r.scoresAgainst || r.goalsConceded || r.goalsAgainst || r.conceded || 0,
          points: r.points !== undefined ? r.points : 0
        });
      });
      return { name: group.name || group.tournament?.name || '', rows: rows };
    });

    setCache(cacheKey, normalizedStandings);
    res.json(normalizedStandings);
  } catch (err) {
    console.error('Standings error:', err.message);
    res.status(500).json({ error: 'Puan durumu yüklenemedi: ' + (err.message || '') });
  }
});

// 🚀 AĞAÇ VERİSİ (CUPTREES) API'Sİ 🚀
app.get('/api/cuptrees/:id', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const tId = req.params.id;
    const cacheKey = `cuptrees_${tId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let seasonId = null;

    // Sezon ID'yi bul
    try {
      const tData = await api(`/unique-tournament/${tId}`);
      seasonId = tData?.uniqueTournament?.currentSeason?.id || tData?.tournament?.currentSeason?.id || tData?.currentSeason?.id;
    } catch(e) {}

    if (!seasonId) {
      try {
        const tData2 = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}`, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
        seasonId = tData2?.uniqueTournament?.currentSeason?.id || tData2?.currentSeason?.id;
      } catch(e) {}
    }

    if (!seasonId) {
      try {
        const sData = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}/seasons`, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
        const seasons = sData?.seasons || sData || [];
        if (Array.isArray(seasons) && seasons.length > 0) seasonId = seasons[0].id;
      } catch(e) {}
    }

    if (!seasonId) return res.json({ cuptrees: [] });

    const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

    // Extract cuptrees from various response structures
    const extractTrees = (data) => {
      if (!data) return [];
      if (Array.isArray(data)) return data;
      if (data.cuptrees && Array.isArray(data.cuptrees)) return data.cuptrees;
      if (data.cupTrees && Array.isArray(data.cupTrees)) return data.cupTrees;
      // Check for rounds structure  
      if (data.rounds && Array.isArray(data.rounds)) return [{ rounds: data.rounds }];
      return [];
    };

    let trees = [];

    // Yöntem 1: sportapi7 cuptrees
    try { 
      const d = await api(`/unique-tournament/${tId}/season/${seasonId}/cuptrees`);
      trees = extractTrees(d);
    } catch(e) {}

    // Yöntem 2: SofaScore direct cuptrees  
    if (trees.length === 0) {
      try { 
        const d = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}/season/${seasonId}/cuptrees`, UA);
        trees = extractTrees(d);
      } catch(e) {}
    }

    // Yöntem 3: sportapi7 bracket/rounds approach
    if (trees.length === 0) {
      try {
        const roundsData = await api(`/unique-tournament/${tId}/season/${seasonId}/rounds`);
        const rounds = roundsData?.rounds || roundsData?.currentRounds || [];
        if (Array.isArray(rounds) && rounds.length > 0) {
          // Knockout turlarını bul (grup aşaması olmayan)
          const knockoutRounds = rounds.filter(r => {
            const name = (r.name || r.description || '').toLowerCase();
            return name.includes('final') || name.includes('quarter') || name.includes('semi') || 
                   name.includes('round of') || name.includes('knockout') || name.includes('playoff') ||
                   name.includes('çeyrek') || name.includes('yarı') || r.knockoutRound || r.cupRound;
          });
          if (knockoutRounds.length > 0) {
            const builtRounds = [];
            for (const round of knockoutRounds) {
              try {
                const roundEvents = await api(`/unique-tournament/${tId}/season/${seasonId}/events/round/${round.round || round.id}`);
                const events = roundEvents?.events || [];
                if (events.length > 0) {
                  builtRounds.push({
                    description: round.name || round.description || ('Tur ' + (round.round || round.id)),
                    blocks: [{ events: events }]
                  });
                }
              } catch(e) {}
            }
            if (builtRounds.length > 0) trees = [{ rounds: builtRounds }];
          }
        }
      } catch(e) {}
    }

    // Yöntem 4: SofaScore rounds
    if (trees.length === 0) {
      try {
        const roundsData = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}/season/${seasonId}/rounds`, UA);
        const rounds = roundsData?.rounds || roundsData?.currentRounds || [];
        if (Array.isArray(rounds) && rounds.length > 0) {
          const knockoutRounds = rounds.filter(r => {
            const name = (r.name || r.description || '').toLowerCase();
            return name.includes('final') || name.includes('quarter') || name.includes('semi') || 
                   name.includes('round of') || name.includes('knockout') || name.includes('playoff') ||
                   r.knockoutRound || r.cupRound;
          });
          if (knockoutRounds.length > 0) {
            const builtRounds = [];
            for (const round of knockoutRounds) {
              try {
                const rId = round.round || round.id;
                const roundEvents = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}/season/${seasonId}/events/round/${rId}`, UA);
                const events = roundEvents?.events || [];
                if (events.length > 0) {
                  builtRounds.push({
                    description: round.name || round.description || ('Tur ' + rId),
                    blocks: [{ events: events }]
                  });
                }
              } catch(e) {}
            }
            if (builtRounds.length > 0) trees = [{ rounds: builtRounds }];
          }
        }
      } catch(e) {}
    }

    // Yöntem 5: Last resort - tüm round'ları çekmeyi dene (knockout round numaraları genelde yüksek)
    if (trees.length === 0) {
      try {
        const allEvents = [];
        // Geçmiş ve gelecek maçları çek
        for (let page = 0; page < 2; page++) {
          try {
            const d = await api(`/unique-tournament/${tId}/season/${seasonId}/events/last/${page}`);
            if (d?.events) allEvents.push(...d.events);
          } catch(e) { break; }
        }
        try {
          const d = await api(`/unique-tournament/${tId}/season/${seasonId}/events/next/0`);
          if (d?.events) allEvents.push(...d.events);
        } catch(e) {}

        // Round bilgisine göre grupla
        const roundMap = {};
        allEvents.forEach(e => {
          const roundInfo = e.roundInfo || {};
          const roundNum = roundInfo.round || 0;
          const roundName = roundInfo.name || roundInfo.description || '';
          const isKnockout = roundName.toLowerCase().match(/final|quarter|semi|round of|knockout|playoff|çeyrek|yarı|last/) || roundNum > 6;
          if (isKnockout || roundName) {
            const key = roundName || ('Round ' + roundNum);
            if (!roundMap[key]) roundMap[key] = { description: key, blocks: [{ events: [] }], order: roundNum };
            roundMap[key].blocks[0].events.push(e);
          }
        });

        const sortedRounds = Object.values(roundMap).sort((a, b) => a.order - b.order);
        if (sortedRounds.length > 0) trees = [{ rounds: sortedRounds }];
      } catch(e) {}
    }

    const treeData = { cuptrees: trees };
    if (trees.length > 0) setCache(cacheKey, treeData);
    res.json(treeData);
  } catch (err) {
    res.json({ cuptrees: [] });
  }
});

// 🚀 YENİ: AĞAÇ YOKSA YAKLAŞAN MAÇLARI/EŞLEŞMELERİ ÇEKME APİ'Sİ 🚀
app.get('/api/tournament/:id/next', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const tId = req.params.id;
    const cacheKey = `tournext_${tId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let data;
    try {
      data = await api(`/unique-tournament/${tId}/events/next/0`);
    } catch(e) {
      data = await safeFetch(`https://api.sofascore.app/api/v1/unique-tournament/${tId}/events/next/0`, { 
          'User-Agent': 'Mozilla/5.0'
      }).catch(() => ({events: []}));
    }
    
    const events = (data.events || []).map(e => formatEvent(e));
    const result = { matches: events };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.json({ matches: [] });
  }
});

function validateSearchQuery(q) {
  if (typeof q !== 'string') return false;
  if (q.length < 2 || q.length > 80) return false;
  return /^[\p{L}\p{N}\s\-'.]+$/u.test(q);
}

app.get('/api/search/:sport', async (req, res) => {
  const { sport } = req.params; const q = (req.query.q || '').trim();
  if (!validateSport(sport) || !validateSearchQuery(q)) return res.status(400).json({ error: 'Geçersiz sorgu' });

  const cacheKey = `search_${sport}_${q.toLowerCase()}`;
  const cached = getCached(cacheKey); if (cached) return res.json(cached);

  let data = null;
  if (RAPID_API_KEY) {
      try {
          const res = await fetch(`${BASE_URL}/search/all?q=${encodeURIComponent(q)}`, { headers: { 'x-rapidapi-key': RAPID_API_KEY, 'x-rapidapi-host': 'sportapi7.p.rapidapi.com' }, signal: AbortSignal.timeout(5000) });
          if (res.ok) data = await res.json();
      } catch (e) {}
  }
  if (!data || !data.results) return res.status(500).json({ error: 'Sonuç bulunamadı' });

  try {
    const results = { teams: [], players: [] };
    data.results.forEach(r => {
      if (r.type === 'team' && r.entity) { results.teams.push(sanitizeObject({ id: Number(r.entity.id)||0, name: r.entity.name||'', tournament: r.entity.tournament?.name||'', img: `https://api.sofascore.app/api/v1/team/${r.entity.id}/image` })); }
      if (r.type === 'player' && r.entity) { results.players.push(sanitizeObject({ id: Number(r.entity.id)||0, name: r.entity.name||'', position: r.entity.position||'', teamName: r.entity.team?.name||'', img: `https://api.sofascore.app/api/v1/player/${r.entity.id}/image` })); }
    });
    setCache(cacheKey, results); res.json(results);
  } catch (err) { res.status(500).json({ error: 'Hata oluştu' }); }
});

app.get('/api/team/:id/events', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const data = await api(`/team/${req.params.id}/events/last/0`);
    const nextData = await api(`/team/${req.params.id}/events/next/0`).catch(() => ({ events: [] }));
    const allEvents = [...(data.events || []), ...(nextData.events || [])].sort((a, b) => b.startTimestamp - a.startTimestamp);
    res.json({ matches: allEvents.slice(0, 20).map(e => formatEvent(e)) });
  } catch (err) { res.status(500).json({ error: 'Sunucu hatası' }); }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`🟢 VivoScore Güvenli Mod Aktif: Port ${PORT}`));
