/* ============================================================================
   runs.js — named paddling sections with real calibration levels.

   Everything else in this app derives its "runnable" band from the gauge's own
   flow duration curve, because for most rivers nobody has written down what
   good water actually is. For Scotland somebody has: the Scottish Canoe
   Association's Where's the Water publishes 122 sections with the levels
   paddlers actually use — scrape, low, medium, high, very high, huge — under
   CC-BY-SA. That is knowledge no amount of statistics recovers.

   Two open catalogues are merged here:

     Where's the Water  (Scottish Canoe Association, CC-BY-SA)  122 sections
     Rainchasers        (Rob Tuley, MIT)                        114 sections

   The Rainchasers records carry Environment Agency RLOI gauge ids, resolved at
   build time to hydrology stations — so 53 English and Welsh runs sit on gauges
   with a flow record and a catchment area, which means the full forecast model
   runs on them and can answer "will it be in, on Saturday" against the levels
   paddlers actually use.

   Scottish runs show observed level only. SEPA publishes stage, not flow, and
   the model needs a different calibration path to work in stage.
   ========================================================================== */
(function (root) {
  'use strict';

  var D = RiverData;
  var CAT = ['scrape', 'low', 'medium', 'high', 'veryHigh', 'huge'];
  var CAT_LABEL = { tooLow: 'Too low', scrape: 'Scrape', low: 'Low', medium: 'Medium',
                    high: 'High', veryHigh: 'Very high', huge: 'Huge' };
  var CAT_TONE  = { tooLow: 'na', scrape: 'low', low: 'low', medium: 'good',
                    high: 'good', veryHigh: 'warn', huge: 'bad' };

  var state = { sections: null, levels: {}, fetchedAt: 0, meta: null };

  function load() {
    if (state.sections) return Promise.resolve(state.sections);
    return D.getJSON('sections.json', 20000).then(function (doc) {
      state.sections = doc.sections || [];
      state.meta = doc;
      return state.sections;
    });
  }

  /* Current level for every run: one bulk call per network, not one per river.
     SEPA takes many timeseries ids in a query; the EA publishes every latest
     level reading in the country as a single document. */
  function refresh(force) {
    if (!force && state.fetchedAt && Date.now() - state.fetchedAt < 5 * 60000) {
      return Promise.resolve(state.levels);
    }
    return load().then(function (secs) {
      var tsIds = [], eaRefs = {};
      secs.forEach(function (s) {
        var g = s.gauge || {};
        if (g.kind === 'sepa' && g.tsId && tsIds.indexOf(g.tsId) < 0) tsIds.push(g.tsId);
        if (g.kind === 'ea' && g.eaRef) eaRefs[g.eaRef] = 1;
      });
      return Promise.all([
        tsIds.length ? D.sepaLatest(tsIds).catch(function () { return {}; }) : {},
        Object.keys(eaRefs).length ? D.eaLatestLevels(eaRefs).catch(function () { return {}; }) : {}
      ]).then(function (r) {
        var out = {};
        Object.keys(r[0]).forEach(function (k) { out['sepa:' + k] = r[0][k]; });
        Object.keys(r[1]).forEach(function (k) { out['ea:' + k] = r[1][k]; });
        state.levels = out; state.fetchedAt = Date.now();
        return out;
      });
    });
  }

  function levelKey(s) {
    var g = s.gauge || {};
    return g.kind === 'sepa' ? 'sepa:' + g.tsId : 'ea:' + g.eaRef;
  }

  /* A run can be forecast when its gauge has both a flow record and a published
     catchment area — everything the rainfall-runoff model needs. */
  function forecastable(s) {
    var g = s.gauge || {};
    return !!(g.kind === 'ea' && g.guid && g.area && g.hasFlow);
  }

  /* Which band a reading falls in. Bands are ascending thresholds, so the
     category is the last one the level has reached. */
  function classify(level, bands) {
    if (!bands || !(level >= 0)) return null;
    var cat = 'tooLow';
    for (var i = 0; i < CAT.length; i++) {
      var k = CAT[i];
      if (bands[k] != null && level >= bands[k]) cat = k;
    }
    return { cat: cat, label: CAT_LABEL[cat], tone: CAT_TONE[cat] };
  }

  /* Position within the band ladder as 0..1, for the little level bar. */
  function fraction(level, bands) {
    if (!bands) return 0;
    var lo = bands.scrape != null ? bands.scrape : bands.low;
    var hi = bands.huge != null ? bands.huge : bands.veryHigh;
    if (!(lo > 0) || !(hi > lo)) return 0;
    return Math.max(0, Math.min(1, (level - lo) / (hi - lo)));
  }

  function withLevel(s) {
    var r = state.levels[levelKey(s)];
    var lvl = r ? r.v : null;
    return { s: s, level: lvl, at: r ? r.t : null,
             cls: lvl != null ? classify(lvl, s.bands) : null,
             canForecast: forecastable(s) };
  }

  function all() { return (state.sections || []).map(withLevel); }

  function bySlug(slug) {
    var f = (state.sections || []).filter(function (s) { return s.slug === slug; })[0];
    return f ? withLevel(f) : null;
  }

  /* Colour per band category — one place, so the list pill, the level bar and
     the map pins can never disagree about what "medium" looks like. */
  var CAT_COLOR = {
    tooLow: '#8c9aa5', scrape: '#b8912f', low: '#d0a03a',
    medium: '#12866b', high: '#0d7d8f', veryHigh: '#c07816', huge: '#c0442a'
  };
  function colorOf(cat) { return CAT_COLOR[cat] || '#8c9aa5'; }

  /* The band ladder as proportional segments, for the level bar. Returns the
     stops in 0..1 across the full scrape..huge span plus where the reading sits. */
  function ladder(level, bands) {
    if (!bands) return null;
    var keys = CAT.filter(function (k) { return bands[k] != null; });
    if (keys.length < 2) return null;
    var lo = bands[keys[0]], hi = bands[keys[keys.length - 1]];
    if (!(hi > lo)) return null;
    var span = hi - lo;
    var segs = [];
    for (var i = 0; i < keys.length - 1; i++) {
      segs.push({ cat: keys[i],
                  from: (bands[keys[i]] - lo) / span,
                  to: (bands[keys[i + 1]] - lo) / span,
                  color: colorOf(keys[i]) });
    }
    var pos = level != null ? (level - lo) / span : null;
    return { segs: segs, pos: pos == null ? null : Math.max(-0.04, Math.min(1.04, pos)),
             lo: lo, hi: hi, loKey: keys[0], hiKey: keys[keys.length - 1] };
  }

  root.RiverRuns = {
    load: load, refresh: refresh, all: all, bySlug: bySlug,
    classify: classify, fraction: fraction, forecastable: forecastable,
    colorOf: colorOf, ladder: ladder, CAT_COLOR: CAT_COLOR,
    CAT: CAT, CAT_LABEL: CAT_LABEL,
    meta: function () { return state.meta; },
    fetchedAt: function () { return state.fetchedAt; }
  };
})(typeof self !== 'undefined' ? self : this);
