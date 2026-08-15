/* ============================================================================
   model.js — conceptual rainfall-runoff model, calibration, assimilation,
   ensemble propagation and verification.

   Pure functions, no DOM, no network. Loaded by both the main thread and the
   calibration worker (importScripts), and runnable under node for testing.

   Units throughout:
     precipitation / melt / storage : mm  (depth over the catchment)
     temperature                    : degC
     potential evapotranspiration   : mm per timestep
     flow                           : m3/s
     time                           : hours
   ========================================================================== */
(function (root) {
  'use strict';

  /* mm/timestep of depth over `area` km2  ->  m3/s */
  function mmToCumecs(area, dtHours) {
    return (area * 1e6 * 1e-3) / (dtHours * 3600);
  }

  var clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };

  /* --------------------------------------------------------------------------
     PARAMETERS

     Eight calibrated parameters. Every one is physically interpretable, which
     is the point: it can be sanity-checked, bounded, and it extrapolates to
     events larger than anything in the training record — the regime where a
     purely statistical model has nothing to lean on.
     ------------------------------------------------------------------------ */
  var PARAMS = [
    { key: 'pcorr', lo: 0.6,  hi: 2.5,   label: 'Rainfall multiplier',    unit: '×',      note: 'Corrects grid rainfall against catchment reality (orographic enhancement, gauge undercatch).' },
    { key: 'smax',  lo: 30,   hi: 600,   label: 'Soil moisture capacity', unit: 'mm',     note: 'How much water the catchment can absorb before it starts shedding it.' },
    { key: 'beta',  lo: 0.6,  hi: 6,     label: 'Runoff nonlinearity',    unit: '',       note: 'How sharply response steepens as the ground wets up. High = flashy.' },
    { key: 'perc',  lo: 0.005,hi: 0.6,   label: 'Percolation rate',       unit: 'mm/h',   note: 'Drainage from soil to groundwater — sets baseflow.' },
    { key: 'k1',    lo: 0.5,  hi: 48,    label: 'Hillslope response',     unit: 'h',      note: 'Residence time of the first storm-runoff store. Small = spiky hydrograph.' },
    { key: 'k2',    lo: 0.5,  hi: 48,    label: 'Channel routing',        unit: 'h',      note: 'Second store in series — sets time-to-peak and how rounded the peak is.' },
    { key: 'ks',    lo: 20,   hi: 4000,  label: 'Baseflow recession',     unit: 'h',      note: 'Residence time of groundwater — sets how slowly the river falls away.' },
    { key: 'bs',    lo: 1,    hi: 2.2,     label: 'Recession curvature',    unit: '',       note: 'Above 1 the groundwater store drains proportionally slower as it empties, so the river holds a summer baseflow instead of running dry.' }
  ];

  /* Fixed (not calibrated — too little information in most UK records to
     identify them, and sensible literature values do the job). */
  var DDF = 3.0;   /* degree-day melt factor, mm/degC/day */
  var TT  = 0.6;   /* rain/snow threshold, degC */

  function defaultPar() {
    return { pcorr: 1.0, smax: 200, beta: 2.5, perc: 0.08, k1: 6, k2: 6, ks: 500, bs: 1.5 };
  }

  function parToVec(p) { return PARAMS.map(function (d) { return p[d.key]; }); }
  function vecToPar(v) {
    var p = {};
    for (var i = 0; i < PARAMS.length; i++) p[PARAMS[i].key] = v[i];
    return p;
  }

  /* --------------------------------------------------------------------------
     SIMULATE

     forcing = { p: Float64Array (mm per step),
                 t: Float64Array (degC),
                 e: Float64Array (mm potential ET per step) }

     Structure:
        snow store  --(degree-day melt)-->
        soil store  --(saturation excess, nonlinear)--> quick store 1 -> quick store 2
                    --(percolation)-------------------> groundwater store
        the two quick stores are linear and sit in series, which produces a
        realistic delayed, rounded flood peak; the groundwater store is
        nonlinear, which is what lets a river hold a baseflow all summer.

     Time-to-peak comes out of the cascade rather than a post-hoc shift of the
     output series. That matters: the delay then lives in the model *state*, so
     a forecast restarted mid-event from an assimilated state still carries the
     water already in transit. A shifted output series loses it.

     Returns { q: Float64Array (m3/s), state: {...} }.
     `out` and `state0` let the optimiser reuse buffers and let the forecast
     continue from an assimilated state; `states`, if given, is filled with a
     copy of the state after every step (used by the rolling hindcast).
     ------------------------------------------------------------------------ */
  function simulate(forcing, par, area, dtHours, out, state0, states) {
    var n = forcing.p.length;
    var q = out && out.length === n ? out : new Float64Array(n);

    var pcorr = par.pcorr, smax = par.smax, beta = par.beta,
        perc = par.perc, k1 = par.k1, k2 = par.k2, ks = par.ks,
        bs = par.bs == null ? 1 : par.bs;

    var S  = state0 ? state0.S  : 0.6 * smax;
    var Q1 = state0 ? state0.Q1 : 0;
    var Q2 = state0 ? state0.Q2 : 0;
    var Ss = state0 ? state0.Ss : 0;
    var Sn = state0 ? state0.Sn : 0;

    /* Linear reservoir outflow fractions for this timestep. Using the
       exponential form (not dt/k) keeps the model stable and makes the
       calibrated k a true residence time regardless of timestep. */
    var f1 = 1 - Math.exp(-dtHours / Math.max(k1, 0.25));
    var f2 = 1 - Math.exp(-dtHours / Math.max(k2, 0.25));
    var ksSafe = Math.max(ks, 1);
    var SREF = 100;   /* mm — reference storage that keeps the exponent dimensionless */
    var meltPerStep = DDF * dtHours / 24;
    var conv = mmToCumecs(area, dtHours);
    var wilt = 0.7 * smax;

    for (var i = 0; i < n; i++) {
      var P = forcing.p[i] * pcorr;
      var T = forcing.t[i];
      var E = forcing.e[i];
      if (!(P >= 0)) P = 0;
      if (!(T > -99)) T = 5;
      if (!(E >= 0)) E = 0;

      /* --- snow ------------------------------------------------------- */
      var rain, melt = 0;
      if (T < TT) { Sn += P; rain = 0; }
      else {
        rain = P;
        if (Sn > 0) { melt = Math.min(Sn, meltPerStep * (T - TT)); Sn -= melt; }
      }
      var input = rain + melt;

      /* --- soil moisture: saturation-excess runoff generation ---------- */
      var sf = S / smax; if (sf < 0) sf = 0; else if (sf > 1) sf = 1;
      var qgen = input * Math.pow(sf, beta);
      S += input - qgen;

      /* --- percolation to groundwater --------------------------------- */
      var pc = perc * dtHours * sf * sf;
      if (pc > S) pc = S;
      S -= pc;

      /* --- actual evapotranspiration ---------------------------------- */
      var aet = E * Math.min(1, S / wilt);
      S -= aet;
      if (S < 0) S = 0;
      if (S > smax) { qgen += S - smax; S = smax; }

      /* --- routing: two quick stores in series, one slow store in parallel */
      Q1 += qgen;  var o1 = Q1 * f1; Q1 -= o1;
      Q2 += o1;    var o2 = Q2 * f2; Q2 -= o2;

      /* Nonlinear groundwater store (Wittenberg). A linear store drains at a
         fixed proportional rate, so through a two-month dry spell it empties
         and the model shows a river running to nothing while the real one sits
         on baseflow all summer. With bs above 1 the store lets go more slowly
         the emptier it gets, which is what a real aquifer does — and it is the
         difference between a useful August forecast and a useless one. */
      Ss += pc;
      var os = dtHours * (Ss / ksSafe) * (bs === 1 ? 1 : Math.pow(Ss / SREF, bs - 1));
      if (!(os > 0)) os = 0;
      if (os > Ss) os = Ss;
      Ss -= os;

      q[i] = (o2 + os) * conv;

      if (states) states[i] = { S: S, Q1: Q1, Q2: Q2, Ss: Ss, Sn: Sn };
    }

    return { q: q, state: { S: S, Q1: Q1, Q2: Q2, Ss: Ss, Sn: Sn } };
  }

  /* --------------------------------------------------------------------------
     OBJECTIVE

     Kling-Gupta Efficiency on square-root-transformed flow.

     Why not RMSE (which is what most river ML projects minimise): RMSE is
     dominated by the handful of biggest floods, so a model can score well
     while being useless across the mid-range where a paddling or fishing
     decision is actually made. KGE decomposes error into correlation, spread
     and bias and weights them equally, so a model cannot buy a good score by
     flattening the hydrograph — the classic failure mode of an under-trained
     LSTM, which learns to predict something close to the mean and scores
     respectably on RMSE while never calling a rise.

     The sqrt transform pulls the extreme peaks in without ignoring them.
     ------------------------------------------------------------------------ */
  function kge(sim, obs, transform) {
    var f = transform === 'sqrt' ? Math.sqrt
          : transform === 'log'  ? function (x) { return Math.log(x + 0.01); }
          : function (x) { return x; };
    var n = 0, ms = 0, mo = 0, i;
    for (i = 0; i < obs.length; i++) {
      if (obs[i] == null || !isFinite(obs[i]) || !isFinite(sim[i])) continue;
      ms += f(Math.max(sim[i], 0)); mo += f(Math.max(obs[i], 0)); n++;
    }
    if (n < 10) return -999;
    ms /= n; mo /= n;
    var vs = 0, vo = 0, cov = 0;
    for (i = 0; i < obs.length; i++) {
      if (obs[i] == null || !isFinite(obs[i]) || !isFinite(sim[i])) continue;
      var ds = f(Math.max(sim[i], 0)) - ms, dobs = f(Math.max(obs[i], 0)) - mo;
      vs += ds * ds; vo += dobs * dobs; cov += ds * dobs;
    }
    vs = Math.sqrt(vs / n); vo = Math.sqrt(vo / n);
    if (vo === 0 || vs === 0 || mo === 0) return -999;
    var r = cov / n / (vs * vo);
    var a = vs / vo;          /* variability ratio */
    var b = ms / mo;          /* bias ratio        */
    return 1 - Math.sqrt((r - 1) * (r - 1) + (a - 1) * (a - 1) + (b - 1) * (b - 1));
  }

  function nse(sim, obs) {
    var n = 0, mo = 0, i;
    for (i = 0; i < obs.length; i++) { if (obs[i] != null && isFinite(obs[i])) { mo += obs[i]; n++; } }
    if (!n) return -999;
    mo /= n;
    var num = 0, den = 0;
    for (i = 0; i < obs.length; i++) {
      if (obs[i] == null || !isFinite(obs[i]) || !isFinite(sim[i])) continue;
      num += (sim[i] - obs[i]) * (sim[i] - obs[i]);
      den += (obs[i] - mo) * (obs[i] - mo);
    }
    return den ? 1 - num / den : -999;
  }

  /* Aggregate an hourly (or dt-hourly) simulated series onto the observation
     windows supplied by the caller. `windows` is an array of [startIdx,endIdx). */
  function aggregate(q, windows) {
    var out = new Float64Array(windows.length);
    for (var w = 0; w < windows.length; w++) {
      var a = windows[w][0], b = windows[w][1], s = 0, c = 0;
      for (var i = a; i < b; i++) { if (i >= 0 && i < q.length) { s += q[i]; c++; } }
      out[w] = c ? s / c : NaN;
    }
    return out;
  }

  /* --------------------------------------------------------------------------
     CALIBRATION — differential evolution

     Derivative-free, handles the discontinuous/flat regions that a conceptual
     store model produces, and needs no gradients or external library. Runs in
     a worker so the phone stays responsive.
     ------------------------------------------------------------------------ */
  function calibrate(forcing, obs, windows, area, dtHours, opts, onProgress) {
    opts = opts || {};
    var NP    = opts.pop  || 32;
    var GEN   = opts.gen  || 60;
    var F     = 0.7, CR = 0.9;
    var warm  = opts.warmup || 0;      /* windows to exclude from scoring */
    var seed  = opts.seed || 12345;
    var rnd   = mulberry32(seed);
    var D     = PARAMS.length;

    var buf = new Float64Array(forcing.p.length);
    var obsScore = obs.slice(warm);

    function score(vec) {
      for (var i = 0; i < D; i++) {
        if (!isFinite(vec[i])) return -999;
        vec[i] = clamp(vec[i], PARAMS[i].lo, PARAMS[i].hi);
      }
      var res = simulate(forcing, vecToPar(vec), area, dtHours, buf);
      var agg = aggregate(res.q, windows);
      return kge(agg.slice(warm), obsScore, 'sqrt');
    }

    /* population — seed one member with the default so a sane guess is always
       in the mix, the rest latin-ish random across the bounds */
    var pop = [], fit = [], i, j;
    for (i = 0; i < NP; i++) {
      var v = new Array(D);
      for (j = 0; j < D; j++) {
        var d = PARAMS[j];
        /* sample log-uniform for the scale parameters — they span orders of
           magnitude and uniform sampling would barely explore the low end */
        v[j] = (d.lo > 0 && d.hi / d.lo > 20)
          ? Math.exp(Math.log(d.lo) + rnd() * (Math.log(d.hi) - Math.log(d.lo)))
          : d.lo + rnd() * (d.hi - d.lo);
      }
      pop.push(v);
    }
    pop[0] = parToVec(defaultPar());
    for (i = 0; i < NP; i++) fit.push(score(pop[i]));

    var best = 0;
    for (i = 1; i < NP; i++) if (fit[i] > fit[best]) best = i;

    for (var g = 0; g < GEN; g++) {
      for (i = 0; i < NP; i++) {
        var a, b, c;
        do { a = (rnd() * NP) | 0; } while (a === i);
        do { b = (rnd() * NP) | 0; } while (b === i || b === a);
        do { c = (rnd() * NP) | 0; } while (c === i || c === a || c === b);
        var trial = new Array(D);
        var jr = (rnd() * D) | 0;
        for (j = 0; j < D; j++) {
          trial[j] = (rnd() < CR || j === jr)
            ? pop[a][j] + F * (pop[b][j] - pop[c][j])
            : pop[i][j];
        }
        var ft = score(trial);
        if (ft > fit[i]) { pop[i] = trial; fit[i] = ft; if (ft > fit[best]) best = i; }
      }
      if (onProgress && (g % 5 === 0 || g === GEN - 1)) {
        onProgress({ gen: g + 1, of: GEN, kge: fit[best] });
      }
    }

    return { par: vecToPar(pop[best]), kge: fit[best] };
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* --------------------------------------------------------------------------
     DATA ASSIMILATION

     The single largest short-range improvement available, and the thing a
     train-once statistical model cannot do: use the fact that we can see the
     river right now.

     The model's stores are rescaled so that simulated flow at the forecast
     origin equals the observed flow. Because the stores carry the recession,
     the correction persists in a physically consistent way instead of being a
     constant offset bolted onto the output — and it decays naturally as new
     rainfall takes over as the dominant signal.
     ------------------------------------------------------------------------ */
  /* --------------------------------------------------------------------------
     WARM START

     A forecast run only spins up over the last couple of months. That is
     plenty to get the soil store right, but nowhere near enough to fill the
     groundwater store: through a dry summer it starts empty and drains, so the
     model shows a river heading for zero while the real one sits on baseflow.
     Seeding the slow store with whatever flow the river is actually carrying
     at the start of the window fixes it in one line.
     ------------------------------------------------------------------------ */
  function warmStart(par, area, q0, dtHours) {
    var conv = mmToCumecs(area, dtHours);
    var bs = par.bs == null ? 1 : par.bs;
    var ks = Math.max(par.ks, 1);
    var Ss = 0;
    if (q0 > 0) {
      /* invert  out = dt * (Ss/ks) * (Ss/100)^(bs-1)  for Ss */
      var target = (q0 / conv) * ks * Math.pow(100, bs - 1) / dtHours;
      Ss = Math.pow(target, 1 / bs);
    }
    return { S: 0.6 * par.smax, Q1: 0, Q2: 0, Ss: Ss, Sn: 0 };
  }

  function assimilate(state, qSimNow, qObsNow, par, opts) {
    opts = opts || {};
    if (!(qSimNow > 0) || !(qObsNow > 0)) return { state: state, ratio: 1 };
    var ratio = clamp(qObsNow / qSimNow, opts.min || 0.25, opts.max || 4);
    var w = opts.weight == null ? 1 : opts.weight;
    var r = Math.pow(ratio, w);

    /* Each store has to be scaled by whatever makes ITS OUTFLOW change by r —
       which is not the same number for each, because the groundwater store is
       nonlinear. Its outflow goes as storage^bs, so scaling its storage by r
       multiplies its discharge by r^bs: with bs near 3 a fourfold correction
       became a sixty-fourfold one, and the forecast left the planet. Invert
       the exponent instead. */
    var bs = (par && par.bs) ? par.bs : 1;
    var rSlow = Math.pow(r, 1 / bs);

    return {
      state: { S: state.S, Q1: state.Q1 * r, Q2: state.Q2 * r,
               Ss: state.Ss * rSlow, Sn: state.Sn },
      ratio: ratio
    };
  }

  /* --------------------------------------------------------------------------
     ENSEMBLE

     members: array of forcing objects (one per rainfall ensemble member).
     Returns per-leadtime quantiles, with hydrological (model) uncertainty
     combined in quadrature with the rainfall-driven spread in log space.

     A single deterministic line is the wrong output for a go/no-go decision.
     "60% chance it is in your band on Saturday morning" is the answer the user
     actually wants.
     ------------------------------------------------------------------------ */
  function ensemble(members, par, area, dtHours, state0, sigmaByLead) {
    var runs = [], i;
    for (i = 0; i < members.length; i++) {
      runs.push(simulate(members[i], par, area, dtHours, null, state0).q);
    }
    var n = runs[0].length;
    var out = { p10: new Float64Array(n), p25: new Float64Array(n), p50: new Float64Array(n),
                p75: new Float64Array(n), p90: new Float64Array(n), mean: new Float64Array(n) };
    var col = new Float64Array(runs.length);
    for (var t = 0; t < n; t++) {
      var s = 0;
      for (i = 0; i < runs.length; i++) { col[i] = runs[i][t]; s += col[i]; }
      var sorted = Array.prototype.slice.call(col).sort(function (x, y) { return x - y; });
      var med = quantile(sorted, 0.5);
      out.mean[t] = s / runs.length;
      out.p50[t] = med;

      /* rainfall spread in log space */
      var lo10 = quantile(sorted, 0.10), hi90 = quantile(sorted, 0.90);
      var sRain = med > 0 ? (Math.log(Math.max(hi90, 1e-6)) - Math.log(Math.max(lo10, 1e-6))) / 2.563 : 0;
      var sHyd  = sigmaByLead ? (sigmaByLead[Math.min(t, sigmaByLead.length - 1)] || 0) : 0;
      var sTot  = Math.sqrt(sRain * sRain + sHyd * sHyd);

      out.p10[t] = med * Math.exp(-1.2816 * sTot);
      out.p25[t] = med * Math.exp(-0.6745 * sTot);
      out.p75[t] = med * Math.exp( 0.6745 * sTot);
      out.p90[t] = med * Math.exp( 1.2816 * sTot);
    }
    out.runs = runs;
    return out;
  }

  function quantile(sorted, p) {
    if (!sorted.length) return NaN;
    var idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  /* Probability that flow sits inside [lo,hi] at each lead time, taken from
     the raw ensemble members plus the log-normal hydrological spread. */
  function probInBand(ens, lo, hi, sigmaByLead) {
    var n = ens.p50.length, out = new Float64Array(n);
    for (var t = 0; t < n; t++) {
      var med = ens.p50[t];
      if (!(med > 0)) { out[t] = 0; continue; }
      var sRain = (Math.log(Math.max(ens.p90[t], 1e-6)) - Math.log(Math.max(ens.p10[t], 1e-6))) / 2.563;
      var s = Math.max(sRain, 1e-3);
      var zlo = (Math.log(Math.max(lo, 1e-6)) - Math.log(med)) / s;
      var zhi = (Math.log(Math.max(hi, 1e-6)) - Math.log(med)) / s;
      out[t] = clamp(normCdf(zhi) - normCdf(zlo), 0, 1);
    }
    return out;
  }

  function normCdf(z) {
    /* Abramowitz & Stegun 7.1.26 */
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  /* --------------------------------------------------------------------------
     VERIFICATION

     Rolling-origin hindcast. Reports error by lead time against two baselines:

       persistence  — "the river will stay exactly where it is"
       climatology  — "the river will be at its seasonal median"

     A forecast that cannot beat persistence at 12 hours is not a forecast, and
     most published river-level ML models are never tested against it. Showing
     this in the app is the honest thing to do: the user can see how far ahead
     the model is actually worth trusting on their river.
     ------------------------------------------------------------------------ */
  function hindcast(forcing, obs, par, area, dtHours, opts) {
    opts = opts || {};
    var leadSteps = opts.leadSteps || Math.round(72 / dtHours);
    var every     = opts.every || Math.round(12 / dtHours);
    var spin      = opts.spin || Math.round(24 * 30 / dtHours);
    var n = obs.length;
    if (n < spin + leadSteps + every) return null;

    /* one continuous open-loop run supplies the states at each origin */
    var states = new Array(forcing.p.length);
    var base = simulate(forcing, par, area, dtHours, null, null, states);

    var sumM = new Float64Array(leadSteps), sumP = new Float64Array(leadSteps),
        sumC = new Float64Array(leadSteps), sumO = new Float64Array(leadSteps),
        cnt = new Float64Array(leadSteps), sumLog2 = new Float64Array(leadSteps);
    var climo = median(Array.prototype.slice.call(obs).filter(function (v) { return v > 0; }));
    var nOrigins = 0;

    for (var o = spin; o + leadSteps < n; o += every) {
      if (!(obs[o] > 0)) continue;
      var a = assimilate(states[o], base.q[o], obs[o], par, { weight: opts.daWeight == null ? 1 : opts.daWeight });
      var sub = sliceForcing(forcing, o + 1, o + 1 + leadSteps);
      var fc = simulate(sub, par, area, dtHours, null, a.state).q;
      nOrigins++;
      for (var L = 0; L < leadSteps; L++) {
        var ob = obs[o + 1 + L];
        if (!(ob > 0)) continue;
        sumM[L] += Math.abs(fc[L] - ob);
        sumO[L] += Math.abs(base.q[o + 1 + L] - ob);   /* same model, no assimilation */
        sumP[L] += Math.abs(obs[o] - ob);              /* persistence baseline        */
        sumC[L] += Math.abs(climo - ob);               /* climatology baseline        */
        var lr = Math.log(Math.max(fc[L], 1e-6)) - Math.log(ob);
        sumLog2[L] += lr * lr;
        cnt[L]++;
      }
    }

    var maeModel = [], maeOpen = [], maePers = [], maeClim = [], skill = [], sigma = [];
    for (var L2 = 0; L2 < leadSteps; L2++) {
      var c = cnt[L2] || 1;
      maeModel.push(sumM[L2] / c);
      maeOpen.push(sumO[L2] / c);
      maePers.push(sumP[L2] / c);
      maeClim.push(sumC[L2] / c);
      skill.push(sumP[L2] > 0 ? 1 - sumM[L2] / sumP[L2] : 0);
      sigma.push(Math.sqrt(sumLog2[L2] / c));
    }
    return { maeModel: maeModel, maeOpen: maeOpen, maePers: maePers, maeClim: maeClim,
             skill: skill, sigma: sigma, nOrigins: nOrigins, climo: climo };
  }

  function sliceForcing(f, a, b) {
    return { p: f.p.subarray(a, b), t: f.t.subarray(a, b), e: f.e.subarray(a, b) };
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (x, y) { return x - y; });
    return quantile(s, 0.5);
  }

  /* --------------------------------------------------------------------------
     FLOW STATISTICS — the flow duration curve

     Bands are derived from the river's own record rather than invented. "Q20"
     means flow exceeded 20% of the time; on almost every UK river the paddling
     window sits somewhere between roughly Q40 and Q3, and the user tunes from
     there. This is what makes the app work on a river nobody has written a
     guidebook entry for.
     ------------------------------------------------------------------------ */
  function flowStats(daily) {
    var v = daily.filter(function (x) { return x != null && isFinite(x) && x >= 0; })
                 .sort(function (a, b) { return a - b; });
    if (v.length < 30) return null;
    var ex = function (pct) { return quantile(v, 1 - pct / 100); };
    return {
      n: v.length,
      q95: ex(95), q80: ex(80), q60: ex(60), q50: ex(50),
      q40: ex(40), q30: ex(30), q20: ex(20), q10: ex(10), q5: ex(5), q1: ex(1),
      max: v[v.length - 1], min: v[0],
      mean: v.reduce(function (a, b) { return a + b; }, 0) / v.length
    };
  }

  /* Descriptive label for a flow, relative to this river's own history. */
  function describeFlow(q, st) {
    if (!st) return { label: '—', tone: 'na' };
    if (q < st.q80) return { label: 'Bones', tone: 'low',  note: 'Lower than 80% of days — scrapey.' };
    if (q < st.q60) return { label: 'Low',   tone: 'low',  note: 'Below the typical day.' };
    if (q < st.q30) return { label: 'Medium',tone: 'good', note: 'Around the normal running level.' };
    if (q < st.q10) return { label: 'High',  tone: 'good', note: 'Higher than 70% of days — pushy.' };
    if (q < st.q1)  return { label: 'Big',   tone: 'warn', note: 'Top 10% of flows. Serious water.' };
    return { label: 'Flood', tone: 'bad', note: 'Top 1% of flows on record here.' };
  }

  /* --------------------------------------------------------------------------
     RATING CURVE

     Where the gauge reports both level and flow we fit stage = c*(Q^m)+z by
     regression on the paired record. Modelling in flow space and converting at
     the end is materially better than predicting stage directly: mass balance
     is additive in flow but strongly nonlinear in stage, so a model asked to
     predict stage has to spend capacity learning the rating curve instead of
     learning the catchment.
     ------------------------------------------------------------------------ */
  function fitRating(levels, flows) {
    var xs = [], ys = [];
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] > 0 && flows[i] > 0) { xs.push(Math.log(flows[i])); ys.push(Math.log(levels[i])); }
    }
    if (xs.length < 30) return null;
    var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    var m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    var b = (sy - m * sx) / n;
    /* r2 for a quality flag */
    var my = sy / n, ssTot = 0, ssRes = 0;
    for (i = 0; i < n; i++) {
      var pred = m * xs[i] + b;
      ssRes += (ys[i] - pred) * (ys[i] - pred);
      ssTot += (ys[i] - my) * (ys[i] - my);
    }
    return { m: m, c: Math.exp(b), r2: ssTot ? 1 - ssRes / ssTot : 0, n: n };
  }
  function flowToLevel(q, rating) {
    if (!rating || !(q > 0)) return null;
    return rating.c * Math.pow(q, rating.m);
  }

  var API = {
    PARAMS: PARAMS, defaultPar: defaultPar, parToVec: parToVec, vecToPar: vecToPar,
    simulate: simulate, kge: kge, nse: nse, aggregate: aggregate, calibrate: calibrate,
    warmStart: warmStart, assimilate: assimilate,
    ensemble: ensemble, probInBand: probInBand,
    hindcast: hindcast, sliceForcing: sliceForcing,
    flowStats: flowStats, describeFlow: describeFlow,
    fitRating: fitRating, flowToLevel: flowToLevel,
    quantile: quantile, normCdf: normCdf, mmToCumecs: mmToCumecs
  };

  root.RiverModel = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
