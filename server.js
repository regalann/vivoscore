const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// RapidAPI'den aldığın Key buraya gelecek
const RAPID_API_KEY = process.env.FOOTBALL_API_KEY; 
const BASE_URL = 'https://sportapi7.p.rapidapi.com/api/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function fetchFromSportApi(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'x-rapidapi-key': RAPID_API_KEY,
      'x-rapidapi-host': 'sportapi7.p.rapidapi.com',
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`API Hatası: ${res.status}`);
  return res.json();
}

// 1. Maç Listesi (Bugünün Maçları)
app.get('/api/matches/:leagueId', async (req, res) => {
  const { leagueId } = req.params;
  const leagueMap = { "PL": 17, "CL": 7, "BL1": 35, "SA": 23, "PD": 8 }; // SportAPI ID'leri
  const tournamentId = leagueMap[leagueId] || 17;

  try {
    const today = new Date().toISOString().split('T')[0];
    // SportAPI üzerinde belirli bir tarihteki maçları çekiyoruz
    const data = await fetchFromSportApi(`/unique-tournament/${tournamentId}/season/latest/events/last/0`); 
    
    const matches = (data.events || []).slice(0, 20).map(m => ({
      id: m.id,
      status: m.status.type,
      utcDate: m.startTimestamp * 1000,
      homeTeam: { name: m.homeTeam.shortName, crest: `https://api.sofascore.app/api/v1/team/${m.homeTeam.id}/image` },
      awayTeam: { name: m.awayTeam.shortName, crest: `https://api.sofascore.app/api/v1/team/${m.awayTeam.id}/image` },
      score: { home: m.homeScore.current, away: m.awayScore.current }
    }));
    
    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Maç Detayı (İstatistikler ve Reytingler)
app.get('/api/match-details/:id', async (req, res) => {
  try {
    const stats = await fetchFromSportApi(`/event/${req.params.id}/statistics`);
    const lineups = await fetchFromSportApi(`/event/${req.params.id}/lineups`);
    res.json({ stats, lineups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ VivoScore Pro Aktif: ${PORT}`));
