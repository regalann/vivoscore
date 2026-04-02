// ═══════════════════════════════════════════════
//  ARAMA ENDPOİNTİ (RAPIDAPI BYPASS - DİREKT PUBLIC API)
// ═══════════════════════════════════════════════
function validateSearchQuery(q) {
  if (typeof q !== 'string') return false;
  if (q.length < 2 || q.length > 80) return false;
  return /^[\p{L}\p{N}\s\-'.]+$/u.test(q);
}

app.get('/api/search/:sport', async (req, res) => {
  const { sport } = req.params;
  const q = (req.query.q || '').trim();

  if (!validateSport(sport)) return res.status(400).json({ error: 'Geçersiz spor dalı' });
  if (!validateSearchQuery(q)) return res.status(400).json({ error: 'Geçersiz arama sorgusu (en az 2 karakter)' });

  const cacheKey = `search_${sport}_${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // ÇÖZÜM: sportapi7 404 verdiği için RapidAPI'yi es geçip direkt açık SofaScore arama motoruna istek atıyoruz.
    const response = await fetch(`https://api.sofascore.app/api/v1/search/all?q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://www.sofascore.com',
        'Referer': 'https://www.sofascore.com/'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      throw new Error(response.status.toString());
    }

    const data = await response.json();
    const results = { teams: [], players: [] };

    // Gelen veriyi kendi formatımıza (frontend'in beklediği hale) çeviriyoruz
    if (data && data.results) {
      data.results.forEach(r => {
        if (r.type === 'team' && r.entity) {
          results.teams.push(sanitizeObject({
            id: Number(r.entity.id) || 0,
            name: r.entity.name || '',
            shortName: r.entity.shortName || r.entity.name || '',
            img: `https://api.sofascore.app/api/v1/team/${Number(r.entity.id) || 0}/image`,
            country: r.entity.country?.name || '',
            tournament: r.entity.tournament?.uniqueTournament?.name || r.entity.tournament?.name || ''
          }));
        }
        if (r.type === 'player' && r.entity) {
          results.players.push(sanitizeObject({
            id: Number(r.entity.id) || 0,
            name: r.entity.name || '',
            shortName: r.entity.shortName || r.entity.name || '',
            img: `https://api.sofascore.app/api/v1/player/${Number(r.entity.id) || 0}/image`,
            position: r.entity.position || '',
            teamName: r.entity.team?.name || '',
            teamId: Number(r.entity.team?.id) || 0
          }));
        }
      });
    }

    setCache(cacheKey, results);
    res.json(results);

  } catch (err) {
    console.error(`[SEARCH BYPASS HATA] ${sport}/${q} -> Kod: ${err.message}`);
    
    let hataMesaji = 'Arama servisi şu an yanıt vermiyor.';
    if (err.message === '429') hataMesaji = 'Çok sık arama yapıldı, lütfen biraz bekleyin.';
    else if (err.message === '404' || err.message === '403') hataMesaji = 'Arama servisi geçici olarak reddetti.';
    
    res.status(500).json({ error: hataMesaji });
  }
});
