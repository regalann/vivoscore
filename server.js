const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Pro Plan API Anahtarın
const RAPID_API_KEY = process.env.RAPID_API_KEY || "03947fd0b1mshc18ef7cc86815b9p1068cdjsnca79c2737b74";
const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; 

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
  if (cached) return cached;

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

// ─── Genişletilmiş Turnuva Haritası (Futbol, Basketbol, Espor) ───
const TOURNAMENTS = {
  PL:  { id: 17,   name: 'Premier League', sport: 'football' },
  CL:  { id: 7,    name: 'Champions League', sport: 'football' },
  TSL: { id: 52,   name: 'Süper Lig', sport: 'football' },
  PD:  { id: 8,    name: 'La Liga', sport: 'football' },
  SA:  { id: 23,   name: 'Serie A', sport: 'football' },
  BL1: { id: 35,   name: 'Bundesliga', sport: 'football' },
  L1:  { id: 34,   name: 'Ligue 1', sport: 'football' },
  NBA: { id: 132,  name: 'NBA', sport: 'basketball' },
  ELB: { id: 138,  name: 'Euroleague', sport: 'basketball' },
  LOL: { id: 11467, name: 'LoL Esports', sport: 'esports' }
};

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
  } else if (status.type === 'notstarted' || status.type === 'canceled') {
    statusText = 'scheduled';
  }

  return {
    id: e.id,
    status: statusText,
    minute,
    timestamp: ts,
    date: new Date(ts).toISOString().slice(0, 10),
    time: new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }),
    tournament: { id: e.tournament?.uniqueTournament?.id, name: e.tournament?.uniqueTournament?.name || e.tournament?.name },
    homeTeam: { id: e.homeTeam?.id, name: e.homeTeam?.name, shortName: e.homeTeam?.shortName || e.homeTeam?.name, img: `https://api.sofascore.app/api/v1/team/${e.homeTeam?.id}/image` },
    awayTeam: { id: e.awayTeam?.id, name: e.awayTeam?.name, shortName: e.awayTeam?.shortName || e.awayTeam?.name, img: `https://api.sofascore.app/api/v1/team/${e.awayTeam?.id}/image` },
    homeScore: e.homeScore?.current ?? null,
    awayScore: e.awayScore?.current ?? null,
    htHome: e.homeScore?.period1 ?? null,
    htAway: e.awayScore?.period1 ?? null,
    referee: e.referee?.name || null,
    stadium: e.venue?.stadium?.name || null
  };
}

app.get('/api/tournaments', (req, res) => res.json(TOURNAMENTS));

