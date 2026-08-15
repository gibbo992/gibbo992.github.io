/* ============================================================================
   worker.js — calibration and verification, off the main thread.

   Fitting seven parameters against two years of hourly forcing is a few
   seconds of solid arithmetic. On the main thread that would freeze the UI
   mid-scroll, which on a phone reads as a crash. Here it streams progress
   instead, and the result is cached so it only ever happens once per gauge.
   ========================================================================== */
importScripts('model.js');

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.cmd !== 'calibrate') return;

  var forcing = { p: msg.p, t: msg.t, e: msg.e };
  var area = msg.area, obs = msg.obs, windows = msg.windows;
  var warm = Math.min(180, Math.floor(windows.length * 0.25));

  try {
    var cal = RiverModel.calibrate(forcing, obs, windows, area, 1, {
      pop: msg.pop || 32,
      gen: msg.gen || 60,
      warmup: warm,
      seed: 7
    }, function (p) {
      self.postMessage({ type: 'progress', phase: 'calibrate',
                         pct: p.gen / p.of, kge: p.kge });
    });

    /* quality of the fit, scored only on the part of the record the optimiser
       was allowed to see the objective for */
    var sim = RiverModel.simulate(forcing, cal.par, area, 1);
    var agg = RiverModel.aggregate(sim.q, windows);
    var fit = {
      kge: RiverModel.kge(agg.slice(warm), obs.slice(warm), 'sqrt'),
      nse: RiverModel.nse(Array.prototype.slice.call(agg.slice(warm)), obs.slice(warm))
    };

    self.postMessage({ type: 'done', par: cal.par, fit: fit });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};
