const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
// Render için PORT yapılandırması (Önemli!)
const PORT = process.env.PORT || 3000;

// BURAYI GÜNCELLE: Mailine gelen API KEY'i buraya yapıştır
const FOOTBALL_DATA_API_KEY = "BURAYA_MAILDEKI_KODU_YAZ"; 
const BASE_URL = 'https://api.football-data.org/v2';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Bellek Cache Sistemi ───
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // Ücretsiz plan sınırı nedeniyle 2 dakika ideal

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Güncellenmiş API İstek Fonksiyonu ───
async function api(endpoint) {
  const cached = getCached(endpoint);
  if (cached) return cached;

  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`API Hatası: ${res.status} - ${errorData.message || res.statusText}`);
    }

    const data = await res.json();
    setCache(endpoint, data);
    return data;
  } catch (err) {
    console.error(`[API ERROR] ${endpoint}:`, err.message);
    throw err;
  }
}

// ─── Football-Data.org Uyumlu Lig Kodları ───
const TOURNAMENTS = {
  PL:  { code: 'PL',  name: 'Premier League',   country: 'İngiltere' },
  CL:  { code: 'CL',  name: 'Champions League',  country: 'Avrupa' },
  SA:  { code: 'SA',  name: 'Serie A',           country: 'İtalya' },
  PD:  { code: 'PD',  name: 'La Liga',           country: 'İspanya' },
  BL1: { code: 'BL1', name: 'Bundesliga',        country: 'Almanya' },
  FL1: { code: 'FL1', name: 'Ligue 1',           country: 'Fransa' }
};

// ─── Maç Verisi Formatlayıcı (Yeni API Yapısına Uygun) ───
function formatEvent(e) {
  return {
    id: e.id,
    status: e.status.toLowerCase(),
    minute: e.status === 'IN_PLAY' ? 'Canlı' : null,
    timestamp: new Date(e.utcDate).getTime(),
    date: e.utcDate.slice(0, 10),
    time: new Date(e.utcDate).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
    tournament: { name: e.competition?.name },
    homeTeam: { name: e.homeTeam.name, img: `https://crests.football-data.org/${e.homeTeam.id}.png` },
    awayTeam: { name: e.awayTeam.name, img: `https://crests.football-data.org/${e.awayTeam.id}.png` },
    homeScore: e.score?.fullTime?.homeTeam ?? 0,
    awayScore: e.score?.fullTime?.awayTeam ?? 0
  };
}

// ═══════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════

// 1) Lig Listesi
app.get('/api/tournaments', (req, res) => res.json(TOURNAMENTS));

// 2) Lig Maçları
app.get('/api/matches/:leagueId', async (req, res) => {
  try {
    const leagueCode = req.params.leagueId;
    const data = await api(`/competitions/${leagueCode}/matches`);
    
    const grouped = {};
    data.matches.slice(-40).forEach(e => {
      const m = formatEvent(e);
      if (!grouped[m.date]) grouped[m.date] = [];
      grouped[m.date].push(m);
    });
    res.json({ matches: grouped, league: data.competition.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3) Puan Durumu
app.get('/api/standings/:leagueId', async (req, res) => {
  try {
    const data = await api(`/competitions/${req.params.leagueId}/standings`);
    const table = data.standings[0].table.map(r => ({
      pos: r.position,
      team: { name: r.team.name, img: r.team.crestUrl || `https://crests.football-data.org/${r.team.id}.png` },
      played: r.playedGames,
      won: r.won,
      drawn: r.draws,
      lost: r.lost,
      pts: r.points,
      gd: r.goalDifference
    }));
    res.json({ standings: table, league: data.competition.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA Yönlendirmesi
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`\n🟢 Sunucu Yayında: Port ${PORT}\n`));