app.get('/api/matches/:leagueId', async (req, res) => {
  const league = TOURNAMENTS[req.params.leagueId];
  if (!league) return res.status(400).json({ error: 'Geçersiz lig' });
  try {
    const [lastData, nextData] = await Promise.all([
      api(`/unique-tournament/${league.id}/season/latest/events/last/20`).catch(() => ({ events: [] })),
      api(`/unique-tournament/${league.id}/season/latest/events/next/20`).catch(() => ({ events: [] }))
    ]);
    const events = [...(lastData.events || []), ...(nextData.events || [])];
    events.sort((a, b) => b.startTimestamp - a.startTimestamp);
    const grouped = {};
    events.forEach(e => {
      const m = formatEvent(e);
      if (!grouped[m.date]) grouped[m.date] = [];
      grouped[m.date].push(m);
    });
    res.json({ matches: grouped, league: league.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/schedule/:date', async (req, res) => {
  try {
    // Tüm maçlar sekmesi için performansı korumak adına futbol ve basketbolu birleştiriyoruz
    const [fb, bb] = await Promise.all([
      api(`/sport/football/scheduled-events/${req.params.date}`).catch(() => ({ events: [] })),
      api(`/sport/basketball/scheduled-events/${req.params.date}`).catch(() => ({ events: [] }))
    ]);
    
    const events = [...(fb.events || []), ...(bb.events || [])].filter(e => {
      const tid = e.tournament?.uniqueTournament?.id;
      return Object.values(TOURNAMENTS).some(t => t.id === tid);
    });

    const grouped = {};
    events.forEach(e => {
      const tName = e.tournament?.uniqueTournament?.name || 'Diğer';
      const tId = e.tournament?.uniqueTournament?.id;
      if (!grouped[tId]) grouped[tId] = { name: tName, matches: [] };
      grouped[tId].matches.push(formatEvent(e));
    });
    res.json({ groups: grouped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/live', async (req, res) => {
  try {
    const data = await api('/sport/football/events/live');
    const events = (data.events || []).map(formatEvent);
    res.json({ matches: events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/standings/:leagueId', async (req, res) => {
  const league = TOURNAMENTS[req.params.leagueId];
  if (!league) return res.status(400).json({ error: 'Geçersiz lig' });
  try {
    const data = await api(`/unique-tournament/${league.id}/season/latest/standings/total`);
    const rows = (data.standings?.[0]?.rows || []).map(r => ({
      pos: r.position,
      team: { name: r.team?.shortName || r.team?.name, img: `https://api.sofascore.app/api/v1/team/${r.team?.id}/image` },
      played: r.matches, won: r.wins, drawn: r.draws, lost: r.losses,
      gf: r.scoresFor, ga: r.scoresAgainst, gd: r.scoresFor - r.scoresAgainst, pts: r.points
    }));
    res.json({ standings: rows, league: league.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/event/:id/stats', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/statistics`);
    const allStats = [];
    (data.statistics || []).forEach(period => {
      (period.groups || []).forEach(group => {
        (group.statisticsItems || []).forEach(item => {
          allStats.push({ name: item.name, home: item.homeValue, away: item.awayValue, group: group.groupName, period: period.period });
        });
      });
    });
    res.json({ statistics: allStats, raw: data.statistics });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/event/:id/lineups', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/lineups`);
    const formatPlayers = (teamData) => {
      if (!teamData) return [];
      return (teamData.players || []).map(p => ({
        id: p.player?.id, name: p.player?.shortName || p.player?.name,
        number: p.shirtNumber, position: p.position, substitute: p.substitute || false, captain: p.captain || false,
        rating: p.statistics?.rating ? parseFloat(p.statistics.rating).toFixed(1) : null,
        img: `https://api.sofascore.app/api/v1/player/${p.player?.id}/image`,
        stats: {
          goals: p.statistics?.goals || 0, assists: p.statistics?.assists || 0,
          yellowCards: p.statistics?.yellowCards || 0, redCards: p.statistics?.redCards || 0,
          shots: p.statistics?.totalShots || 0, fouls: p.statistics?.fouls || 0,
          keyPasses: p.statistics?.keyPasses || 0, tackles: p.statistics?.totalTackle || 0, saves: p.statistics?.saves || 0
        }
      }));
    };
    res.json({
      home: { formation: data.home?.formation, players: formatPlayers(data.home) },
      away: { formation: data.away?.formation, players: formatPlayers(data.away) },
      confirmed: data.confirmed || false,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/event/:id/incidents', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}/incidents`);
    const incidents = (data.incidents || []).map(inc => ({
      type: inc.incidentType, time: inc.time, addedTime: inc.addedTime, isHome: inc.isHome, text: inc.text,
      playerName: inc.player?.shortName || inc.player?.name, playerIn: inc.playerIn?.shortName, playerOut: inc.playerOut?.shortName,
      incidentClass: inc.incidentClass, homeScore: inc.homeScore, awayScore: inc.awayScore
    }));
    res.json({ incidents });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/event/:id', async (req, res) => {
  try {
    const data = await api(`/event/${req.params.id}`);
    res.json({ event: formatEvent(data.event) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`\n🟢 VivoScore Pro Aktif: Port ${PORT}\n`));
