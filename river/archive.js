/* ============================================================================
   archive.js — a record of every forecast this app has actually issued, and
   what the river went on to do.

   The hindcast in the trust panel replays the model over the recent past with
   the rainfall already known. That is a fair measure of the hydrology and a
   flattering measure of the forecast, because by two or three days out the
   rainfall forecast is the dominant error, and a hindcast never pays for it.

   The only way to measure the thing the user is actually shown is to write the
   forecast down when it is made and score it later against what happened. That
   is what this does. It stays on the device — there is no server — but it is a
   genuine closed loop, and it feeds one concrete correction back into the
   model: the ensemble spread.

   Ensembles are almost always under-dispersed. If the stated 80% band only
   contains the outcome 55% of the time, the app is overconfident, and no amount
   of hindcasting reveals it. Measured coverage does, and it can be corrected.
   ========================================================================== */
(function (root) {
  'use strict';

  var DB = 'riverwise', STORE = 'forecasts', VERSION = 1;
  var MAX_PER_GAUGE = 250;
  var HORIZON = 120;            /* leads we record, hours */

  function open() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('no IndexedDB'));
      var rq = indexedDB.open(DB, VERSION);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('guid', 'guid', { unique: false });
          os.createIndex('issued', 'issued', { unique: false });
        }
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var os = t.objectStore(STORE);
        var out = fn(os);
        t.oncomplete = function () { db.close(); resolve(out && out.value !== undefined ? out.value : out); };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }

  function all(guid) {
    return tx('readonly', function (os) {
      var box = {};
      var rq = guid ? os.index('guid').getAll(guid) : os.getAll();
      rq.onsuccess = function () { box.value = rq.result || []; };
      return box;
    }).catch(function () { return []; });
  }

  function put(rec) {
    return tx('readwrite', function (os) { os.put(rec); }).catch(function () {});
  }

  /* --------------------------------------------------------------------------
     RECORD

     One row per issued forecast: the median and the 10th/90th percentiles at
     each hourly lead, plus what the gauge read at the moment of issue (the
     persistence baseline this forecast has to beat) and which calibration
     produced it.

     Deliberately small — three arrays of 120 floats is a few KB, so a couple of
     hundred forecasts per gauge costs less than a single photo.
     ------------------------------------------------------------------------ */
  function record(r) {
    if (!r || !r.fc || !r.times || !r.times.length) return Promise.resolve(null);
    var n = Math.min(HORIZON, r.fc.p50.length);
    if (n < 12) return Promise.resolve(null);

    var issued = r.builtAt || Date.now();
    /* one forecast per gauge per hour is plenty; re-opening the app shouldn't
       stuff the archive with near-identical rows */
    var slot = Math.floor(issued / 3600000);
    var rec = {
      id: r.station.guid + '|' + slot,
      guid: r.station.guid,
      label: r.station.label,
      river: r.station.river,
      kind: r.kind,
      issued: issued,
      t0: r.times[0],
      obsAtIssue: r.obsNow ? r.obsNow.v : null,
      calAt: r.fit ? (r.fit.kge || 0) : 0,
      spreadFactor: r.spreadFactor || 1,
      p10: Array.prototype.slice.call(r.fc.p10.subarray(0, n)).map(round4),
      p50: Array.prototype.slice.call(r.fc.p50.subarray(0, n)).map(round4),
      p90: Array.prototype.slice.call(r.fc.p90.subarray(0, n)).map(round4),
      verified: null
    };
    return put(rec).then(function () { return prune(r.station.guid); }).then(function () { return rec; });
  }

  function round4(v) { return Math.round(v * 10000) / 10000; }

  function prune(guid) {
    return all(guid).then(function (rows) {
      if (rows.length <= MAX_PER_GAUGE) return;
      rows.sort(function (a, b) { return a.issued - b.issued; });
      var drop = rows.slice(0, rows.length - MAX_PER_GAUGE);
      return tx('readwrite', function (os) {
        drop.forEach(function (d) { os.delete(d.id); });
      });
    }).catch(function () {});
  }

  /* --------------------------------------------------------------------------
     VERIFY

     Score every stored forecast whose valid times now sit inside the observed
     window. `obsSeries` is the live 15-minute feed the app already fetches, so
     this costs nothing extra over the wire.
     ------------------------------------------------------------------------ */
  function verifyAll(guid, obsSeries) {
    if (!obsSeries || obsSeries.length < 20) return Promise.resolve(0);

    /* hourly lookup of what actually happened */
    var obs = {};
    for (var i = 0; i < obsSeries.length; i++) {
      var ms = parseTime(obsSeries[i].t);
      if (!isFinite(ms) || !(obsSeries[i].v > 0)) continue;
      obs[Math.round(ms / 3600000)] = obsSeries[i].v;
    }

    return all(guid).then(function (rows) {
      var writes = [], done = 0;
      rows.forEach(function (rec) {
        if (rec.verified) return;
        var base = parseTime(rec.t0);
        if (!isFinite(base)) return;
        var h0 = Math.round(base / 3600000);

        var mae = [], per = [], cov = [], ratio = [], cnt = 0;
        for (var L = 0; L < rec.p50.length; L++) {
          var v = obs[h0 + L];
          if (!(v > 0)) { mae.push(null); per.push(null); cov.push(null); ratio.push(null); continue; }
          cnt++;
          mae.push(Math.abs(rec.p50[L] - v));
          per.push(rec.obsAtIssue > 0 ? Math.abs(rec.obsAtIssue - v) : null);
          cov.push(v >= rec.p10[L] && v <= rec.p90[L] ? 1 : 0);
          /* how many forecast sigmas away the outcome landed, in log space —
             the quantity that tells us whether the spread is honest */
          var sig = (Math.log(Math.max(rec.p90[L], 1e-6)) - Math.log(Math.max(rec.p10[L], 1e-6))) / 2.563;
          ratio.push(sig > 1e-4 ? Math.abs(Math.log(v) - Math.log(Math.max(rec.p50[L], 1e-6))) / sig : null);
        }

        /* only score a forecast once it has fully matured, so partial rows
           don't drag the averages toward short leads */
        if (cnt < rec.p50.length * 0.6) return;
        rec.verified = { at: Date.now(), n: cnt, mae: mae, per: per, cov: cov, ratio: ratio };
        writes.push(rec); done++;
      });
      if (!writes.length) return 0;
      return tx('readwrite', function (os) {
        writes.forEach(function (w) { os.put(w); });
      }).then(function () { return done; });
    }).catch(function () { return 0; });
  }

  function parseTime(s) {
    if (!s) return NaN;
    return Date.parse(/[Zz]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  }

  /* --------------------------------------------------------------------------
     AGGREGATE

     Skill by lead time from real issued forecasts, and — the part that feeds
     back into the model — the spread factor.

     If the outcome routinely lands further from the median than the stated band
     allows, the band is too narrow. The 80% band should contain the outcome 80%
     of the time, which means the 80th percentile of |error| / sigma should be
     1.2816. Whatever it actually is, divided by 1.2816, is the factor the
     spread needs multiplying by.
     ------------------------------------------------------------------------ */
  function stats(guid) {
    return all(guid).then(function (rows) {
      var v = rows.filter(function (r) { return r.verified; });
      if (!v.length) return { n: 0, pending: rows.length };

      var L = 0;
      v.forEach(function (r) { L = Math.max(L, r.verified.mae.length); });

      var sm = new Array(L).fill(0), sp = new Array(L).fill(0),
          sc = new Array(L).fill(0), cn = new Array(L).fill(0);
      var ratios = [];

      v.forEach(function (r) {
        var q = r.verified;
        for (var i = 0; i < q.mae.length; i++) {
          if (q.mae[i] == null || q.per[i] == null) continue;
          sm[i] += q.mae[i]; sp[i] += q.per[i]; sc[i] += q.cov[i]; cn[i]++;
          if (q.ratio[i] != null && isFinite(q.ratio[i])) ratios.push(q.ratio[i]);
        }
      });

      var mae = [], per = [], cov = [], skill = [];
      for (var i = 0; i < L; i++) {
        var c = cn[i] || 1;
        mae.push(sm[i] / c); per.push(sp[i] / c); cov.push(sc[i] / c);
        skill.push(sp[i] > 0 ? 1 - sm[i] / sp[i] : 0);
      }

      var spreadFactor = 1, coverAll = null;
      if (ratios.length > 60) {
        ratios.sort(function (a, b) { return a - b; });
        var p80 = ratios[Math.floor(ratios.length * 0.8)];
        var raw = p80 / 1.2816;

        /* Shrink toward 1 by sample size. Ten forecasts is a hint, not a
           measurement, and a raw ratio from that few would swing the band
           around on noise. */
        raw = Math.pow(raw, v.length / (v.length + 25));

        /* Asymmetric, deliberately. Being told the band is too NARROW is the
           failure that gets someone on the water in the wrong conditions, so
           widening is allowed to go a long way. Being told it is too WIDE only
           ever produces false confidence, so tightening is capped hard — the
           app would rather look uncertain than be wrong quietly. */
        spreadFactor = raw >= 1 ? Math.min(3, raw) : Math.max(0.85, raw);

        var hit = 0;
        for (i = 0; i < L; i++) hit += cov[i] * (cn[i] || 0);
        var tot = cn.reduce(function (a, b) { return a + b; }, 0);
        coverAll = tot ? hit / tot : null;
      }

      return { n: v.length, pending: rows.length - v.length, counts: cn,
               mae: mae, per: per, cov: cov, skill: skill,
               spreadFactor: spreadFactor, coverage: coverAll,
               oldest: Math.min.apply(null, v.map(function (r) { return r.issued; })) };
    }).catch(function () { return { n: 0, pending: 0 }; });
  }

  function exportAll() {
    return all(null).then(function (rows) {
      return JSON.stringify({
        app: 'riverwise', exported: new Date().toISOString(),
        note: 'Issued forecasts and their verification. p10/p50/p90 are hourly from t0.',
        rows: rows
      });
    });
  }

  function clear() {
    return tx('readwrite', function (os) { os.clear(); }).catch(function () {});
  }

  root.RiverArchive = {
    record: record, verifyAll: verifyAll, stats: stats,
    exportAll: exportAll, clear: clear, all: all
  };
})(typeof self !== 'undefined' ? self : this);
