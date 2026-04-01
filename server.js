const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const RAPID_API_KEY = "03947fd0b1mshc18ef7cc86815b9p1068cdjsnca79c2737b74";
const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Basit bellek cache'i (ücretsiz plan için kritik: 50 istek/ay) ───
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 dakika

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── API İstek Fonksiyonu ───
async function api(endpoint) {
  const cached = getCached(endpoint);
  if (cached) { console.log(`[CACHE] ${endpoint}`); return cached; }

  console.log(`[API] ${endpoint}`);
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'x-rapidapi-key': RAPID_API_KEY,
      'x-rapidapi-host': 'sportapi7.p.rapidapi.com'
    }
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  setCache(endpoint, data);
  return data;
}

// ─── Turnuva ID haritası ───
const TOURNAMENTS = {
  PL:  { id: 17,   season: 61627, name: 'Premier League',    country: 'İngiltere' },
  CL:  { id: 7,    season: 61644, name: 'Champions League',  country: 'Avrupa' },
  SA:  { id: 23,   season: 62045, name: 'Serie A',           country: 'İtalya' },
  PD:  { id: 8,    season: 61643, name: 'La Liga',           country: 'İspanya' },
  BL1: { id: 35,   season: 61632, name: 'Bundesliga',        country: 'Almanya' },
  L1:  { id: 34,   season: 61736, name: 'Ligue 1',           country: 'Fransa' },
  TSL: { id: 52,   season: 63753, name: 'Süper Lig',         country: 'Türkiye' },
  EL:  { id: 679,  season: 61645, name: 'Europa League',     country: 'Avrupa' },
};

// ─── Maç verisi formatlayıcı ───
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
  } else if (status.type === 'finished') {
    statusText = 'finished';
  } else if (status.type === 'notstarted') {
    statusText = 'scheduled';
  } else if (status.type === 'postponed') {
    statusText = 'postponed';
  }

  return {
    id: e.id,
    status: statusText,
    statusCode: status.code,
    minute,
    timestamp: ts,
    date: new Date(ts).toISOString().slice(0, 10),
    time: new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }),
    tournament: {
      id: e.tournament?.uniqueTournament?.id,
      name: e.tournament?.uniqueTournament?.name || e.tournament?.name,
      slug: e.tournament?.uniqueTournament?.slug,
    },
    homeTeam: {
      id: e.homeTeam?.id,
      name: e.homeTeam?.name,
      shortName: e.homeTeam?.shortName || e.homeTeam?.name,
      img: `https://api.sofascore.app/api/v1/team/${e.homeTeam?.id}/image`
    },
    awayTeam: {
      id: e.awayTeam?.id,
      name: e.awayTeam?.name,
      shortName: e.awayTeam?.shortName || e.awayTeam?.name,
      img: `https://api.sofascore.app/api/v1/team/${e.awayTeam?.id}/image`
    },
    homeScore: e.homeScore?.current ?? null,
    awayScore: e.awayScore?.current ?? null,
    htHome: e.homeScore?.period1 ?? null,
    htAway: e.awayScore?.period1 ?? null,
    winnerCode: e.winnerCode,
    hasStats: true,
  };
}

// ═══════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════

// 1) Turnuva listesi
app.get('/api/tournaments', (req, res) => {
  res.json(TOURNAMENTS);
});

