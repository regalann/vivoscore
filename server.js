const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
// API Anahtarı artık Render panelinden gelecek
const API_KEY = process.env.FOOTBALL_API_KEY; 
const BASE_URL = 'https://api.football-data.org/v4';

if (!API_KEY) {
  console.error('❌ FOOTBALL_API_KEY bulunamadı!');
  process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./vivoskor.db', (err) => {
  if (err) console.error('❌ Veritabanı Hatası:', err.message);
  else console.log('✅ SQLite Veritabanı Aktif (vivoskor.db)');
});

db.run(`CREATE TABLE IF NOT EXISTS favorites (
  client_id TEXT,
  match_id INTEGER,
  PRIMARY KEY (client_id, match_id)
)`);

const cache = {};
const CACHE_TTL = 60 * 1000;

async function fetchFromApi(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'X-Auth-Token': API_KEY }
  });
  if (!res.ok) throw new Error(`API hatası: ${res.status}`);
  return res.json();
}

function resolveScore(match) {
  const s = match.score;
  const src = s?.fullTime?.home != null ? s.fullTime : s?.regularTime?.home != null ? s.regularTime : null;
  return { home: src?.home ?? null, away: src?.away ?? null };
}

app.get('/api/matches/:leagueId', async (req, res) => {
  const { leagueId } = req.params;
  
  if (cache[leagueId] && Date.now() - cache[leagueId].timestamp < CACHE_TTL) {
    return res.json({ source: 'cache', matches: cache[leagueId].data });
  }

  try {
    const data = await fetchFromApi(`/competitions/${leagueId}/matches?status=SCHEDULED,IN_PLAY,PAUSED,FINISHED`);
    const matches = (data.matches || []).slice(-30).reverse().map(m => ({
      id: m.id,
      status: m.status,
      utcDate: m.utcDate,
      minute: m.minute ?? null,
      homeTeam: { name: m.homeTeam.name, shortName: m.homeTeam.shortName || m.homeTeam.name, crest: m.homeTeam.crest },
      awayTeam: { name: m.awayTeam.name, shortName: m.awayTeam.shortName || m.awayTeam.name, crest: m.awayTeam.crest },
      score: resolveScore(m)
    }));
    
    cache[leagueId] = { data: matches, timestamp: Date.now() };
    res.json({ source: 'api', matches });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası: ' + err.message });
  }
});

app.get('/api/favorites/:clientId', (req, res) => {
  db.all('SELECT match_id FROM favorites WHERE client_id = ?', [req.params.clientId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ favorites: rows.map(r => r.match_id) });
  });
});

app.post('/api/favorites', (req, res) => {
  db.run('INSERT OR IGNORE INTO favorites (client_id, match_id) VALUES (?, ?)', [req.body.clientId, req.body.matchId], (err) => {
    res.json({ success: !err });
  });
});

app.delete('/api/favorites', (req, res) => {
  db.run('DELETE FROM favorites WHERE client_id = ? AND match_id = ?', [req.body.clientId, req.body.matchId], (err) => {
    res.json({ success: !err });
  });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✅ Vivo Skor sunucusu çalışıyor → Port: ${PORT}`);
});