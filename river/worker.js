/* ============================================================================
   worker.js — calibration and backtesting, off the main thread.

   Fitting eight parameters against two years of hourly forcing is a few seconds
   of solid arithmetic, and the split-sample diagnostic is a second fit on top.
   On the main thread that would freeze the UI mid-scroll, which on a phone
   reads as a crash. Here it streams progress instead, and the whole result is
   cached so it only ever happens once per gauge.
   ========================================================================== */
importScripts('model.js');

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.cmd !== 'calibrate') return;

  var forcing = { p: msg.p, t: msg.t, e: msg.e };
  var area = msg.area, obs = msg.obs, windows = msg.windows, months = msg.months;
  var warm = Math.min(180, Math.floor(windows.length * 0.25));

  function say(phase, pct) { self.postMessage({ type: 'progress', phase: phase, pct: pct }); }

  try {
    /* ---- 1. the model that ships: fitted on everything ------------------- */
    var cal = RiverModel.calibrate(forcing, obs, windows, area, 1, {
      pop: msg.pop || 32, gen: msg.gen || 60, warmup: warm, seed: 7
    }, function (p) { say('calibrate', p.gen / p.of); });

    var sim = RiverModel.simulate(forcing, cal.par, area, 1);
    var agg = RiverModel.aggregate(sim.q, windows);
    var fit = {
      kge: RiverModel.kge(agg.slice(warm), obs.slice(warm), 'sqrt'),
      nse: RiverModel.nse(Array.prototype.slice.call(agg.slice(warm)), obs.slice(warm))
    };

    /* ---- 2. has it overfitted? ------------------------------------------ */
    say('split', 0);
    var split = null;
    try { split = RiverModel.splitSample(forcing, obs, windows, area, 1, { frac: 0.6, pop: 24, gen: 40 }); }
    catch (e) {}
    say('split', 1);

    /* ---- 3. how well does it actually forecast this river? --------------- */
    say('backtest', 0);
    var bt = null;
    try {
      bt = RiverModel.backtestDaily(forcing, windows, obs, cal.par, area, 1,
        { leadDays: 5, warmup: warm, months: months });
    } catch (e) {}
    say('backtest', 1);

    self.postMessage({
      type: 'done',
      par: cal.par,
      fit: fit,
      split: split,
      bt: bt ? compact(bt) : null
    });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};

/* Keep only what the app renders or reuses — the full sweep holds several
   Float64Arrays per weight and this ends up in localStorage. */
function compact(bt) {
  var b = bt.best;
  return {
    weight: b.weight,
    nOrigins: bt.nOrigins,
    bounds: bt.bounds,
    mae: arr(b.mae), per: arr(b.per), climo: arr(b.climo),
    skill: arr(b.skill), sigma: arr(b.sigma),
    regime: {
      low:  { skill: arr(bt.best.regime.low.skill),  mae: arr(bt.best.regime.low.mae),  n: bt.best.regime.low.n },
      mid:  { skill: arr(bt.best.regime.mid.skill),  mae: arr(bt.best.regime.mid.mae),  n: bt.best.regime.mid.n },
      high: { skill: arr(bt.best.regime.high.skill), mae: arr(bt.best.regime.high.mae), n: bt.best.regime.high.n }
    },
    sweep: bt.runs.map(function (r) {
      return { weight: r.weight, skill3: mean3(r.skill) };
    })
  };
}
function arr(a) {
  return Array.prototype.slice.call(a).map(function (v) { return Math.round(v * 10000) / 10000; });
}
function mean3(s) {
  var n = Math.min(3, s.length), t = 0;
  for (var i = 0; i < n; i++) t += s[i];
  return Math.round(t / n * 10000) / 10000;
}
