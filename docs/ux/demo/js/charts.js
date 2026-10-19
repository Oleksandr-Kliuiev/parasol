/* Parasoll UX demo: small SVG charts. One scale per chart, thin marks with a 4 px rounded data end,
   recessive solid gridlines, selective direct labels, hover/focus tooltips and a table twin.
   The SVG is redrawn at the container's pixel width, so labels stay at their real 12 px size. */
(function () {
  'use strict';

  var P = window.P;
  var h = P.html;
  var t = P.t;
  var C = (P.charts = {});
  var specs = {};

  /* Path for a column with rounded top corners and a square base */
  function column(x, y, w, hgt, r) {
    if (hgt <= 0) return '';
    r = Math.min(r, hgt, w / 2);
    return 'M' + x + ',' + (y + hgt) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + hgt) + 'Z';
  }

  function daySvg(o, W) {
    var days = o.days;
    var H = 200, padL = 32, padR = 8, padT = 24, padB = 36;
    var max = Math.max(8, Math.ceil(Math.max.apply(null, days.map(function (d) { return d.hours; }).concat([o.target])) / 2) * 2);
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var band = plotW / days.length;
    var bw = Math.min(24, band * 0.5);
    var y = function (v) { return padT + plotH - (v / max) * plotH; };
    var ticks = [];
    for (var v = 0; v <= max; v += max > 8 ? 4 : 2) ticks.push(v);
    var id = P.uid('chart');
    var svg = '<svg class="chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="' + id + '-t">' +
      '<title id="' + id + '-t">' + P.escape(o.title) + '</title>';
    ticks.forEach(function (tv) {
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(tv) + '" y2="' + y(tv) + '" class="chart-grid"/>' +
        '<text x="' + (padL - 8) + '" y="' + (y(tv) + 4) + '" text-anchor="end" class="chart-tick">' + P.escape(P.fmt.num(tv)) + '</text>';
    });
    days.forEach(function (d, i) {
      var cx = padL + band * i + band / 2;
      var top = y(d.hours);
      var emph = o.emphasis === i;
      svg += '<g class="chart-mark' + (emph ? ' is-emph' : '') + '" tabindex="0" role="img" aria-label="' + P.escape(d.label + ': ' + P.fmt.hours(d.hours)) + '" data-tip="' + P.escape(d.label + ': ' + P.fmt.hours(d.hours)) + '">' +
        '<rect x="' + (cx - band / 2) + '" y="' + padT + '" width="' + band + '" height="' + plotH + '" class="chart-hit"/>' +
        '<path d="' + column(cx - bw / 2, top, bw, padT + plotH - top, 4) + '" class="chart-bar"/>' +
        '<text x="' + cx + '" y="' + (H - padB + 20) + '" text-anchor="middle" class="chart-tick' + (emph ? ' is-strong' : '') + '">' + P.escape(band < 64 ? d.tiny : d.short) + '</text>';
      if (emph) svg += '<text x="' + cx + '" y="' + (top - 8) + '" text-anchor="middle" class="chart-label">' + P.escape(P.fmt.num(d.hours)) + '</text>';
      svg += '</g>';
    });
    var ty = y(o.target);
    svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ty + '" y2="' + ty + '" class="chart-target"/>' +
      '<text x="' + (W - padR) + '" y="' + (ty - 6) + '" text-anchor="end" class="chart-tick is-strong">' + P.escape(t('chart.norm', { hours: P.fmt.num(o.target) })) + '</text>';
    return svg + '</svg>';
  }

  /* Hours per working day against the daily norm. `emphasis` marks the day the story is about. */
  C.dayBars = function (o) {
    specs[o.key] = o;
    var table = h`<table class="table is-fit mini-table"><thead><tr><th scope="col">${t('chart.day')}</th><th scope="col" class="t-num">${t('chart.hours')}</th></tr></thead>
      <tbody>${o.days.map(function (d) { return h`<tr><td>${d.label}</td><td class="t-num">${P.fmt.hours(d.hours)}</td></tr>`; })}</tbody></table>`;
    var asTable = !!(P.state.ui.chartTable && P.state.ui.chartTable[o.key]);
    return h`<div class="chart-wrap" data-chart="${asTable ? '' : o.key}">${asTable ? table : P.raw(daySvg(o, 320))}<div class="chart-tip" aria-hidden="true"></div></div>`;
  };

  C.fit = function () {
    P.$$('.chart-wrap[data-chart]').forEach(function (w) {
      var spec = specs[w.getAttribute('data-chart')];
      var svg = w.querySelector('svg');
      if (!spec || !svg) return;
      var width = Math.floor(w.clientWidth);
      if (!width || Number(svg.getAttribute('width')) === width) return;
      svg.outerHTML = daySvg(spec, width);
    });
  };
  window.addEventListener('resize', function () { clearTimeout(C.timer); C.timer = setTimeout(C.fit, 80); });

  P.on('chart-table', function (el) {
    var key = el.dataset.value;
    P.state.ui.chartTable = P.state.ui.chartTable || {};
    P.state.ui.chartTable[key] = !P.state.ui.chartTable[key];
    P.app.refresh();
  });

  /* Tooltips: pointer and keyboard show the same text */
  function showTip(mark) {
    var wrap = mark.closest('.chart-wrap');
    var tip = wrap && wrap.querySelector('.chart-tip');
    if (!tip) return;
    tip.textContent = mark.getAttribute('data-tip');
    var bar = mark.querySelector('.chart-bar') || mark;
    var r = bar.getBoundingClientRect();
    var wr = wrap.getBoundingClientRect();
    tip.style.left = Math.min(wr.width - 8, Math.max(8, r.left - wr.left + r.width / 2)) + 'px';
    tip.style.top = Math.max(0, r.top - wr.top - 36) + 'px';
    tip.classList.add('is-on');
  }
  function hideTip(mark) {
    var wrap = mark.closest('.chart-wrap');
    var tip = wrap && wrap.querySelector('.chart-tip');
    if (tip) tip.classList.remove('is-on');
  }
  document.addEventListener('pointerover', function (e) { var m = e.target.closest && e.target.closest('.chart-mark'); if (m) showTip(m); });
  document.addEventListener('pointerout', function (e) { var m = e.target.closest && e.target.closest('.chart-mark'); if (m) hideTip(m); });
  document.addEventListener('focusin', function (e) { var m = e.target.closest && e.target.closest('.chart-mark'); if (m) showTip(m); });
  document.addEventListener('focusout', function (e) { var m = e.target.closest && e.target.closest('.chart-mark'); if (m) hideTip(m); });
})();
