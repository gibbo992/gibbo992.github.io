/* ============================================================================
   runs.js — named paddling sections with real calibration levels.

   Everything else in this app derives its "runnable" band from the gauge's own
   flow duration curve, because for most rivers nobody has written down what
   good water actually is. For Scotland somebody has: the Scottish Canoe
   Association's Where's the Water publishes 122 sections with the levels
   paddlers actually use — scrape, low, medium, high, very high, huge — under
   CC-BY-SA. That is knowledge no amount of statistics recovers.

   This screen shows observed level against those levels. It does NOT forecast
   them: Scotland publishes stage, not flow, and the model needs a different
   calibration path to work in stage. That is the next piece of work, and until
   it exists this screen says plainly that it is showing you a reading rather
   than a prediction.
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

  /* Current level for every run, in one round trip. */
  function refresh(force) {
    if (!force && state.fetchedAt && Date.now() - state.fetchedAt < 5 * 60000) {
      return Promise.resolve(state.levels);
    }
    return load().then(function (secs) {
      var ids = [];
      secs.forEach(function (s) { if (ids.indexOf(s.tsId) < 0) ids.push(s.tsId); });
      return D.sepaLatest(ids).then(function (m) {
        state.levels = m; state.fetchedAt = Date.now();
        return m;
      });
    });
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
    var r = state.levels[s.tsId];
    var lvl = r ? r.v : null;
    return { s: s, level: lvl, at: r ? r.t : null, cls: lvl != null ? classify(lvl, s.bands) : null };
  }

  function all() { return (state.sections || []).map(withLevel); }

  function bySlug(slug) {
    var f = (state.sections || []).filter(function (s) { return s.slug === slug; })[0];
    return f ? withLevel(f) : null;
  }

  root.RiverRuns = {
    load: load, refresh: refresh, all: all, bySlug: bySlug,
    classify: classify, fraction: fraction,
    CAT: CAT, CAT_LABEL: CAT_LABEL,
    meta: function () { return state.meta; },
    fetchedAt: function () { return state.fetchedAt; }
  };
})(typeof self !== 'undefined' ? self : this);
