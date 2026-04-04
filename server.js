app.get('/api/event/:id/lineups', async (req, res) => {
  if (!validateId(req.params.id)) return res.status(400).json({ error: 'Geçersiz ID' });
  try {
    const data = await api(`/event/${req.params.id}/lineups`);
    
    // As ve Yedek oyuncuları formatlayan fonksiyon
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

    // Sakat, Cezalı ve Şüpheli oyuncuları formatlayan YENİ fonksiyon
    const formatMissing = (td) => (td?.missing || []).map(p => sanitizeObject({
      id: Number(p.player?.id) || 0, 
      name: p.player?.shortName || p.player?.name || '', 
      type: p.type || '',      // Sakatlık veya Ceza tipi
      reason: p.reason || ''   // Açıklama (Örn: Bilek sakatlığı)
    }));

    // Ön yüze hem oyuncuları hem de eksik (missing) listesini gönderiyoruz
    res.json({ 
        home: { 
            formation: sanitizeString(data.home?.formation || ''), 
            players: formatPlayers(data.home),
            missing: formatMissing(data.home) // <-- EKLENDİ
        }, 
        away: { 
            formation: sanitizeString(data.away?.formation || ''), 
            players: formatPlayers(data.away),
            missing: formatMissing(data.away) // <-- EKLENDİ
        } 
    });
  } catch (err) { 
    res.status(500).json({ error: 'Sunucu hatası' }); 
  }
});