// 2) Liga maçları (son + gelecek)
app.get('/api/matches/:leagueId', async (req, res) => {
  const league = TOURNAMENTS[req.params.leagueId];
  if (!league) return res.status(400).json({ error: 'Geçersiz lig' });
  
  try {
    const [lastData, nextData] = await Promise.all([
      api(`/unique-tournament/${league.id}/season/latest/events/last/20`).catch(() => ({ events: [] })),
      api(`/unique-tournament/${league.id}/season/latest/events/next/20`).catch(() => ({ events: [] }))
    ]);

    const events = [
      ...(lastData.events || []),
      ...(nextData.events || [])
    ];

    // Tarihe göre sırala (yeniden eskiye)
    events.sort((a, b) => b.startTimestamp - a.startTimestamp);

    // Tarihe göre grupla
    const grouped = {};
    events.forEach(e => {
      const m = formatEvent(e);
      const dateKey = m.date;
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(m);
    });

    res.json({ matches: grouped, league: league.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3) Günlük maçlar (tüm ligler)
app.get('/api/schedule/:date', async (req, res) => {
  const dateStr = req.params.date; // YYYY-MM-DD
  try {
    const data = await api(`/sport/football/scheduled-events/${dateStr}`);
    const events = (data.events || []).filter(e => {
      const tid = e.tournament?.uniqueTournament?.id;
      return Object.values(TOURNAMENTS).some(t => t.id === tid);
    });

    // Turnuvaya göre grupla
    const grouped = {};
    events.forEach(e => {
      const tName = e.tournament?.uniqueTournament?.name || 'Diğer';
      const tId = e.tournament?.uniqueTournament?.id;
      if (!grouped[tId]) grouped[tId] = { name: tName, matches: [] };
      grouped[tId].matches.push(formatEvent(e));
    });

    res.json({ groups: grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 4) Canlı maçlar
app.get('/api/live', async (req, res) => {
  try {
    const data = await api('/sport/football/events/live');
    const events = (data.events || []).map(formatEvent);
    res.json({ matches: events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5) Puan durumu
app.get('/api/standings/:leagueId', async (req, res) => {
  const league = TOURNAMENTS[req.params.leagueId];
  if (!league) return res.status(400).json({ error: 'Geçersiz lig' });

  try {
    const data = await api(`/unique-tournament/${league.id}/season/latest/standings/total`);
    const rows = (data.standings?.[0]?.rows || []).map(r => ({
      pos: r.position,
      team: {
        id: r.team?.id,
        name: r.team?.shortName || r.team?.name,
        img: `https://api.sofascore.app/api/v1/team/${r.team?.id}/image`
      },
      played: r.matches,
      won: r.wins,
      drawn: r.draws,
      lost: r.losses,
      gf: r.scoresFor,
      ga: r.scoresAgainst,
      gd: r.scoresFor - r.scoresAgainst,
      pts: r.points,
      form: (r.descriptions || []).slice(-5),
    }));
    res.json({ standings: rows, league: league.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 6) Maç detayı - İstatistikler
app.get('/api/event/:id/stats', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/statistics`);
    const allStats = [];
    (data.statistics || []).forEach(period => {
      (period.groups || []).forEach(group => {
        (group.statisticsItems || []).forEach(item => {
          allStats.push({
            name: item.name,
            home: item.homeValue,
            away: item.awayValue,
            homeTotal: item.homeTotal,
            awayTotal: item.awayTotal,
            type: item.statisticsType,
            group: group.groupName,
            period: period.period,
          });
        });
      });
    });
    res.json({ statistics: allStats, raw: data.statistics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7) Maç detayı - Kadrolar
app.get('/api/event/:id/lineups', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/lineups`);
    
    const formatPlayers = (teamData) => {
      if (!teamData) return [];
      return (teamData.players || []).map(p => ({
        id: p.player?.id,
        name: p.player?.shortName || p.player?.name,
        number: p.shirtNumber,
        position: p.position,
        rating: p.statistics?.rating ? parseFloat(p.statistics.rating).toFixed(1) : null,
        substitute: p.substitute || false,
        captain: p.captain || false,
        img: `https://api.sofascore.app/api/v1/player/${p.player?.id}/image`,
        stats: {
          goals: p.statistics?.goals || 0,
          assists: p.statistics?.assists || 0,
          minutesPlayed: p.statistics?.minutesPlayed || 0,
          yellowCards: (p.statistics?.yellowCards || 0),
          redCards: (p.statistics?.redCards || 0),
        }
      }));
    };

    res.json({
      home: {
        formation: data.home?.formation,
        players: formatPlayers(data.home),
      },
      away: {
        formation: data.away?.formation,
        players: formatPlayers(data.away),
      },
      confirmed: data.confirmed || false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8) Maç detayı - Olaylar (goller, kartlar, değişiklikler)
app.get('/api/event/:id/incidents', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/incidents`);
    const incidents = (data.incidents || []).map(inc => ({
      type: inc.incidentType,
      time: inc.time,
      addedTime: inc.addedTime,
      isHome: inc.isHome,
      text: inc.text,
      playerName: inc.player?.shortName || inc.player?.name,
      playerIn: inc.playerIn?.shortName,
      playerOut: inc.playerOut?.shortName,
      reason: inc.reason,
      incidentClass: inc.incidentClass, // goal, ownGoal, penalty, yellowCard, redCard etc.
      homeScore: inc.homeScore,
      awayScore: inc.awayScore,
      description: inc.description,
    }));
    res.json({ incidents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9) Maç genel bilgi
app.get('/api/event/:id', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}`);
    res.json({ event: formatEvent(data.event) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tüm diğer istekleri index.html'e yönlendir
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`\n🟢 VivoScore Aktif: http://localhost:${PORT}\n`));
