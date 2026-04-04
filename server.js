// ═══════════════════════════════════════════════
//  🔍 ARAMA MODÜLÜ (Search)
// ═══════════════════════════════════════════════
var Search = {
  _timer: null,
  _focusIdx: -1,
  _isOpen: false,

  init: function() {
    var input = document.getElementById('searchInput');
    var wrap = document.getElementById('searchWrap');
    var dropdown = document.getElementById('searchDropdown');
    if (!input) return;

    input.addEventListener('input', function() {
      var val = input.value.trim();
      wrap.classList.toggle('has-value', val.length > 0);
      clearTimeout(Search._timer);
      if (val.length < 2) { Search.close(); return; }
      Search._timer = setTimeout(function() { Search.doSearch(val); }, 400);
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { Search.close(); input.blur(); return; }
      if (!Search._isOpen) return;
      var items = dropdown.querySelectorAll('.search-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); Search._focusIdx = Math.min(Search._focusIdx + 1, items.length - 1); Search._highlight(items); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); Search._focusIdx = Math.max(Search._focusIdx - 1, 0); Search._highlight(items); }
      else if (e.key === 'Enter' && Search._focusIdx >= 0 && items[Search._focusIdx]) { e.preventDefault(); items[Search._focusIdx].click(); }
    });

    document.addEventListener('click', function(e) {
      var c = document.getElementById('searchContainer');
      if (c && !c.contains(e.target)) Search.close();
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === '/' && document.activeElement !== input && !e.ctrlKey && !e.metaKey) {
        var tag = (document.activeElement || {}).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault(); input.focus();
      }
    });
  },

  doSearch: function(query) {
    var dropdown = document.getElementById('searchDropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '<div class="search-loading"><div class="spinner"></div> Aranıyor...</div>';
    dropdown.classList.add('active');
    Search._isOpen = true;
    Search._focusIdx = -1;

    V.apiFetch('/api/search/' + encodeURIComponent(V.state.selectedSport) + '?q=' + encodeURIComponent(query))
      .then(function(data) { Search._render(data, query); })
      .catch(function(err) {
        dropdown.innerHTML = '<div class="search-no-result"><div class="snr-icon">⚠️</div>Arama sırasında hata oluştu.<br><span style="font-size:11px;color:var(--text3)">' + esc(err.message || '') + '</span></div>';
      });
  },

  _render: function(data, query) {
    var dropdown = document.getElementById('searchDropdown');
    if (!dropdown) return;
    var teams = data.teams || []; var players = data.players || [];
    if (teams.length === 0 && players.length === 0) {
      dropdown.innerHTML = '<div class="search-no-result"><div class="snr-icon">🔍</div>"<strong>' + esc(query) + '</strong>" için sonuç bulunamadı.</div>';
      return;
    }

    var html = '';
    if (teams.length > 0) {
      html += '<div id="searchMatchSection"><div class="search-loading" style="padding:12px;"><div class="spinner" style="width:14px;height:14px;"></div> Maçlar yükleniyor...</div></div>';
    }

    if (teams.length > 0) {
      html += '<div class="search-section-title">TAKIMLAR</div>';
      for (var i = 0; i < Math.min(teams.length, 5); i++) {
        var t = teams[i];
        html += '<div class="search-item" onclick="Search.pickTeam(' + t.id + ')">' +
          '<img src="' + safeImgUrl(t.img) + '" onerror="this.src=\'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=\'">' +
          '<div class="search-item-info"><div class="search-item-name">' + Search._hl(t.name, query) + '</div>' +
          '<div class="search-item-sub">' + esc(t.tournament || t.country || '') + '</div></div>' +
          '<span class="search-item-badge team">Takım</span></div>';
      }
    }

    if (players.length > 0) {
      html += '<div class="search-section-title">OYUNCULAR</div>';
      for (var j = 0; j < Math.min(players.length, 5); j++) {
        var p = players[j];
        var posMap = { G:'Kaleci', D:'Defans', M:'Ortasaha', F:'Forvet' };
        var posLabel = posMap[p.position] || p.position || '';
        html += '<div class="search-item" onclick="Search.pickPlayer(' + p.id + ',\'' + esc(p.name).replace(/'/g,"\\'") + '\',\'' + esc(posLabel).replace(/'/g,"\\'") + '\',\'' + safeImgUrl(p.img).replace(/'/g,"\\'") + '\')">' +
          '<img src="' + safeImgUrl(p.img) + '" onerror="this.src=\'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=\'">' +
          '<div class="search-item-info"><div class="search-item-name">' + Search._hl(p.name, query) + '</div>' +
          '<div class="search-item-sub">' + esc(p.teamName || '') + (posLabel ? ' · ' + posLabel : '') + '</div></div>' +
          '<span class="search-item-badge player">Oyuncu</span></div>';
      }
    }
    dropdown.innerHTML = html;

    if (teams.length > 0) {
      Search._loadMatchesForTeams(teams.slice(0, 3));
    }
  },

  _loadMatchesForTeams: function(teams) {
    var promises = teams.map(function(t) {
      return V.apiFetch('/api/team/' + t.id + '/events').catch(function() { return null; });
    });

    Promise.all(promises).then(function(results) {
      var matchItems = [];
      var seenIds = {};

      results.forEach(function(data, idx) {
        if (!data || !data.matches) return;
        var matches = data.matches;

        matches.filter(function(m) { return m.status === 'live'; }).forEach(function(m) {
          if (!seenIds[m.id]) { seenIds[m.id] = true; matchItems.unshift({ match: m, type: 'live' }); }
        });

        var upcoming = matches.filter(function(m) { return m.status === 'scheduled' && m.timestamp > Date.now() - 86400000; });
        upcoming.sort(function(a, b) { return a.timestamp - b.timestamp; });
        if (upcoming.length > 0 && !seenIds[upcoming[0].id]) {
          seenIds[upcoming[0].id] = true;
          matchItems.push({ match: upcoming[0], type: 'upcoming' });
        }
      });

      var section = document.getElementById('searchMatchSection');
      if (!section) return;

      if (matchItems.length === 0) {
        section.remove();
        return;
      }

      var mHtml = '<div class="search-section-title">MAÇLAR</div>';
      matchItems.forEach(function(item) {
        var m = item.match;
        var isLive = item.type === 'live';
        var hasScore = m.homeScore !== null && m.homeScore !== undefined;

        var statusHtml = '';
        if (isLive) {
          statusHtml = '<span style="background:var(--green);color:#000;font-size:10px;font-weight:800;padding:2px 6px;border-radius:4px;animation:pulse-live 1.5s infinite;">' + esc(m.minute || 'CANLI') + '</span>';
        } else {
          var dParts = m.date ? m.date.split('-') : [];
          var shortDate = dParts.length === 3 ? dParts[2] + '/' + dParts[1] : '';
          statusHtml = '<span style="font-size:12px;color:var(--text3);font-weight:600;">' + shortDate + ' ' + esc(m.time || '') + '</span>';
        }

        var scoreHtml = hasScore ? '<span style="font-size:15px;font-weight:800;color:' + (isLive ? 'var(--green)' : 'var(--text)') + ';">' + m.homeScore + ' - ' + m.awayScore + '</span>' : '<span style="font-size:13px;color:var(--text3);">vs</span>';

        mHtml += '<div class="search-item" onclick="Search.pickMatch(' + m.id + ')" style="padding:12px 14px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
              '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">' +
                '<img src="' + safeImgUrl(m.homeTeam.img) + '" onerror="this.style.visibility=\'hidden\'" style="width:20px;height:20px;object-fit:contain;">' +
                '<span style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(m.homeTeam.shortName) + '</span>' +
              '</div>' +
              scoreHtml +
              '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;justify-content:flex-end;">' +
                '<span style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(m.awayTeam.shortName) + '</span>' +
                '<img src="' + safeImgUrl(m.awayTeam.img) + '" onerror="this.style.visibility=\'hidden\'" style="width:20px;height:20px;object-fit:contain;">' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;align-items:center;justify-content:space-between;">' +
              statusHtml +
              '<span style="font-size:11px;color:var(--text3);">' + esc(m.tournament.name || '') + '</span>' +
            '</div>' +
          '</div>' +
          '<span class="search-item-badge" style="background:var(--green-dim);color:var(--green);">Maç</span></div>';
      });

      section.innerHTML = mHtml;
    }).catch(function() {
      var section = document.getElementById('searchMatchSection');
      if (section) section.remove();
    });
  },

  pickMatch: function(matchId) {
    Search.clear();
    V.showDetail(matchId);
  },

  _hl: function(text, q) {
    if (!q || !text) return esc(text);
    var s = esc(text), sq = esc(q);
    return s.replace(new RegExp('(' + sq.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi'), '<mark>$1</mark>');
  },

  _highlight: function(items) {
    items.forEach(function(el, i) { el.classList.toggle('focused', i === Search._focusIdx); });
    if (Search._focusIdx >= 0 && items[Search._focusIdx]) items[Search._focusIdx].scrollIntoView({ block: 'nearest' });
  },

  pickTeam: function(teamId) {
    Search.clear();
    Search._lastTeamId = teamId;
    var panel = document.getElementById('detailPanel'); if (!panel) return;
    panel.classList.add('open');
    panel.innerHTML = '<div class="loading" style="height:100%"><div class="spinner"></div><div class="loading-text">Takım maçları yükleniyor...</div></div>';
    V.apiFetch('/api/team/' + teamId + '/events').then(function(data) {
      var matches = data.matches || [];
      var teamImg = 'https://api.sofascore.app/api/v1/team/' + teamId + '/image';
      var teamName = matches.length > 0 ? (matches[0].homeTeam.id == teamId ? matches[0].homeTeam.name : matches[0].awayTeam.name) : 'Takım';
      var html = '<div class="detail-header" style="position:relative"><div class="btn-close-panel" onclick="V.closeDetail()">✕</div>' +
        '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 0;">' +
        '<img src="' + safeImgUrl(teamImg) + '" onerror="this.style.display=\'none\'" style="width:56px;height:56px;object-fit:contain;">' +
        '<div style="font-size:18px;font-weight:800">' + esc(teamName) + '</div></div></div>';
      html += '<div class="detail-content" style="padding:16px;">';
      if (matches.length === 0) { html += T.empty('Maç bulunamadı'); }
      else {
        var now = Date.now();
        var live=[], upcoming=[], finished=[];
        matches.forEach(function(m) {
          if (m.status === 'live') live.push(m);
          else if (m.status === 'scheduled') {
            if (m.timestamp > now - 86400000) upcoming.push(m); 
          }
          else finished.push(m);
        });
        upcoming.sort(function(a,b){ return a.timestamp - b.timestamp; });
        finished.sort(function(a,b){ return b.timestamp - a.timestamp; });

        var makeCard = function(m) {
          var hasScore = m.homeScore !== null && m.homeScore !== undefined;
          var hS = hasScore ? safeNum(m.homeScore) : '-'; var aS = hasScore ? safeNum(m.awayScore) : '-';
          var hW = hasScore && m.homeScore > m.awayScore; var aW = hasScore && m.awayScore > m.homeScore;
          var dParts = m.date ? m.date.split('-') : []; var shortDate = dParts.length === 3 ? (dParts[2] + '/' + dParts[1]) : m.time;
          var resClass = hW ? 'border-left:3px solid var(--brand);' : aW ? 'border-left:3px solid var(--orange);' : 'border-left:3px solid var(--text3);';
          var scoreStr = (hS === '-' && aS === '-') ? 'vs' : hS + ' - ' + aS;
          return '<div onclick="Search.pickMatchFromTeam(' + m.id + ',' + teamId + ')" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;font-size:13px;cursor:pointer;transition:var(--transition);' + resClass + '" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'var(--surface)\'">' +
            '<div style="color:var(--text3);width:40px;font-size:11px;font-weight:600;">' + shortDate + '</div>' +
            '<div style="flex:1;text-align:right;font-weight:600;color:' + (hW ? 'var(--text)' : 'var(--text2)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(m.homeTeam.shortName) + '</div>' +
            '<div style="padding:0 12px;font-weight:800;font-size:14px;color:var(--text)">' + scoreStr + '</div>' +
            '<div style="flex:1;text-align:left;font-weight:600;color:' + (aW ? 'var(--text)' : 'var(--text2)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(m.awayTeam.shortName) + '</div>' +
          '</div>';
        };

        if (live.length) { html += '<div class="stat-group-title" style="color:var(--green)">🔴 Canlı</div>'; live.forEach(function(m){ html += makeCard(m); }); }
        if (upcoming.length) { html += '<div class="stat-group-title" style="color:var(--brand)">📅 Yaklaşan</div>'; upcoming.slice(0,5).forEach(function(m){ html += makeCard(m); }); }
        if (finished.length) { html += '<div class="stat-group-title">✅ Tamamlanan</div>'; finished.slice(0,10).forEach(function(m){ html += makeCard(m); }); }
      }
      panel.innerHTML = html + '</div>';
    }).catch(function(err) {
      panel.innerHTML = '<div class="detail-header" style="position:relative"><div class="btn-close-panel" onclick="V.closeDetail()">✕</div></div><div class="detail-content">' + T.empty('Yüklenemedi: ' + (err.message||'')) + '</div>';
    });
  },

  pickMatchFromTeam: function(matchId, teamId) {
    Search._lastTeamId = teamId;
    V.state.selectedMatch = matchId;
    V.state.detailTab = 'summary';
    var panel = document.getElementById('detailPanel'); if (!panel) return;
    panel.innerHTML = '<div class="loading" style="height:100%"><div class="spinner"></div><div class="loading-text">Maç detayları yükleniyor...</div></div>';
    V.apiFetch('/api/event/' + matchId).then(function(data) {
      V.state.matchCache[matchId] = { match: data.event };
      V.renderDetail(matchId);
      setTimeout(function() {
        var backBtn = panel.querySelector('.btn-back-panel');
        if (!backBtn) {
          var header = panel.querySelector('.detail-header');
          if (header) {
            var btn = document.createElement('div');
            btn.className = 'btn-back-panel';
            btn.innerHTML = '←';
            btn.onclick = function() { Search.pickTeam(teamId); };
            header.appendChild(btn);
          }
        } else {
          backBtn.onclick = function() { Search.pickTeam(teamId); };
        }
      }, 100);
    }).catch(function() {
      panel.innerHTML = '<div class="detail-header" style="position:relative"><div class="btn-close-panel" onclick="V.closeDetail()">✕</div></div><div class="detail-content">' + T.empty('Maç detayları yüklenemedi') + '</div>';
    });
  },

  pickPlayer: function(id, name, pos, img) {
    Search.clear();
    V.state.playerData[id] = { id: id, name: name, pos: pos, img: img, rating: null, stats: {} };
    V.showPlayerModal(id);
  },

  clear: function() {
    var input = document.getElementById('searchInput');
    var wrap = document.getElementById('searchWrap');
    var dropdown = document.getElementById('searchDropdown');
    if (input) input.value = '';
    if (wrap) wrap.classList.remove('has-value');
    if (dropdown) dropdown.classList.remove('active');
    Search._isOpen = false;
    Search._focusIdx = -1;
  },

  close: function() {
    var dropdown = document.getElementById('searchDropdown');
    if (dropdown) dropdown.classList.remove('active');
    Search._isOpen = false;
    Search._focusIdx = -1;
  }
};
