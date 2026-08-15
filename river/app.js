/* ============================================================================
   app.js — orchestration, state, rendering.
   ========================================================================== */
(function () {
  'use strict';

  var M = RiverModel, D = RiverData;
  var CAL_YEARS = 2;            /* calibration window                        */
  var PAST_DAYS = 60;           /* spin-up before the forecast origin        */
  var FC_DAYS   = 7;
  var ENS_DAYS  = 5;            /* ensemble horizon (the API caps around here) */
  var CACHE_DAYS = 45;          /* how long a calibration stays fresh        */

  var S = {
    tab: 'now',
    station: null,
    favs: load('rp.favs', []),
    band: load('rp.bands', {}),
    result: null,
    busy: false,
    status: '',
    error: null,
    search: [],
    runFilter: 'all',
    runQ: '',
    openRun: null,
    runsBusy: false,
    runsErr: null,
    lastGuid: load('rp.last', null)
  };

  function load(k, dflt) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; }
    catch (e) { return dflt; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* The two EA feeds and Open-Meteo disagree about whether a timestamp carries
     a zone: "2026-08-15T12:15:00Z" from flood-monitoring, "2026-08-15T12:00"
     from Open-Meteo. Blindly appending "Z" to the first produces NaN, which is
     the sort of thing that silently empties an array rather than throwing. */
  function parseTime(s) {
    if (!s) return NaN;
    return Date.parse(/[Zz]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  }

  var A = document.getElementById('app');
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ==========================================================================
     PIPELINE
     ========================================================================== */

  function setStatus(t) { S.status = t; render(); }

  async function openStation(st) {
    S.station = st; S.result = null; S.error = null; S.busy = true; S.tab = 'now';
    save('rp.last', st.guid);
    S.lastGuid = st.guid;
    render();
    try {
      var r = await buildForecast(st, setStatus);
      S.result = r;
      window.__last = r;               /* debug handle for the browser tests */
      /* Write this forecast down before showing it, so it can be scored against
         what the river actually does. Best effort — never block the view. */
      try { await RiverArchive.record(r); } catch (e2) {}
    } catch (e) {
      S.error = String(e && e.message || e);
    }
    S.busy = false; S.status = '';
    render();
  }

  async function buildForecast(st, status) {
    if (!st.area) throw new Error('This gauge has no published catchment area, so the model has no way to turn rainfall into flow. Pick a gauge with one — the search results mark them.');

    var to = D.iso(new Date(Date.now() - 6 * 86400000));      /* ERA5 lags a few days */
    var from = D.iso(new Date(Date.now() - CAL_YEARS * 365 * 86400000));

    /* ---- 1. calibration target: long daily record ------------------------ */
    status('Loading ' + (st.hasFlow ? 'flow' : 'level') + ' record…');
    var kind = st.hasFlow ? 'flow' : 'level';
    var daily = await D.dailySeries(st.guid, kind, from, to, kind === 'flow' ? 'm' : 'max');
    if (daily.length < 200) throw new Error('Only ' + daily.length + ' days of record here — not enough to calibrate against. Try a longer-established gauge.');

    /* ---- 2. rating curve, so we can talk in metres as well as cumecs ----- */
    var rating = null;
    if (kind === 'flow') {
      try {
        var lev = await D.dailySeries(st.guid, 'level', from, to, 'max');
        var flo = await D.dailySeries(st.guid, 'flow', from, to, 'max');
        var byDate = {}; flo.forEach(function (x) { byDate[x.date] = x.v; });
        var L = [], Q = [];
        lev.forEach(function (x) { var q = byDate[x.date]; if (q > 0 && x.v > 0) { L.push(x.v); Q.push(q); } });
        rating = M.fitRating(L, Q);
      } catch (e) { /* level record missing — cumecs only */ }
    }

    /* ---- 3. archived rainfall over the calibration window ---------------- */
    var nPts = D.pointCountFor(st.area);
    status('Loading ' + CAL_YEARS + ' years of rainfall (' + nPts + ' catchment point' + (nPts > 1 ? 's' : '') + ')…');
    var hist = await D.historicForcing(st.lat, st.lon, st.area, from, to, nPts);

    var w = buildWindows(hist.time, daily);
    if (w.windows.length < 200) throw new Error('Could not line up the flow record with the rainfall record.');

    /* ---- 4. calibrate (cached) ------------------------------------------- */
    var cached = load('rp.cal.' + st.guid, null);
    var par, fit, split, bt;
    if (cached && cached.at && (Date.now() - cached.at) < CACHE_DAYS * 86400000 && cached.v === 4) {
      par = cached.par; fit = cached.fit; split = cached.split; bt = cached.bt;
      status('Using stored calibration…');
    } else {
      var res = await runCalibration(hist, w, st.area, status);
      par = res.par; fit = res.fit; split = res.split; bt = res.bt;
      save('rp.cal.' + st.guid, { at: Date.now(), v: 4, par: par, fit: fit, split: split, bt: bt });
    }

    /* ---- 5. live forcing: recent past + deterministic forecast ----------- */
    status('Loading forecast rainfall…');
    var live = await D.liveForcing(st.lat, st.lon, st.area, PAST_DAYS, FC_DAYS, nPts);

    /* ---- 6. where the river is right now --------------------------------- */
    status('Reading the gauge…');
    var obsNow = null, obsSeries = [], obsUnit = kind === 'flow' ? 'm3/s' : 'm';
    if (st.eaRef) {
      try {
        var liveObs = await D.liveReadings(st.eaRef, kind, 14);
        obsSeries = liveObs.points;
        if (obsSeries.length) obsNow = obsSeries[obsSeries.length - 1];
        obsUnit = liveObs.unit || obsUnit;
      } catch (e) {
        /* some flow gauges publish only level live — fall back and convert */
        if (kind === 'flow' && rating) {
          try {
            var lv = await D.liveReadings(st.eaRef, 'level', 14);
            obsSeries = lv.points.map(function (p) {
              return { t: p.t, v: levelToFlow(p.v, rating) };
            }).filter(function (p) { return p.v > 0; });
            if (obsSeries.length) obsNow = obsSeries[obsSeries.length - 1];
          } catch (e2) {}
        }
      }
    }

    /* ---- 7. spin the model up to now, then assimilate -------------------- */
    var nowIdx = indexOfNow(live.time);
    var spinF = M.sliceForcing(live, 0, nowIdx + 1);

    /* Seed the groundwater store from the flow the river was actually carrying
       when the spin-up window opened, so the sixty days of forcing refine a
       plausible state rather than filling an empty one from scratch. */
    var q0 = flowOnDate(daily, live.time[0].slice(0, 10));
    if (!(q0 > 0)) q0 = firstObsFlow(obsSeries, live.time[0]);
    if (!(q0 > 0)) q0 = medianOf(daily.slice(-90).map(function (x) { return x.v; }));
    var state0 = M.warmStart(par, st.area, q0, 1);

    var spin = M.simulate(spinF, par, st.area, 1, null, state0);
    var qSimNow = spin.q[spin.q.length - 1];

    /* How hard to pull the model onto the live gauge reading is not a constant.
       The river's own backtest swept it and picked the value that forecast its
       own history best — on the Severn, no assimilation scores -8% against
       persistence and this weight scores +28%. */
    var daWeight = (bt && bt.weight != null) ? bt.weight : 1;
    var da = { state: spin.state, ratio: 1 };
    if (obsNow && obsNow.v > 0) da = M.assimilate(spin.state, qSimNow, obsNow.v, par, { weight: daWeight });

    /* ---- 8. ensemble forward --------------------------------------------- */
    status('Running the rainfall ensemble…');
    var members = [];
    try {
      var ens = await D.ensembleRain(st.lat, st.lon, st.area, ENS_DAYS, nPts);
      var eStart = indexOfNow(ens.time) + 1;
      members = ens.members.map(function (p) { return alignForcing(p, eStart, live, live.bias || 1); });
    } catch (e) { /* ensemble unavailable — deterministic only */ }

    var detF = M.sliceForcing(live, nowIdx + 1, live.p.length);
    if (!members.length) members = [detF];

    /* ---- 9. verification: how good is this, really? ---------------------- */
    status('Checking recent accuracy…');
    var verif = verifyRecent(live, obsSeries, par, st.area, nowIdx);

    /* Uncertainty by lead time. The rolling backtest spans two years and every
       flood in them; the live hindcast spans a fortnight of whatever the
       weather happened to be doing. Prefer the backtest, and fall back. */
    var sigma = btSigmaHourly(bt) || (verif ? verif.sigma : null);
    var fc = M.ensemble(members, par, st.area, 1, da.state, sigma);

    /* ---- 9b. score past forecasts, and let them widen or narrow this one -- */
    status('Scoring past forecasts…');
    var arch = null, spreadFactor = 1;
    try {
      await RiverArchive.verifyAll(st.guid, obsSeries);
      arch = await RiverArchive.stats(st.guid);
      /* Once enough real forecasts have matured, the measured coverage of the
         stated 80% band overrides the modelled spread. An ensemble that turns
         out to have been too confident gets widened by exactly the factor the
         record says it was short by — the one place where writing forecasts
         down actually changes what the app tells you next. */
      if (arch && arch.n >= 12 && arch.spreadFactor && Math.abs(arch.spreadFactor - 1) > 0.05) {
        spreadFactor = arch.spreadFactor;
        rescaleSpread(fc, spreadFactor);
      }
    } catch (e) { /* archive unavailable (private browsing, quota) — carry on */ }

    /* ---- 10. bands from this river's own flow duration curve ------------- */
    var stats = M.flowStats(daily.map(function (x) { return x.v; }));
    var band = S.band[st.guid] || defaultBand(stats);

    var times = [];
    for (var i = nowIdx + 1; i < live.time.length; i++) times.push(live.time[i]);

    var prob = M.probInBand(fc, band.lo, band.hi);

    return {
      station: st, kind: kind, unit: obsUnit, par: par, fit: fit, rating: rating,
      stats: stats, band: band, daily: daily,
      obsSeries: obsSeries, obsNow: obsNow, qSimNow: qSimNow, daRatio: da.ratio,
      times: times, fc: fc, prob: prob, verif: verif,
      nMembers: members.length, nPts: hist.nPts,
      pastTime: live.time.slice(0, nowIdx + 1), pastQ: spin.q,
      rainPast: live.p.slice(0, nowIdx + 1), rainFc: live.p.slice(nowIdx + 1),
      arch: arch, spreadFactor: spreadFactor, split: split, bt: bt, daWeight: daWeight,
      builtAt: Date.now()
    };
  }

  /* Widen (or tighten) the quantiles about the median in log space. */
  function rescaleSpread(fc, k) {
    for (var i = 0; i < fc.p50.length; i++) {
      var m = fc.p50[i];
      if (!(m > 0)) continue;
      ['p10', 'p25', 'p75', 'p90'].forEach(function (q) {
        var v = fc[q][i];
        if (v > 0) fc[q][i] = m * Math.pow(v / m, k);
      });
    }
  }

  function runCalibration(forcing, w, area, status) {
    var labels = {
      calibrate: 'Fitting the model to this river',
      split:     'Checking it hasn’t just memorised the record',
      backtest:  'Back-testing it against two years of this river'
    };
    return new Promise(function (resolve, reject) {
      var wk;
      try { wk = new Worker('worker.js'); }
      catch (e) {
        /* no worker (rare) — run inline and accept the pause */
        status('Fitting the model to this river…');
        var cal = M.calibrate(forcing, w.obs, w.windows, area, 1,
          { pop: 32, gen: 60, warmup: Math.min(180, Math.floor(w.windows.length * 0.25)), seed: 7 });
        var bt = null;
        try {
          bt = M.backtestDaily(forcing, w.windows, w.obs, cal.par, area, 1,
            { leadDays: 5, warmup: 180, months: w.months });
        } catch (e3) {}
        return resolve({ par: cal.par, fit: { kge: cal.kge, nse: NaN }, split: null,
                         bt: bt ? { weight: bt.best.weight, nOrigins: bt.nOrigins, bounds: bt.bounds,
                                    mae: Array.from(bt.best.mae), per: Array.from(bt.best.per),
                                    climo: Array.from(bt.best.climo), skill: Array.from(bt.best.skill),
                                    sigma: Array.from(bt.best.sigma),
                                    regime: bt.best.regime, sweep: [] } : null });
      }
      wk.onmessage = function (ev) {
        var m = ev.data;
        if (m.type === 'progress') {
          var lab = labels[m.phase] || 'Working';
          status(lab + (m.phase === 'calibrate' ? ' — ' + Math.round(m.pct * 100) + '%' : '…'));
        } else if (m.type === 'done') {
          wk.terminate();
          resolve({ par: m.par, fit: m.fit, split: m.split, bt: m.bt });
        } else if (m.type === 'error') { wk.terminate(); reject(new Error(m.message)); }
      };
      wk.onerror = function (e) { wk.terminate(); reject(new Error('Calibration failed: ' + e.message)); };
      status('Fitting the model to this river…');
      wk.postMessage({ cmd: 'calibrate', p: forcing.p, t: forcing.t, e: forcing.e,
                       obs: w.obs, windows: w.windows, months: w.months, area: area });
    });
  }

  /* The backtest measures error at daily leads; the fan needs it hourly. Hold
     each day's value across its 24 hours rather than inventing a smooth curve
     the data does not support. */
  function btSigmaHourly(bt) {
    if (!bt || !bt.sigma || !bt.sigma.length) return null;
    var out = new Float64Array(bt.sigma.length * 24);
    for (var i = 0; i < out.length; i++) out[i] = bt.sigma[Math.floor(i / 24)];
    return out;
  }

  /* Which part of its own range the river is sitting in right now — the
     backtest scores each of these separately, and they differ enormously. */
  function regimeOf(q, bt) {
    if (!bt || !bt.bounds) return null;
    if (q < bt.bounds.low) return 'low';
    if (q > bt.bounds.high) return 'high';
    return 'mid';
  }

  /* Daily-mean flow is reported against a 09:00 day boundary; match it. */
  function buildWindows(time, daily) {
    var idx = {}, i;
    for (i = 0; i < time.length; i++) idx[time[i]] = i;
    var windows = [], obs = [], months = [];
    for (i = 0; i < daily.length; i++) {
      var a = idx[daily[i].date + 'T09:00'];
      if (a == null || a + 24 > time.length) continue;
      windows.push([a, a + 24]);
      obs.push(daily[i].v);
      months.push(+daily[i].date.slice(5, 7));
    }
    return { windows: windows, obs: obs, months: months };
  }

  function indexOfNow(times) {
    var now = Date.now(), best = 0;
    for (var i = 0; i < times.length; i++) {
      if (parseTime(times[i]) <= now) best = i; else break;
    }
    return best;
  }

  /* Splice an ensemble member's rainfall onto the deterministic temperature
     and ET series, and pad to the deterministic forecast length so every
     member covers the same horizon. */
  function alignForcing(p, eStart, live, bias) {
    var detStart = indexOfNow(live.time) + 1;
    var n = live.p.length - detStart;
    var out = { p: new Float64Array(n), t: new Float64Array(n), e: new Float64Array(n) };
    for (var i = 0; i < n; i++) {
      var j = eStart + i;
      /* the ensemble comes from the same forecast product as the deterministic
         run, so it carries the same dry bias against the reanalysis the model
         was calibrated on — correct it identically */
      out.p[i] = j < p.length ? (p[j] || 0) * (bias || 1) : live.p[detStart + i];
      out.t[i] = live.t[detStart + i];
      out.e[i] = live.e[detStart + i];
    }
    return out;
  }

  /* Flow on the day the spin-up window opens. The long daily record is the
     right source here: the live feed only reaches back a fortnight, so on a
     60-day window it would seed the groundwater store with a reading from six
     weeks too late — which through a summer recession means seeding it low and
     then draining it for another two months. That single wrong lookup was
     enough to have the model start the forecast at a quarter of the river's
     real flow. */
  function flowOnDate(daily, date) {
    for (var i = 0; i < daily.length; i++) if (daily[i].date === date) return daily[i].v;
    for (i = 0; i < daily.length; i++) if (daily[i].date >= date) return daily[i].v;
    return NaN;
  }

  function firstObsFlow(obsSeries, t0iso) {
    if (!obsSeries || !obsSeries.length) return NaN;
    var t0 = parseTime(t0iso), best = null, bestDt = Infinity;
    for (var i = 0; i < obsSeries.length; i++) {
      var dt = Math.abs(parseTime(obsSeries[i].t) - t0);
      if (dt < bestDt && obsSeries[i].v > 0) { bestDt = dt; best = obsSeries[i].v; }
    }
    return best;
  }
  function medianOf(a) {
    var v = a.filter(function (x) { return x > 0; }).sort(function (x, y) { return x - y; });
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  }

  function levelToFlow(level, rating) {
    if (!rating || !(level > 0)) return NaN;
    return Math.pow(level / rating.c, 1 / rating.m);
  }

  /* --------------------------------------------------------------------------
     RECENT VERIFICATION

     Rolling-origin hindcast over the live 14-day window, at the real 15-minute
     observation resolution, so the persistence baseline is honest. Rainfall is
     the analysis rather than a forecast, so this measures the hydrology alone —
     the rainfall part of the uncertainty is what the ensemble spread shows.
     ------------------------------------------------------------------------ */
  function verifyRecent(live, obsSeries, par, area, nowIdx) {
    if (!obsSeries || obsSeries.length < 200) return null;
    var obsH = new Float64Array(nowIdx + 1); obsH.fill(NaN);
    var t0 = parseTime(live.time[0]);
    for (var i = 0; i < obsSeries.length; i++) {
      var h = Math.round((parseTime(obsSeries[i].t) - t0) / 3600000);
      if (h >= 0 && h <= nowIdx && obsSeries[i].v > 0) obsH[h] = obsSeries[i].v;
    }
    var have = 0;
    for (i = 0; i < obsH.length; i++) if (obsH[i] > 0) have++;
    if (have < 150) return null;

    var f = M.sliceForcing(live, 0, nowIdx + 1);
    return M.hindcast(f, obsH, par, area, 1,
      { leadSteps: 72, every: 6, spin: Math.max(24, nowIdx - 14 * 24) });
  }

  function defaultBand(stats) {
    if (!stats) return { lo: 0, hi: 1 };
    return { lo: round2(stats.q40), hi: round2(stats.q5) };
  }
  function round2(v) {
    if (!(v > 0)) return 0;
    var mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    return Math.round(v / mag) * mag;
  }

  /* ==========================================================================
     RENDER
     ========================================================================== */

  function render() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === S.tab);
    });
    if (S.tab === 'pick') return renderPick();
    if (S.tab === 'runs') return renderRuns();
    if (S.tab === 'model') return renderModel();
    return renderNow();
  }

  function renderNow() {
    var h = '';
    if (!S.station) {
      h += '<div class="card"><div class="lab">No river chosen</div>'
        + '<p class="muted">Pick a gauge and the app fits a rainfall-runoff model to that river’s own two-year record, then forecasts it forward against a 40-member rainfall ensemble.</p>'
        + '<button class="btn go" data-act="gopick">Choose a river</button></div>';
      h += introCard();
      A.innerHTML = h; return;
    }

    var st = S.station;
    h += '<div class="card head-card">'
      + '<div class="riv">' + esc(st.river || 'River') + '</div>'
      + '<div class="stn">' + esc(st.label) + '</div>'
      + '<div class="meta">' + (st.area ? st.area.toLocaleString() + ' km² catchment' : 'no catchment area') + (st.nrfa ? ' · NRFA ' + esc(st.nrfa) : '') + '</div>'
      + '<div class="acts"><button class="btn" data-act="gopick">Change river</button>'
      + '<button class="btn' + (isFav(st.guid) ? ' on' : '') + '" data-act="fav">' + (isFav(st.guid) ? '★ Saved' : '☆ Save') + '</button>'
      + '<button class="btn" data-act="refresh">Refresh</button></div></div>';

    if (S.busy) { h += '<div class="card"><div class="spin"></div><div class="muted">' + esc(S.status || 'Working…') + '</div></div>'; A.innerHTML = h; return; }
    if (S.error) { h += '<div class="card err"><b>Couldn’t build a forecast</b><p class="muted">' + esc(S.error) + '</p></div>'; A.innerHTML = h; return; }
    if (!S.result) { A.innerHTML = h; return; }

    var r = S.result;
    h += verdictCard(r);
    h += chartCard(r);
    h += windowCard(r);
    h += bandCard(r);
    h += backtestCard(r);
    h += recordCard(r);
    h += trustCard(r);
    h += footerCard(r);
    A.innerHTML = h;
    drawChart(r);
  }

  function fmtQ(v, r) {
    if (!(v >= 0)) return '—';
    if (r.kind !== 'flow') return v.toFixed(2) + ' m';
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' m³/s';
  }
  function fmtLevel(v, r) {
    if (!r.rating || !(v > 0)) return null;
    return M.flowToLevel(v, r.rating).toFixed(2) + ' m';
  }

  function verdictCard(r) {
    var now = r.obsNow ? r.obsNow.v : r.qSimNow;
    var d = M.describeFlow(now, r.stats);
    var lvl = fmtLevel(now, r);
    var pk = peakOf(r);
    var h = '<div class="card verdict ' + d.tone + '">'
      + '<div class="vrow"><div><div class="lab">Right now</div>'
      + '<div class="big">' + fmtQ(now, r) + '</div>'
      + (lvl ? '<div class="sub">≈ ' + lvl + ' on the gauge board</div>' : '')
      + '</div><div class="badge ' + d.tone + '">' + esc(d.label) + '</div></div>'
      + '<p class="muted">' + esc(d.note || '') + (r.obsNow ? ' Reading from ' + esc(shortTime(r.obsNow.t)) + '.' : ' No live reading — this is the model’s own estimate.') + '</p>';

    if (pk) {
      h += '<div class="peak"><b>' + (pk.rising ? 'Rising' : 'Falling') + '.</b> '
        + (pk.rising
            ? 'Peak around <b>' + fmtQ(pk.q, r) + '</b> ' + esc(pk.when) + ' (' + fmtQ(pk.lo, r) + '–' + fmtQ(pk.hi, r) + ' across the ensemble).'
            : 'Dropping away — down to about <b>' + fmtQ(pk.q, r) + '</b> by ' + esc(pk.when) + '.')
        + '</div>';
    }
    h += '<div class="why">' + esc(explain(r)) + '</div>';
    return h + '</div>';
  }

  /* Plain-English account of what is driving the forecast. A number with no
     reasoning attached is hard to trust and impossible to argue with. */
  function explain(r) {
    var bits = [];
    var rain24 = sum(r.rainFc, 0, 24), rain72 = sum(r.rainFc, 0, 72);
    var past48 = sum(r.rainPast, r.rainPast.length - 48, r.rainPast.length);
    bits.push(past48.toFixed(0) + ' mm fell on the catchment in the last 48 hours');
    bits.push(rain24 >= 0.5
      ? rain24.toFixed(0) + ' mm forecast in the next 24 h (' + rain72.toFixed(0) + ' mm over three days)'
      : 'little or no rain forecast for the next 24 h');
    if (r.daRatio && Math.abs(Math.log(r.daRatio)) > 0.18) {
      bits.push('the gauge is reading ' + (r.daRatio > 1 ? 'higher' : 'lower') + ' than the model expected, so the forecast has been pulled '
        + (r.daRatio > 1 ? 'up' : 'down') + ' by ' + Math.round(Math.abs(r.daRatio - 1) * 100) + '%');
    }
    bits.push('recession here runs at about ' + Math.round(r.par.ks / 24) + ' days');
    return bits.join('; ') + '.';
  }

  function sum(arr, a, b) {
    var s = 0;
    for (var i = Math.max(0, a); i < Math.min(arr.length, b); i++) s += arr[i] || 0;
    return s;
  }

  function peakOf(r) {
    var q = r.fc.p50, n = Math.min(q.length, 120), bi = 0;
    for (var i = 0; i < n; i++) if (q[i] > q[bi]) bi = i;
    var now = r.obsNow ? r.obsNow.v : r.qSimNow;
    var rising = q[bi] > now * 1.12 && bi > 1;
    var j = rising ? bi : Math.min(n - 1, 47);
    return { rising: rising, q: q[j], lo: r.fc.p10[j], hi: r.fc.p90[j], when: whenLabel(r.times[j]) };
  }

  function whenLabel(iso) {
    if (!iso) return '';
    var d = new Date(parseTime(iso));
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var today = new Date();
    var same = d.toDateString() === today.toDateString();
    var hh = String(d.getHours()).padStart(2, '0');
    return (same ? 'today ' : days[d.getDay()] + ' ') + hh + ':00';
  }
  function shortTime(iso) {
    var d = new Date(parseTime(iso));
    var mins = Math.round((Date.now() - d) / 60000);
    if (mins < 90) return mins + ' min ago';
    return whenLabel(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  }

  function chartCard(r) {
    return '<div class="card"><div class="lab">Next ' + Math.round(r.times.length / 24) + ' days</div>'
      + '<canvas id="chart" height="240"></canvas>'
      + '<div class="legend"><span class="k obs"></span>observed'
      + '<span class="k med"></span>forecast'
      + '<span class="k fan"></span>80% range'
      + '<span class="k bandk"></span>your band</div></div>';
  }

  function windowCard(r) {
    var best = bestWindow(r);
    var h = '<div class="card"><div class="lab">When to go</div>';
    if (!best) {
      h += '<p class="muted">Nothing in the next ' + Math.round(r.times.length / 24) + ' days comes into your band. Widen the band below, or wait for rain.</p>';
    } else {
      h += '<div class="win"><div class="wt">' + esc(best.label) + '</div>'
        + '<div class="wp">' + Math.round(best.prob * 100) + '%</div></div>'
        + '<p class="muted">Chance of being inside ' + fmtQ(r.band.lo, r) + '–' + fmtQ(r.band.hi, r) + ' during that window. '
        + 'Beyond about three days the rainfall ensemble spreads out fast — treat day four and five as a hint, not a plan.</p>';
    }
    /* daily probability strip */
    h += '<div class="strip">';
    for (var d = 0; d < Math.min(6, Math.floor(r.times.length / 24)); d++) {
      var p = avg(r.prob, d * 24 + 6, d * 24 + 20);   /* daylight hours */
      h += '<div class="sday"><div class="sn">' + esc(dayName(r.times[d * 24 + 12])) + '</div>'
        + '<div class="sbar"><i style="height:' + Math.round(p * 100) + '%"></i></div>'
        + '<div class="sv">' + Math.round(p * 100) + '%</div></div>';
    }
    return h + '</div></div>';
  }

  function bestWindow(r) {
    var best = null;
    for (var i = 0; i + 6 < r.prob.length; i++) {
      var d = new Date(parseTime(r.times[i]));
      var hr = d.getHours();
      if (hr < 8 || hr > 17) continue;                /* daylight starts only */
      var p = avg(r.prob, i, i + 6);
      if (!best || p > best.prob) best = { prob: p, label: whenLabel(r.times[i]) + '–' + String((hr + 6) % 24).padStart(2, '0') + ':00' };
    }
    return best && best.prob > 0.12 ? best : null;
  }

  function avg(a, i0, i1) {
    var s = 0, n = 0;
    for (var i = Math.max(0, i0); i < Math.min(a.length, i1); i++) { s += a[i]; n++; }
    return n ? s / n : 0;
  }
  function dayName(iso) {
    if (!iso) return '';
    var d = new Date(parseTime(iso));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  }

  function bandCard(r) {
    var s = r.stats;
    var h = '<div class="card"><div class="lab">Your runnable band</div>'
      + '<p class="muted">Set from this river’s own flow record rather than a guidebook — so it works on rivers nobody has written one for. Percentiles are the share of days the river runs at or above that flow.</p>'
      + '<div class="bandrow"><label>Bottom</label><input type="range" id="blo" min="0" max="100" value="' + pctOf(r.band.lo, s) + '"><span id="blov">' + fmtQ(r.band.lo, r) + '</span></div>'
      + '<div class="bandrow"><label>Top</label><input type="range" id="bhi" min="0" max="100" value="' + pctOf(r.band.hi, s) + '"><span id="bhiv">' + fmtQ(r.band.hi, r) + '</span></div>';
    h += '<div class="fdc">';
    [['Q95', s.q95, 'dry summer'], ['Q50', s.q50, 'typical day'], ['Q20', s.q20, 'wet'], ['Q5', s.q5, 'high'], ['max', s.max, 'record']]
      .forEach(function (x) {
        h += '<div class="fcell"><div class="fk">' + x[0] + '</div><div class="fv">' + fmtQ(x[1], r) + '</div><div class="fn">' + x[2] + '</div></div>';
      });
    return h + '</div></div>';
  }

  /* Sliders move in percentile space, which is uniform across rivers — a
     linear slider in cumecs would spend 90% of its travel in flood range. */
  function pctOf(q, s) {
    var pts = [[95, s.q95], [80, s.q80], [60, s.q60], [50, s.q50], [40, s.q40], [30, s.q30], [20, s.q20], [10, s.q10], [5, s.q5], [1, s.q1]];
    for (var i = 0; i < pts.length; i++) if (q <= pts[i][1]) return 100 - pts[i][0];
    return 100;
  }
  function qOfPct(v, s) {
    var ex = 100 - v;
    var pts = [[95, s.q95], [80, s.q80], [60, s.q60], [50, s.q50], [40, s.q40], [30, s.q30], [20, s.q20], [10, s.q10], [5, s.q5], [1, s.q1], [0.2, s.max]];
    for (var i = 0; i < pts.length - 1; i++) {
      if (ex <= pts[i][0] && ex >= pts[i + 1][0]) {
        var f = (pts[i][0] - ex) / (pts[i][0] - pts[i + 1][0]);
        return pts[i][1] + f * (pts[i + 1][1] - pts[i][1]);
      }
    }
    return ex > 95 ? s.q95 : s.max;
  }

  /* --------------------------------------------------------------------------
     TRACK RECORD

     The hindcast card below measures the model. This one measures the app: the
     forecasts it actually showed, scored against what the river then did. It is
     the only number here that has paid for the rainfall forecast being wrong,
     so it is the honest one — and it is always the worse of the two.
     ------------------------------------------------------------------------ */
  function recordCard(r) {
    var a = r.arch;
    var h = '<div class="card"><div class="lab">Its actual track record here</div>';
    if (!a || !a.n) {
      h += '<p class="muted">Every forecast this app shows you is written down and scored later against what the river actually did — including the days the rain forecast was wrong, which the hindcast below quietly gets for free.</p>'
        + '<p class="muted">' + (a && a.pending
            ? a.pending + ' forecast' + (a.pending === 1 ? '' : 's') + ' recorded here, none matured yet. Scores appear once the first one has run its full five days.'
            : 'Nothing scored yet — this is the first forecast recorded for this gauge. Open it again over the coming week and the record builds itself.') + '</p>';
      return h + '</div>';
    }
    var days = Math.max(1, Math.round((Date.now() - a.oldest) / 86400000));
    var rows = [6, 24, 48, 72].filter(function (L) { return L <= a.mae.length && a.counts[L - 1] > 0; });
    h += '<table class="verif"><tr><th>Lead</th><th>Forecast</th><th>“No change”</th><th>Beats it by</th><th>In band</th></tr>';
    rows.forEach(function (L) {
      var sk = a.skill[L - 1];
      var cell = sk < -1 ? 'much worse' : (sk >= 0 ? '+' : '') + Math.round(sk * 100) + '%';
      h += '<tr><td>' + L + ' h</td><td>' + a.mae[L - 1].toFixed(2) + '</td><td>' + a.per[L - 1].toFixed(2) + '</td>'
        + '<td class="' + (sk > 0.05 ? 'good' : sk < -0.05 ? 'bad' : '') + '">' + cell + '</td>'
        + '<td>' + Math.round(a.cov[L - 1] * 100) + '%</td></tr>';
    });
    h += '</table>';
    h += '<p class="muted">' + a.n + ' matured forecast' + (a.n === 1 ? '' : 's') + ' over ' + days + ' day' + (days === 1 ? '' : 's')
      + (a.pending ? ', ' + a.pending + ' still running' : '') + '. Error in ' + (r.kind === 'flow' ? 'm³/s' : 'm') + '. '
      + '“In band” is how often the outcome landed inside the shaded 80% range — it should read about 80%.</p>';

    if (a.coverage != null) {
      var pct = Math.round(a.coverage * 100);
      var adj = r.spreadFactor && Math.abs(r.spreadFactor - 1) > 0.05;
      h += '<p class="verdict-line ' + (Math.abs(pct - 80) <= 8 ? 'good' : 'ok') + '">'
        + (Math.abs(pct - 80) <= 8
            ? 'The 80% band has been right about ' + pct + '% of the time. Honest width.'
            : pct < 80
              ? 'The 80% band only caught ' + pct + '% of outcomes — this app has been overconfident here'
                + (adj ? ', so the range above has been widened by ' + r.spreadFactor.toFixed(2) + '× to match.' : '.')
              : 'The 80% band caught ' + pct + '% of outcomes — wider than it needed to be'
                + (adj ? ', so the range above has been tightened by ' + r.spreadFactor.toFixed(2) + '×.' : '.'))
        + '</p>';
    }
    h += '<div class="acts"><button class="btn" data-act="export">Export the record</button></div>';
    return h + '</div>';
  }

  /* --------------------------------------------------------------------------
     BACKTEST CARD

     Every gauge is scored against its own two-year record, and the answer is
     given for the regime the river is in *today*. An average across all
     conditions is close to useless on the day: the same model can be worth 60%
     over persistence in a flood and worse than useless on a flat summer
     recession, and knowing which of those you are looking at right now is the
     whole point.
     ------------------------------------------------------------------------ */
  function backtestCard(r) {
    var bt = r.bt, sp = r.split;
    var h = '<div class="card"><div class="lab">Back-tested on this river</div>';
    if (!bt) {
      h += '<p class="muted">Not enough record at this gauge to back-test against.</p>';
      return h + '</div>';
    }

    var now = r.obsNow ? r.obsNow.v : r.qSimNow;
    var reg = regimeOf(now, bt);
    var names = { low: 'low water', mid: 'middling water', high: 'high water' };
    var rg = reg && bt.regime && bt.regime[reg];

    if (rg && rg.n > 20) {
      var s1 = rg.skill[0], s3 = rg.skill[Math.min(2, rg.skill.length - 1)];
      var tone = s1 > 0.2 ? 'good' : s1 > 0 ? 'ok' : 'bad';
      h += '<p class="verdict-line ' + tone + '">Right now this river is in <b>' + names[reg] + '</b>. '
        + 'Across ' + rg.n + ' days like today in the last two years, this model beat “no change” by '
        + Math.round(s1 * 100) + '% at one day and ' + Math.round(s3 * 100) + '% at three'
        + (s1 <= 0 ? ' — that is, it did not. In this regime, believe the gauge over the forecast.' : '.')
        + '</p>';
    }

    h += '<table class="verif"><tr><th>Lead</th><th>Model</th><th>“No change”</th><th>Seasonal normal</th><th>Skill</th></tr>';
    bt.mae.forEach(function (m, i) {
      var sk = bt.skill[i];
      h += '<tr><td>+' + (i + 1) + ' d</td><td>' + fmtSmall(m) + '</td><td>' + fmtSmall(bt.per[i]) + '</td>'
        + '<td>' + fmtSmall(bt.climo[i]) + '</td>'
        + '<td class="' + (sk > 0.05 ? 'good' : sk < -0.05 ? 'bad' : '') + '">' + (sk >= 0 ? '+' : '') + Math.round(sk * 100) + '%</td></tr>';
    });
    h += '</table>';
    h += '<p class="muted">' + bt.nOrigins + ' rolling forecasts, one from every day of the record. '
      + 'Mean absolute error in ' + (r.kind === 'flow' ? 'm³/s' : 'm') + '.</p>';

    /* skill split by regime */
    h += '<div class="regimes">';
    ['low', 'mid', 'high'].forEach(function (k) {
      var g = bt.regime && bt.regime[k];
      if (!g || !g.n) return;
      var v1 = g.skill[0];
      h += '<div class="rg' + (k === reg ? ' on' : '') + '"><div class="rgk">' + names[k] + '</div>'
        + '<div class="rgv ' + (v1 > 0.05 ? 'good' : v1 < -0.05 ? 'bad' : '') + '">' + (v1 >= 0 ? '+' : '') + Math.round(v1 * 100) + '%</div>'
        + '<div class="rgn">' + g.n + ' days</div></div>';
    });
    h += '</div><p class="muted">Skill against “no change” at one day, by how much water the river was carrying. '
      + 'Low-water days are where most models quietly fall apart, because a flat recession is very hard to beat.</p>';

    /* split-sample honesty */
    if (sp && isFinite(sp.kgeVal)) {
      var drop = sp.kgeCal - sp.kgeVal;
      h += '<div class="lab" style="margin-top:18px">Has it just memorised the record?</div>'
        + '<p class="muted">Fitted on the first ' + sp.nCal + ' days and scored on ' + sp.nVal + ' later days it never saw: '
        + 'KGE ' + sp.kgeCal.toFixed(2) + ' on the data it learned from, <b>' + sp.kgeVal.toFixed(2) + '</b> on data it did not.'
        + (drop > 0.15
            ? ' That is a real drop — the fit here flatters itself, so lean on the back-test numbers above rather than the calibration score.'
            : ' Close enough to say it has learned the river rather than the record.')
        + '</p>';
    }

    /* what the backtest changed */
    if (bt.sweep && bt.sweep.length > 1) {
      var off = bt.sweep.filter(function (x) { return x.weight === 0; })[0];
      h += '<div class="lab" style="margin-top:18px">What it tuned</div>'
        + '<p class="muted">The back-test swept how hard to pull the model onto the live gauge reading and chose <b>'
        + Math.round(bt.weight * 100) + '%</b> for this river'
        + (off ? ', against ' + Math.round(off.skill3 * 100) + '% skill with no anchoring at all' : '')
        + '. It also sets the width of the shaded fan on the chart, from two years of its own errors rather than the last fortnight.</p>';
    }
    return h + '</div>';
  }

  function fmtSmall(v) {
    if (!isFinite(v)) return '—';
    return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  function trustCard(r) {
    var v = r.verif;
    var h = '<div class="card"><div class="lab">The model, with rainfall known</div>';
    if (!v || !v.nOrigins) {
      h += '<p class="muted">Not enough recent 15-minute readings at this gauge to score the model honestly. The fit to the two-year record scored KGE '
        + (r.fit && isFinite(r.fit.kge) ? r.fit.kge.toFixed(2) : '—') + '.</p>';
      return h + '</div>';
    }
    var rows = [6, 12, 24, 48, 72].filter(function (L) { return L <= v.maeModel.length; });
    h += '<table class="verif"><tr><th>Lead</th><th>This model</th><th>“No change”</th><th>Beats it by</th></tr>';
    rows.forEach(function (L) {
      var m = v.maeModel[L - 1], p = v.maePers[L - 1], sk = v.skill[L - 1];
      /* On a flat recession "no change" is almost exact, so the ratio explodes.
         A five-figure negative percentage is noise, not information. */
      var cell = sk < -1 ? 'much worse' : (sk >= 0 ? '+' : '') + Math.round(sk * 100) + '%';
      h += '<tr><td>' + L + ' h</td><td>' + m.toFixed(2) + '</td><td>' + p.toFixed(2) + '</td>'
        + '<td class="' + (sk > 0.05 ? 'good' : sk < -0.05 ? 'bad' : '') + '">' + cell + '</td></tr>';
    });
    h += '</table>';
    var mid = v.skill[Math.min(23, v.skill.length - 1)];
    h += '<p class="verdict-line ' + (mid > 0.15 ? 'good' : mid > -0.05 ? 'ok' : 'bad') + '">'
      + (mid > 0.15 ? 'Worth trusting a day out on this gauge right now.'
        : mid > -0.05 ? 'About level with simply assuming no change, a day out.'
        : 'Right now this gauge is on a flat recession, where “no change” is very hard to beat. Trust the direction, not the number.')
      + '</p>';
    h += '<p class="muted">Mean absolute error in ' + (r.kind === 'flow' ? 'm³/s' : 'm') + ' over ' + v.nOrigins + ' rolling forecasts from the last two weeks, '
      + 'against the baseline of assuming the river simply stays where it is. Rainfall is taken as known in this test, so it measures the hydrology only — '
      + 'the rain-forecast uncertainty is what the shaded fan on the chart shows. A negative number means that at that lead time you would do better ignoring the model.</p>';
    h += '<p class="muted">Calibration fit over two years: KGE ' + (r.fit && isFinite(r.fit.kge) ? r.fit.kge.toFixed(2) : '—')
      + (r.fit && isFinite(r.fit.nse) ? ', NSE ' + r.fit.nse.toFixed(2) : '') + '.</p>';
    return h + '</div>';
  }

  function footerCard(r) {
    return '<div class="card small">'
      + '<p class="muted">Model fitted on ' + r.daily.length + ' days of Environment Agency record, forced with ' + r.nPts + ' rainfall grid point'
      + (r.nPts > 1 ? 's' : '') + ' across the catchment, ' + r.nMembers + ' ensemble member' + (r.nMembers > 1 ? 's' : '') + ' forward.</p>'
      + '<p class="muted">River data © Environment Agency, Open Government Licence v3. Weather from Open-Meteo (CC-BY-4.0), ERA5 and ICON.</p>'
      + '<p class="muted warn">A forecast is not a safety check. Water levels can change faster than any model tracks, and a runnable number tells you nothing about strainers, debris or what the last flood moved. Look at the river before you commit to it.</p>'
      + '</div>';
  }

  function introCard() {
    return '<div class="card"><div class="lab">What this does differently</div>'
      + '<ul class="pts">'
      + '<li><b>Fits the model to your river.</b> Seven physical parameters — soil capacity, how flashy the response is, how fast it recedes — calibrated on two years of that gauge’s own record, in the browser, once.</li>'
      + '<li><b>Tracks how wet the ground already is.</b> 30 mm of rain on baked August ground and on saturated January ground do completely different things. A model driven by rainfall alone cannot tell those apart.</li>'
      + '<li><b>Anchors on the live gauge.</b> The model’s stores are rescaled so it starts from what the river is actually doing right now, not from where it thought it would be.</li>'
      + '<li><b>Gives you odds, not a line.</b> 40 rainfall ensemble members go through the model separately, so you get the chance of being in your band — the thing you are really asking.</li>'
      + '<li><b>Shows its own error.</b> Scored against the “river stays where it is” baseline at every lead time, on that gauge, in the last fortnight.</li>'
      + '</ul></div>';
  }

  /* ---- picker ------------------------------------------------------------ */
  function renderPick() {
    var h = '<div class="card"><div class="lab">Find a gauge</div>'
      + '<input class="inp" id="q" placeholder="River or place — “Dart”, “Sedgwick”, “Tees”" value="' + esc(S.q || '') + '">'
      + '<div class="acts"><button class="btn go" data-act="search">Search</button>'
      + '<button class="btn" data-act="near">Near me</button></div>'
      + '<p class="muted">England only for now — the Environment Agency publishes the open flow record and catchment areas the model needs. Wales and Scotland have equivalent feeds but different APIs.</p></div>';

    if (S.favs.length) {
      h += '<div class="lab2">Saved</div>';
      S.favs.forEach(function (f) { h += stationRow(f); });
    }
    if (S.searching) h += '<div class="card"><div class="spin"></div><div class="muted">Searching…</div></div>';
    if (S.search.length) {
      h += '<div class="lab2">Results</div>';
      S.search.forEach(function (f) { h += stationRow(f); });
    } else if (S.searched && !S.searching) {
      h += '<div class="card"><p class="muted">Nothing found. Try the gauge name rather than the river — “Austins Bridge” rather than “Dart”.</p></div>';
    }
    A.innerHTML = h;
  }

  function stationRow(s) {
    var ok = !!s.area && s.hasFlow;
    return '<div class="srow" data-guid="' + esc(s.guid) + '">'
      + '<div class="sinfo"><div class="sn2">' + esc(s.label) + '</div>'
      + '<div class="sm">' + esc(s.river || '—') + (s.area ? ' · ' + s.area.toLocaleString() + ' km²' : '') + '</div></div>'
      + '<div class="stag ' + (ok ? 'ok' : 'part') + '">' + (ok ? 'full model' : s.area ? 'level only' : 'no catchment') + '</div>'
      + '</div>';
  }

  /* ---- runs tab ----------------------------------------------------------- */
  function renderRuns() {
    if (S.openRun) return renderRunDetail();

    var h = '<div class="card"><div class="lab">Named runs · Scotland</div>'
      + '<p class="muted">122 sections with the levels paddlers actually use, from the Scottish Canoe Association’s '
      + '<a href="https://www.canoescotland.org/go-paddling/wheres-the-water" target="_blank" rel="noopener">Where’s the Water</a>. '
      + 'These are <b>observed levels, not forecasts</b> — Scotland publishes stage rather than flow, and the model needs a different calibration to predict it.</p>'
      + '<input class="inp" id="rq" placeholder="Search a river — “Etive”, “Findhorn”" value="' + esc(S.runQ) + '">'
      + '<div class="chips" style="margin-top:10px">'
      + [['all','All'],['on','Running now'],['low','Low'],['big','Big']].map(function (o) {
          return '<button class="chip' + (S.runFilter === o[0] ? ' on' : '') + '" data-rf="' + o[0] + '">' + o[1] + '</button>';
        }).join('')
      + '</div></div>';

    if (S.runsBusy) return void (A.innerHTML = h + '<div class="card"><div class="spin"></div><div class="muted">Reading ' + (RiverRuns.all().length || 122) + ' Scottish gauges…</div></div>');
    if (S.runsErr)  return void (A.innerHTML = h + '<div class="card err"><b>Couldn’t reach SEPA</b><p class="muted">' + esc(S.runsErr) + '</p></div>');

    var list = RiverRuns.all().filter(function (r) {
      if (S.runQ && r.s.name.toLowerCase().indexOf(S.runQ.toLowerCase()) < 0) return false;
      if (S.runFilter === 'all') return true;
      if (!r.cls) return false;
      if (S.runFilter === 'on')  return ['medium', 'high'].indexOf(r.cls.cat) >= 0;
      if (S.runFilter === 'low') return ['tooLow', 'scrape', 'low'].indexOf(r.cls.cat) >= 0;
      if (S.runFilter === 'big') return ['veryHigh', 'huge'].indexOf(r.cls.cat) >= 0;
      return true;
    });

    /* runs that are in should surface first, then everything else by name */
    var rank = { medium: 0, high: 1, veryHigh: 2, low: 3, scrape: 4, huge: 5, tooLow: 6 };
    list.sort(function (a, b) {
      var ra = a.cls ? rank[a.cls.cat] : 9, rb = b.cls ? rank[b.cls.cat] : 9;
      return ra !== rb ? ra - rb : (a.s.name < b.s.name ? -1 : 1);
    });

    var on = RiverRuns.all().filter(function (r) { return r.cls && ['medium', 'high'].indexOf(r.cls.cat) >= 0; }).length;
    h += '<div class="lab2">' + list.length + ' shown · ' + on + ' in medium or high right now</div>';

    if (!list.length) h += '<div class="card"><p class="muted">Nothing matches.</p></div>';
    list.forEach(function (r) { h += runRow(r); });

    h += '<div class="card small"><p class="muted">' + esc(RiverRuns.meta() ? RiverRuns.meta().attribution : '') + '</p>'
      + '<p class="muted">Shared under <a href="https://creativecommons.org/licenses/by-sa/4.0" target="_blank" rel="noopener">CC-BY-SA 4.0</a>.</p></div>';
    A.innerHTML = h;
  }

  function runRow(r) {
    var lv = r.level != null ? r.level.toFixed(2) + ' m' : '—';
    var cls = r.cls;
    var frac = r.s.bands ? RiverRuns.fraction(r.level, r.s.bands) : 0;
    return '<div class="srow run" data-run="' + esc(r.s.slug) + '">'
      + '<div class="sinfo"><div class="sn2">' + esc(r.s.name) + '</div>'
      + '<div class="sm">' + (r.s.grade ? 'Grade ' + esc(r.s.grade) + ' · ' : '') + lv
      + (isHazard(r.s.notes) || isHazard(r.s.access) ? ' · <b class="hz">hazard noted</b>' : '') + '</div>'
      + (r.s.bands ? '<div class="lvbar"><i style="width:' + Math.round(frac * 100) + '%"></i></div>' : '')
      + '</div>'
      + '<div class="stag ' + (cls ? 'tone-' + cls.tone : 'part') + '">' + (cls ? esc(cls.label) : 'no reading') + '</div>'
      + '</div>';
  }

  function renderRunDetail() {
    var r = RiverRuns.bySlug(S.openRun);
    if (!r) { S.openRun = null; return renderRuns(); }
    var s = r.s, b = s.bands;
    var h = '<div class="card head-card"><div class="riv">Scotland</div>'
      + '<div class="stn">' + esc(s.name) + '</div>'
      + '<div class="meta">' + (s.grade ? 'Grade ' + esc(s.grade) + ' · ' : '') + esc(s.gauge || '') + '</div>'
      + '<div class="acts"><button class="btn" data-act="backruns">← All runs</button>'
      + (s.putIn ? '<a class="btn go" href="https://waze.com/ul?ll=' + s.putIn[0] + ',' + s.putIn[1] + '&navigate=yes" target="_blank" rel="noopener">Put-in</a>' : '')
      + (s.takeOut ? '<a class="btn" href="https://waze.com/ul?ll=' + s.takeOut[0] + ',' + s.takeOut[1] + '&navigate=yes" target="_blank" rel="noopener">Take-out</a>' : '')
      + (s.guidebook ? '<a class="btn" href="' + esc(s.guidebook) + '" target="_blank" rel="noopener">Guidebook ↗</a>' : '')
      + '</div></div>';

    h += '<div class="card verdict ' + (r.cls ? r.cls.tone : 'na') + '"><div class="vrow"><div>'
      + '<div class="lab">Gauge reading</div>'
      + '<div class="big">' + (r.level != null ? r.level.toFixed(2) + ' m' : '—') + '</div>'
      + '<div class="sub">' + (r.at ? esc(shortTime(r.at)) : 'no recent reading') + '</div></div>'
      + '<div class="badge ' + (r.cls ? r.cls.tone : '') + '">' + (r.cls ? esc(r.cls.label) : '—') + '</div></div>'
      + '<p class="muted">This is what the gauge says now, not a forecast.</p></div>';

    if (b) {
      h += '<div class="card"><div class="lab">Paddler levels</div><div class="ladder">';
      RiverRuns.CAT.forEach(function (k) {
        if (b[k] == null) return;
        var hit = r.cls && r.cls.cat === k;
        h += '<div class="rung' + (hit ? ' on' : '') + '"><span class="rk">' + esc(RiverRuns.CAT_LABEL[k]) + '</span>'
          + '<span class="rv">' + b[k].toFixed(2) + ' m</span></div>';
      });
      h += '</div><p class="muted">Thresholds recorded by paddlers for this section, not derived from statistics.</p></div>';
    }

    /* Paddler notes carry things that matter more than the level does — trees,
       wires, weirs, sewage releases. Those get a banner, not a footnote. */
    var haz = [s.notes, s.access].filter(Boolean).filter(function (t) { return isHazard(t); });
    haz.forEach(function (t) {
      h += '<div class="card hazard"><div class="lab">Reported hazard</div><p>' + esc(t) + '</p></div>';
    });
    if (s.access && haz.indexOf(s.access) < 0) h += '<div class="card"><div class="lab">Access</div><p class="muted">' + esc(s.access) + '</p></div>';
    if (s.notes && haz.indexOf(s.notes) < 0)  h += '<div class="card"><div class="lab">Notes</div><p class="muted">' + esc(s.notes) + '</p></div>';

    h += '<div class="card small"><p class="muted">' + esc(RiverRuns.meta() ? RiverRuns.meta().attribution : '') + '</p></div>';
    A.innerHTML = h;
  }

  var HAZARD = /\b(tree|trees|wire|wires|fence|strainer|weir|sewage|siphon|blockage|do not paddle|portage|dead|log ?jam|barbed)\b/i;
  function isHazard(t) { return HAZARD.test(t || ''); }

  /* ---- model tab --------------------------------------------------------- */
  function renderModel() {
    var r = S.result;
    var h = '<div class="card"><div class="lab">The model</div>'
      + '<p class="muted">A conceptual store model: rain falls on a soil-moisture store, what the store cannot hold becomes runoff through two quick reservoirs in series, and slow drainage feeds a groundwater store that sets the recession. Seven parameters, fitted per gauge.</p></div>';
    if (!r) { h += '<div class="card"><p class="muted">Open a river to see its fitted parameters.</p></div>'; A.innerHTML = h; return; }
    h += '<div class="card"><div class="lab">Fitted for ' + esc(r.station.label) + '</div><div class="pars">';
    M.PARAMS.forEach(function (p) {
      var v = r.par[p.key];
      var pct = (v - p.lo) / (p.hi - p.lo) * 100;
      h += '<div class="par"><div class="ph"><b>' + esc(p.label) + '</b><span>' + fmtPar(v, p) + '</span></div>'
        + '<div class="ptrack"><i style="left:' + Math.max(0, Math.min(98, pct)) + '%"></i></div>'
        + '<div class="pn">' + esc(p.note) + '</div></div>';
    });
    h += '</div></div>';
    if (r.rating) {
      h += '<div class="card"><div class="lab">Rating curve</div>'
        + '<p class="muted">level ≈ ' + r.rating.c.toFixed(3) + ' × flow<sup>' + r.rating.m.toFixed(3) + '</sup> — fitted on ' + r.rating.n + ' paired daily readings, r² ' + r.rating.r2.toFixed(3) + '. '
        + 'The model works in flow because mass balance is additive there; metres come out at the end.</p></div>';
    }
    h += '<div class="card"><div class="lab">Measured skill</div>'
      + '<p class="muted">348 rolling forecasts per gauge over November 2025 – February 2026, verified against 15-minute observed flow. '
      + '“Skill” is the reduction in mean absolute error against assuming the river stays where it is.</p>'
      + '<table class="verif"><tr><th>Gauge</th><th>6 h</th><th>24 h</th><th>48 h</th></tr>'
      + '<tr><td>Dart, 248 km²</td><td class="good">+27%</td><td class="good">+52%</td><td class="good">+57%</td></tr>'
      + '<tr><td>Kent, 209 km²</td><td class="good">+18%</td><td class="good">+46%</td><td class="good">+55%</td></tr>'
      + '<tr><td>Severn, 4325 km²</td><td>−2%</td><td class="good">+10%</td><td class="good">+26%</td></tr>'
      + '</table>'
      + '<p class="muted">Two things worth reading off that. On a big, slow river persistence is genuinely hard to beat in the first few hours — the Severn barely moves in six. And in a flat summer recession, as the panel on the forecast page will tell you, persistence wins outright. The model earns its keep when water is arriving.</p>'
      + '<p class="muted">Anchoring on the live gauge does most of the short-range work: without it the six-hour error on the Severn is 26.5 m³/s, with it 5.2.</p></div>';

    h += '<div class="card"><div class="lab">Known limits</div><ul class="pts">'
      + '<li>The catchment is approximated as a disc around the gauge, not delineated from terrain. On a long thin catchment that mis-weights where the rain fell.</li>'
      + '<li>Calibration rainfall is ERA5 reanalysis; forecast rainfall is a different model. The rainfall multiplier absorbs the average offset but not the storm-by-storm difference.</li>'
      + '<li>Reservoir releases, abstraction and hydro operation are invisible to it. On a regulated river the forecast will be wrong in ways the error bars do not cover.</li>'
      + '<li>Snowmelt uses a fixed degree-day factor rather than a fitted one — thin in a Pennine or Lakeland winter.</li>'
      + '</ul></div>';
    A.innerHTML = h;
  }
  function fmtPar(v, p) {
    var s = v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(3);
    return s + (p.unit ? ' ' + p.unit : '');
  }

  /* ==========================================================================
     CHART
     ========================================================================== */
  function drawChart(r) {
    var c = document.getElementById('chart');
    if (!c) return;
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth || 320, hgt = 240;
    c.width = w * dpr; c.height = hgt * dpr;
    var x = c.getContext('2d'); x.scale(dpr, dpr);

    var padL = 44, padR = 8, padT = 12, padB = 26;
    var W = w - padL - padR, H = hgt - padT - padB;

    /* observed tail (last 3 days) + forecast */
    var obsTail = r.obsSeries.slice(-3 * 96);
    var nFc = r.fc.p50.length;
    var t0 = obsTail.length ? parseTime(obsTail[0].t) : parseTime(r.times[0]);
    var t1 = parseTime(r.times[nFc - 1]);
    var span = Math.max(1, t1 - t0);

    /* Scale to the data, not to the band. In August the band can sit fifty
       times above the river, and a linear axis stretched to reach it flattens
       the hydrograph into the baseline — the one thing the chart exists to
       show. The band is allowed to push the top out only so far.

       The axis is square-root rather than linear: a river spans orders of
       magnitude between summer baseflow and a flood, and sqrt keeps the low
       end readable without the zero problem a log axis has. */
    var vals = [];
    obsTail.forEach(function (p) { vals.push(p.v); });
    for (var i = 0; i < nFc; i++) { vals.push(r.fc.p90[i]); vals.push(r.fc.p10[i]); }
    var dataMax = Math.max.apply(null, vals.filter(isFinite)) || 1;
    var vmax = Math.max(dataMax * 1.15, Math.min(r.band.hi * 1.1, dataMax * 2.5));

    var tf = Math.sqrt, inv = function (u) { return u * u; };
    var px = function (t) { return padL + (t - t0) / span * W; };
    var py = function (v) { return padT + H - tf(Math.max(v, 0)) / tf(vmax) * H; };

    var css = getComputedStyle(document.documentElement);
    var col = function (n) { return css.getPropertyValue(n).trim() || '#888'; };

    x.clearRect(0, 0, w, hgt);

    /* runnable band, clipped to the plot */
    var bTop = Math.max(padT, py(Math.min(r.band.hi, vmax)));
    var bBot = Math.min(padT + H, py(r.band.lo));
    if (bBot > bTop) { x.fillStyle = col('--band'); x.fillRect(padL, bTop, W, bBot - bTop); }

    /* gridlines, spaced evenly in the transformed axis */
    x.strokeStyle = col('--grid'); x.lineWidth = 1;
    x.fillStyle = col('--sub'); x.font = '10px -apple-system,system-ui,sans-serif';
    for (var g = 0; g <= 4; g++) {
      var v = inv(tf(vmax) * g / 4), yy = py(v);
      x.beginPath(); x.moveTo(padL, yy); x.lineTo(padL + W, yy); x.stroke();
      x.fillText(v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), 4, yy + 3);
    }

    /* day boundaries */
    x.strokeStyle = col('--grid');
    for (var d = 0; d < nFc; d += 24) {
      var t = parseTime(r.times[d]), xx = px(t);
      x.beginPath(); x.moveTo(xx, padT); x.lineTo(xx, padT + H); x.stroke();
      x.fillText(dayName(r.times[d]), xx + 3, padT + H + 14);
    }

    /* forecast fan */
    var fan = function (lo, hi, alpha) {
      x.beginPath();
      for (var i = 0; i < nFc; i++) { var t = parseTime(r.times[i]); i ? x.lineTo(px(t), py(hi[i])) : x.moveTo(px(t), py(hi[i])); }
      for (var j = nFc - 1; j >= 0; j--) { var t2 = parseTime(r.times[j]); x.lineTo(px(t2), py(lo[j])); }
      x.closePath();
      x.globalAlpha = alpha; x.fillStyle = col('--accent'); x.fill(); x.globalAlpha = 1;
    };
    fan(r.fc.p10, r.fc.p90, 0.16);
    fan(r.fc.p25, r.fc.p75, 0.18);

    /* median */
    x.strokeStyle = col('--accent'); x.lineWidth = 2; x.beginPath();
    for (var k = 0; k < nFc; k++) {
      var tk = parseTime(r.times[k]);
      k ? x.lineTo(px(tk), py(r.fc.p50[k])) : x.moveTo(px(tk), py(r.fc.p50[k]));
    }
    x.stroke();

    /* observed */
    if (obsTail.length) {
      x.strokeStyle = col('--ink'); x.lineWidth = 1.8; x.beginPath();
      obsTail.forEach(function (p, i) {
        var t = parseTime(p.t);
        i ? x.lineTo(px(t), py(p.v)) : x.moveTo(px(t), py(p.v));
      });
      x.stroke();
    }

    /* now line */
    var tn = parseTime(r.times[0]);
    x.strokeStyle = col('--now'); x.lineWidth = 1; x.setLineDash([3, 3]);
    x.beginPath(); x.moveTo(px(tn), padT); x.lineTo(px(tn), padT + H); x.stroke();
    x.setLineDash([]);
  }

  /* ==========================================================================
     EVENTS
     ========================================================================== */
  function isFav(g) { return S.favs.some(function (f) { return f.guid === g; }); }

  document.addEventListener('click', function (ev) {
    var tabBtn = ev.target.closest('.tab');
    if (tabBtn) {
      S.tab = tabBtn.getAttribute('data-tab');
      if (S.tab === 'runs') loadRuns();
      render();
      return;
    }

    var runRowEl = ev.target.closest('.srow.run');
    if (runRowEl) { S.openRun = runRowEl.getAttribute('data-run'); render(); return; }

    var rf = ev.target.closest('[data-rf]');
    if (rf) { S.runFilter = rf.getAttribute('data-rf'); render(); return; }

    var row = ev.target.closest('.srow');
    if (row) {
      var g = row.getAttribute('data-guid');
      var st = S.search.concat(S.favs).filter(function (s) { return s.guid === g; })[0];
      if (st) openStation(st);
      return;
    }

    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');

    if (act === 'gopick') { S.tab = 'pick'; render(); }
    else if (act === 'search') doSearch();
    else if (act === 'near') doNear();
    else if (act === 'refresh' && S.station) openStation(S.station);
    else if (act === 'export') doExport(b);
    else if (act === 'backruns') { S.openRun = null; render(); }
    else if (act === 'fav' && S.station) {
      if (isFav(S.station.guid)) S.favs = S.favs.filter(function (f) { return f.guid !== S.station.guid; });
      else S.favs = S.favs.concat([S.station]);
      save('rp.favs', S.favs); render();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.id === 'q') doSearch();
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') { S.q = e.target.value; return; }
    if (e.target.id === 'rq') { S.runQ = e.target.value; renderRuns(); return; }
    if (!S.result) return;
    if (e.target.id === 'blo' || e.target.id === 'bhi') {
      var r = S.result;
      var lo = qOfPct(+document.getElementById('blo').value, r.stats);
      var hi = qOfPct(+document.getElementById('bhi').value, r.stats);
      if (lo > hi) { var t = lo; lo = hi; hi = t; }
      r.band = { lo: lo, hi: hi };
      S.band[r.station.guid] = r.band; save('rp.bands', S.band);
      document.getElementById('blov').textContent = fmtQ(lo, r);
      document.getElementById('bhiv').textContent = fmtQ(hi, r);
      r.prob = M.probInBand(r.fc, lo, hi);
      drawChart(r);
    }
  });

  document.addEventListener('change', function (e) {
    if ((e.target.id === 'blo' || e.target.id === 'bhi') && S.result) render();
  });

  /* Hand the archive over as a file. iOS Safari is fussy about programmatic
     downloads, so fall back to the share sheet and then to the clipboard —
     between the three, something always works. */
  async function doExport(btn) {
    var json;
    try { json = await RiverArchive.exportAll(); }
    catch (e) { btn.textContent = 'Nothing stored'; return; }
    var name = 'riverwise-forecasts-' + new Date().toISOString().slice(0, 10) + '.json';
    var file = null;
    try { file = new File([json], name, { type: 'application/json' }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Riverwise forecast record' }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try {
      var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      var a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
      btn.textContent = 'Exported';
      return;
    } catch (e) {}
    try { await navigator.clipboard.writeText(json); btn.textContent = 'Copied to clipboard'; }
    catch (e) { btn.textContent = 'Export unavailable'; }
  }

  async function loadRuns() {
    if (RiverRuns.fetchedAt()) return;
    S.runsBusy = true; S.runsErr = null;
    try {
      await RiverRuns.load();
      render();                       /* show the list while levels arrive */
      await RiverRuns.refresh();
    } catch (e) {
      S.runsErr = String(e && e.message || e);
    }
    S.runsBusy = false; render();
  }

  async function doSearch() {
    var term = (S.q || '').trim();
    if (term.length < 2) return;
    S.searching = true; S.searched = true; S.search = []; render();
    try { S.search = await D.searchStations(term); }
    catch (e) { S.search = []; }
    S.searching = false; render();
  }

  async function doNear() {
    if (!navigator.geolocation) return;
    S.searching = true; S.searched = true; render();
    navigator.geolocation.getCurrentPosition(async function (pos) {
      try {
        var near = await D.nearbyStations(pos.coords.latitude, pos.coords.longitude, 10);
        var out = [];
        for (var i = 0; i < near.length; i++) {
          try { out.push(await D.hydroFromEaRef(near[i].eaRef)); } catch (e) {}
        }
        S.search = out.filter(function (s) { return s && s.guid; });
      } catch (e) { S.search = []; }
      S.searching = false; render();
    }, function () { S.searching = false; render(); }, { timeout: 12000 });
  }

  window.addEventListener('resize', function () { if (S.result && S.tab === 'now') drawChart(S.result); });

  /* install prompt */
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    var b = document.getElementById('install'); if (b) b.hidden = false;
  });
  var ib = document.getElementById('install');
  if (ib) ib.addEventListener('click', function () { if (deferred) { deferred.prompt(); deferred = null; ib.hidden = true; } });

  /* boot: reopen the last river */
  (function boot() {
    if (S.lastGuid) {
      var f = S.favs.filter(function (x) { return x.guid === S.lastGuid; })[0];
      if (f) return openStation(f);
      D.stationByGuid(S.lastGuid).then(openStation).catch(function () { render(); });
      return;
    }
    render();
  })();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
