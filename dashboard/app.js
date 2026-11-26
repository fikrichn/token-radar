// Token Launch Radar — the page. Everything renders from window.RADAR, the data file the
// entry's program writes beside this page from the same board it hands in: what the reader
// sees is what the model computed, with no second copy of the logic to drift from it.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) {
    if (v == null) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }
  function pct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
  function ageText(days) {
    if (days == null) return '—';
    if (days < 365) return days + 'd';
    return (days / 365).toFixed(1) + 'y';
  }
  function verdictClass(v) {
    return v === 'Farm first' ? 'v-first' : v === 'Farm' ? 'v-farm' : v === 'Farm cheap' ? 'v-cheap' : 'v-watch';
  }

  // Masthead and integrity strip: the model's report card, always on screen.
  el('mastheadMeta').innerHTML =
    '<strong>' + R.board_size + ' protocols ranked</strong><br>snapshot of ' + esc(R.as_of) + '<br>' + esc(R.source);
  var ig = R.integrity;
  var folds = ig.held_out.map(function (h, i) {
    return '<span><span class="lab">Held-out ' + (i + 1) + '</span>median error <b>×' + h.median_error_x + '</b> (' + h.within_3x_pct + '% within ×3, fit on ' + h.trained_on + ', tested on ' + h.tested_on + ')</span>';
  }).join('');
  el('integrityStrip').innerHTML = '<div class="strip-in">' +
    '<span><span class="lab">Model</span><b>' + esc(R.model_version) + '</b>, fitted on <b>' + ig.peers + '</b> traded peers</span>' +
    '<span><span class="lab">Fit</span>R² <b>' + ig.r2 + '</b> in log space, terms: TVL, growth, age, chains, category (' + ig.categories_fitted.map(esc).join(', ') + ')</span>' +
    folds +
    '<span><span class="lab">Odds base</span><b>' + ig.token_share_pct + '%</b> of the snapshot already carries a token</span>' +
    '<span><span class="lab">Coverage</span>watchlist <b>' + R.watchlist_size + '/' + R.watchlist_size + '</b>, board <b>' + R.board_size + '</b> rows, <b>' + R.screened_size + '</b> screened out</span>' +
    '</div>';

  // Filters.
  var cats = [];
  var chains = [];
  R.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  el('categoryFilter').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  el('chainFilter').innerHTML = '<option value="">All chains</option>' + chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  var sortKey = 'rank';
  var sortDir = 1;

  function visibleRows() {
    var q = el('search').value.trim().toLowerCase();
    var cat = el('categoryFilter').value;
    var chain = el('chainFilter').value;
    var wl = el('watchlistOnly').checked;
    var ff = el('farmFirstOnly').checked;
    var rows = R.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      if (cat && r.category !== cat) return false;
      if (chain && r.chains.indexOf(chain) < 0) return false;
      if (wl && !r.watchlist) return false;
      if (ff && r.verdict !== 'Farm first' && r.verdict !== 'Farm') return false;
      return true;
    });
    rows.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return sortDir * (x < y ? -1 : x > y ? 1 : 0);
      return sortDir * (x - y);
    });
    return rows;
  }

  function renderBoard() {
    var rows = visibleRows();
    el('rowCount').textContent = 'Showing ' + rows.length + ' of ' + R.rows.length + ' ranked protocols' + (sortKey !== 'rank' ? ' — sorted by ' + sortKey + ' (rank is the model\u2019s own order)' : '');
    el('boardBody').innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + (r.watchlist ? '<span class="wl">WATCHLIST</span>' : '') + '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num money">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d == null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num"><span class="oddsbar"><i style="width:' + r.token_odds_pct + '%"></i></span>' + r.token_odds_pct + '%</td>' +
        '<td class="num money"><strong>' + money(r.implied_value_usd) + '</strong></td>' +
        '<td class="num money">' + money(r.expected_value_usd) + '</td>' +
        '<td><span class="verdict ' + verdictClass(r.verdict) + '">' + esc(r.verdict) + '</span></td>' +
        '</tr>';
    }).join('');
    var trs = el('boardBody').querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { openDrawer(this.getAttribute('data-slug')); });
    }
    var ths = document.querySelectorAll('#board th.sortable');
    for (var j = 0; j < ths.length; j++) ths[j].classList.toggle('sorted', ths[j].getAttribute('data-key') === sortKey);
  }

  // Detail drawer: the model's working, term by term, then the farm plan.
  function mult(term) { return '×' + Math.pow(10, term).toFixed(2); }
  function openDrawer(slug) {
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    var t = r.terms;
    el('drawerBody').innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">Rank #' + r.rank + ' · ' + esc(r.category || 'Uncategorized') + ' · ' + esc(r.chains.join(', ') || 'no chain listed') + (r.watchlist ? ' · on the snapshot watchlist' : '') + '</p>' +
      '<div class="kv">' +
      '<div><div class="k">Implied launch value</div><div class="v">' + money(r.implied_value_usd) + '</div></div>' +
      '<div><div class="k">Token odds (peers\u2019 record)</div><div class="v">' + r.token_odds_pct + '%</div></div>' +
      '<div><div class="k">Expected value</div><div class="v">' + money(r.expected_value_usd) + '</div></div>' +
      '<div><div class="k">TVL · 7d · age</div><div class="v">' + money(r.tvl_usd) + ' · ' + pct(r.change_7d) + ' · ' + ageText(r.age_days) + '</div></div>' +
      '<div><div class="k">Farm capital</div><div class="v">$' + r.capital_usd + '</div></div>' +
      '<div><div class="k">Plan cost (out of pocket)</div><div class="v">$' + r.plan_cost_usd + '</div></div>' +
      '</div>' +
      '<h3>How the value is fitted</h3>' +
      '<table class="terms"><thead><tr><th>Term</th><th class="num">log10</th><th class="num">As a multiple</th></tr></thead><tbody>' +
      '<tr><td>Base (fit intercept)</td><td class="num">' + t.intercept + '</td><td class="num">' + mult(t.intercept) + '</td></tr>' +
      '<tr><td>TVL of ' + money(r.tvl_usd) + '</td><td class="num">' + t.tvl_term + '</td><td class="num">' + mult(t.tvl_term) + '</td></tr>' +
      '<tr><td>Seven-day growth</td><td class="num">' + t.growth_term + '</td><td class="num">' + mult(t.growth_term) + '</td></tr>' +
      '<tr><td>Age with no token</td><td class="num">' + t.age_term + '</td><td class="num">' + mult(t.age_term) + '</td></tr>' +
      '<tr><td>Chain breadth (' + r.chains.length + ')</td><td class="num">' + t.chain_term + '</td><td class="num">' + mult(t.chain_term) + '</td></tr>' +
      '<tr><td>Category: ' + esc(t.category || 'pooled') + '</td><td class="num">' + t.category_term + '</td><td class="num">' + mult(t.category_term) + '</td></tr>' +
      '<tr><td><strong>Predicted log10 value</strong></td><td class="num"><strong>' + t.predicted_log10 + '</strong></td><td class="num"><strong>' + money(r.implied_value_usd) + '</strong></td></tr>' +
      '</tbody></table>' +
      '<div class="verdictbox"><span class="big">' + esc(r.verdict) + '</span> — expected ' + money(r.expected_value_usd) + ' against about $' + r.plan_cost_usd + ' of out-of-pocket cost; the $' + r.capital_usd + ' of capital stays yours.</div>' +
      '<h3>The farm plan</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    el('drawer').hidden = false;
  }
  el('drawerClose').addEventListener('click', function () { el('drawer').hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') el('drawer').hidden = true; });

  // Live peers view.
  el('liveBody').innerHTML = R.live.map(function (p) {
    var ratio = p.actual_over_predicted;
    var cls = ratio >= 0.5 && ratio <= 2 ? 'pos' : 'neg';
    return '<tr><td class="name">' + esc(p.name) + '<span class="slug">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td>' +
      '<td class="num money">' + money(p.tvl_usd) + '</td>' +
      '<td class="num money"><strong>' + money(p.mcap_usd) + '</strong></td>' +
      '<td class="num money">' + money(p.predicted_usd) + '</td>' +
      '<td class="num ' + cls + '">×' + ratio.toFixed(2) + '</td></tr>';
  }).join('');

  // Screened-out giants.
  el('excludedList').innerHTML = R.excluded.map(function (x) {
    return '<div class="excl-row"><span class="nm">' + esc(x.name) + '</span><span class="tv">' + money(x.tvl_usd) + ' TVL</span><span class="rs">' + esc(x.reason) + '</span></div>';
  }).join('');

  // Wiring.
  ['search', 'categoryFilter', 'chainFilter', 'watchlistOnly', 'farmFirstOnly'].forEach(function (id) {
    el(id).addEventListener('input', renderBoard);
    el(id).addEventListener('change', renderBoard);
  });
  var ths = document.querySelectorAll('#board th.sortable');
  for (var i = 0; i < ths.length; i++) {
    ths[i].addEventListener('click', function () {
      var key = this.getAttribute('data-key');
      if (sortKey === key) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'name' || key === 'category' || key === 'verdict' ? 1 : -1; }
      if (key === 'rank') sortDir = 1;
      renderBoard();
    });
  }
  el('viewBoard').addEventListener('click', function () {
    el('boardView').hidden = false; el('liveView').hidden = true;
    el('viewBoard').classList.add('on'); el('viewLive').classList.remove('on');
  });
  el('viewLive').addEventListener('click', function () {
    el('boardView').hidden = true; el('liveView').hidden = false;
    el('viewLive').classList.add('on'); el('viewBoard').classList.remove('on');
  });

  renderBoard();
})();
