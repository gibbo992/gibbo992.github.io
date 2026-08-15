/* ============================================================================
   data.js — everything that touches the network.

   Sources (all open, keyless, CORS-enabled, usable straight from the phone):
     Environment Agency Hydrology API     long records, flow, catchment area
     Environment Agency Flood-Monitoring  live 15-minute readings
     Open-Meteo ERA5 archive API          archived hourly rainfall for calibration
     Open-Meteo forecast API              deterministic forecast + recent past
     Open-Meteo ensemble API              40-member rainfall ensemble

   Licensing: EA data is Open Government Licence v3; Open-Meteo is CC-BY-4.0.
   Both are attributed in the UI.
   ========================================================================== */
(function (root) {
  'use strict';

  var EA_HYD  = 'https://environment.data.gov.uk/hydrology';
  var EA_FLD  = 'https://environment.data.gov.uk/flood-monitoring';
  var OM_HIST = 'https://archive-api.open-meteo.com/v1/archive';
  var OM_FC   = 'https://api.open-meteo.com/v1/forecast';
  var OM_ENS  = 'https://ensemble-api.open-meteo.com/v1/ensemble';

  function getJSON(url, ms) {
    var ctrl = null, timer = null;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        timer = setTimeout(function () { ctrl.abort(); }, ms || 30000);
      }
    } catch (e) {}
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function iso(d) { return d.toISOString().slice(0, 10); }
  function daysAgo(n) { return iso(new Date(Date.now() - n * 86400000)); }

  /* --------------------------------------------------------------------------
     STATIONS
     ------------------------------------------------------------------------ */
  function searchStations(term) {
    return getJSON(EA_HYD + '/id/stations?search=' + encodeURIComponent(term) + '&_limit=40')
      .then(function (d) {
        return (d.items || [])
          .filter(function (s) { return s.lat != null && s.long != null && s.label; })
          .map(normStation)
          .filter(function (s) { return s.hasFlow || s.hasLevel; })
          .sort(function (a, b) {
            /* flow gauges with a catchment area first — they support the full model */
            return (b.hasFlow && b.area ? 2 : 0) + (b.area ? 1 : 0)
                 - (a.hasFlow && a.area ? 2 : 0) - (a.area ? 1 : 0);
          });
      });
  }

  function normStation(s) {
    var props = (s.observedProperty || []).map(function (o) { return o['@id'] || o; }).join(' ');
    return {
      guid: s.notation,
      label: s.label,
      river: s.riverName || '',
      lat: s.lat, lon: s.long,
      area: s.catchmentArea || null,
      nrfa: s.nrfaStationID || null,
      eaRef: s.stationReference || null,
      hasFlow: /waterFlow/.test(props),
      hasLevel: /waterLevel/.test(props),
      opened: s.dateOpened || null
    };
  }

  function stationByGuid(guid) {
    return getJSON(EA_HYD + '/id/stations/' + encodeURIComponent(guid))
      .then(function (d) { return normStation(d.items[0]); });
  }

  /* Nearest gauges to a coordinate — used by "gauges near me". The API has no
     radius search, so we pull the flood-monitoring station list (small, cached)
     and sort by distance, then resolve the hydrology record for the winners. */
  function nearbyStations(lat, lon, limit) {
    var u = EA_FLD + '/id/stations?parameter=level&lat=' + lat.toFixed(4)
          + '&long=' + lon.toFixed(4) + '&dist=30';
    return getJSON(u).then(function (d) {
      var items = (d.items || []).filter(function (s) { return s.lat && s.long; });
      items.forEach(function (s) { s._d = haversine(lat, lon, s.lat, s.long); });
      items.sort(function (a, b) { return a._d - b._d; });
      return items.slice(0, limit || 12).map(function (s) {
        return { eaRef: s.stationReference || s.notation, label: s.label,
                 river: s.riverName || '', lat: s.lat, lon: s.long, dist: s._d };
      });
    }).catch(function () { return []; });
  }

  function haversine(a1, o1, a2, o2) {
    var R = 6371, dLat = (a2 - a1) * Math.PI / 180, dLon = (o2 - o1) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(a1 * Math.PI / 180) * Math.cos(a2 * Math.PI / 180)
          * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  /* Resolve a flood-monitoring station reference to its hydrology record. */
  function hydroFromEaRef(ref) {
    return getJSON(EA_HYD + '/id/stations?stationReference=' + encodeURIComponent(ref) + '&_limit=5')
      .then(function (d) {
        if (!d.items || !d.items.length) throw new Error('no hydrology record');
        return normStation(d.items[0]);
      });
  }

  /* --------------------------------------------------------------------------
     OBSERVATIONS
     ------------------------------------------------------------------------ */

  /* Long daily record — the calibration target. Small payload (about 1100
     values for three years), so it is cheap to refresh and cache. */
  function dailySeries(guid, kind, from, to, stat) {
    var unit = kind === 'flow' ? 'm3s' : 'm';
    var id = guid + '-' + kind + '-' + (stat || 'm') + '-86400-' + unit + '-qualified';
    return getJSON(EA_HYD + '/id/measures/' + id + '/readings?mineq-date=' + from
                   + '&max-date=' + to + '&_limit=3000', 45000)
      .then(function (d) {
        return (d.items || [])
          .filter(function (x) { return typeof x.value === 'number' && x.value >= 0; })
          .map(function (x) { return { date: x.date, v: x.value }; })
          .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      });
  }

  /* Live 15-minute readings — what the forecast is anchored to. The
     flood-monitoring feed updates far more promptly than the hydrology one. */
  function liveReadings(eaRef, kind, sinceDays) {
    var since = new Date(Date.now() - (sinceDays || 7) * 86400000).toISOString();
    return getJSON(EA_FLD + '/id/stations/' + encodeURIComponent(eaRef) + '/measures')
      .then(function (d) {
        var measures = (d.items || []).filter(function (m) { return m.parameter === kind; });
        if (!measures.length) throw new Error('no ' + kind + ' measure');
        /* prefer plain stage over "downstream stage" / other qualifiers */
        measures.sort(function (a, b) {
          var sa = /downstage|groundwater/i.test(a['@id']) ? 1 : 0;
          var sb = /downstage|groundwater/i.test(b['@id']) ? 1 : 0;
          return sa - sb;
        });
        var mid = measures[0]['@id'].split('/').pop();
        return getJSON(EA_FLD + '/id/measures/' + mid + '/readings?since=' + since
                       + '&_sorted&_limit=3000', 30000)
          .then(function (r) {
            var pts = (r.items || [])
              .filter(function (x) { return typeof x.value === 'number'; })
              .map(function (x) { return { t: x.dateTime, v: x.value }; })
              .sort(function (a, b) { return a.t < b.t ? -1 : 1; });
            return { measureId: mid, unit: measures[0].unitName, points: pts };
          });
      });
  }

  /* --------------------------------------------------------------------------
     CATCHMENT-AVERAGE RAINFALL

     A river does not respond to rain at the gauge — it responds to rain over
     everything upstream. Sampling a disc whose area matches the published
     catchment area and averaging removes most of the point-sampling noise and
     stops a shower that missed the headwaters from reading as a catchment-wide
     soaking.

     But only above a certain size. Calibrating against two years of real EA
     flow showed this clearly:

       River Dart   248 km2   1 point NSE 0.872   5 points 0.846   9 points 0.837
       River Kent   209 km2   1 point NSE 0.800   5 points 0.802   9 points 0.804
       River Severn 4325 km2  1 point NSE 0.899   5 points 0.906   9 points 0.902
       River Trent  7486 km2  1 point NSE 0.899   5 points 0.911   9 points 0.899

     On a small catchment the weather grid cell is already about as large as
     the catchment, so spreading the disc wider only mixes in rain that fell
     somewhere else and dilutes the signal. Above roughly 600 km2 the averaging
     starts paying. So the sampling scales with catchment size rather than
     being applied uniformly — which is the sort of thing that only shows up if
     you actually measure it.
     ------------------------------------------------------------------------ */
  function pointCountFor(areaKm2) {
    return (areaKm2 || 0) < 600 ? 1 : 5;
  }

  function catchmentPoints(lat, lon, areaKm2, n) {
    if (n == null) n = pointCountFor(areaKm2);
    if (n <= 1) return [[lat, lon]];
    var r = Math.sqrt((areaKm2 || 100) / Math.PI);      /* km */
    var pts = [[lat, lon]];
    var rings = [[0.55 * r, 5], [0.95 * r, 7]];
    for (var g = 0; g < rings.length; g++) {
      var rad = rings[g][0], count = rings[g][1];
      for (var i = 0; i < count && pts.length < n; i++) {
        var th = (2 * Math.PI * i) / count + (g ? 0.4 : 0);
        var dLat = (rad * Math.cos(th)) / 111.32;
        var dLon = (rad * Math.sin(th)) / (111.32 * Math.cos(lat * Math.PI / 180));
        pts.push([lat + dLat, lon + dLon]);
      }
    }
    return pts.slice(0, n);
  }

  function coordParams(pts) {
    return 'latitude=' + pts.map(function (p) { return p[0].toFixed(4); }).join(',')
         + '&longitude=' + pts.map(function (p) { return p[1].toFixed(4); }).join(',');
  }

  /* Average hourly precipitation, plus daily temperature and reference ET,
     across the sampled points. Requesting temperature and ET daily rather than
     hourly cuts the payload roughly threefold with no meaningful loss — both
     vary slowly, unlike rainfall, where storm timing is the whole point. */
  function meanForcing(res, wantHours) {
    var arr = Array.isArray(res) ? res : [res];
    var time = arr[0].hourly.time;
    var n = wantHours || time.length;
    var p = new Float64Array(n);
    var k, i;
    for (k = 0; k < arr.length; k++) {
      var pp = arr[k].hourly.precipitation;
      for (i = 0; i < n; i++) p[i] += (pp[i] || 0) / arr.length;
    }
    var t = new Float64Array(n), e = new Float64Array(n);
    if (arr[0].daily) {
      var dTime = arr[0].daily.time, m = dTime.length;
      var dT = new Float64Array(m), dE = new Float64Array(m);
      for (k = 0; k < arr.length; k++) {
        for (i = 0; i < m; i++) {
          dT[i] += ((arr[k].daily.temperature_2m_mean || [])[i] || 5) / arr.length;
          dE[i] += ((arr[k].daily.et0_fao_evapotranspiration || [])[i] || 0) / arr.length;
        }
      }
      var idx = {};
      for (i = 0; i < m; i++) idx[dTime[i]] = i;
      for (i = 0; i < n; i++) {
        var di = idx[time[i].slice(0, 10)];
        t[i] = di == null ? 5 : dT[di];
        e[i] = di == null ? 0 : dE[di] / 24;
      }
    } else {
      for (i = 0; i < n; i++) { t[i] = 5; e[i] = 0.02; }
    }
    return { p: p, t: t, e: e, time: time.slice(0, n) };
  }

  /* Archived rainfall for the calibration window.

     Uses the ERA5 reanalysis archive rather than the archived-forecast API:
     same fields, but three years for a point comes back in seconds instead of
     over a minute, which is the difference between a usable and an unusable
     first run on a phone. The cost is that calibration forcing (reanalysis)
     and forecast forcing (operational model) are not the same product; the
     rainfall multiplier absorbs the mean offset and `reanchor` below trims
     what is left. */
  function historicForcing(lat, lon, area, from, to, nPts) {
    var pts = catchmentPoints(lat, lon, area, nPts);
    var u = OM_HIST + '?' + coordParams(pts)
      + '&start_date=' + from + '&end_date=' + to
      + '&hourly=precipitation&daily=temperature_2m_mean,et0_fao_evapotranspiration&timezone=UTC';
    return getJSON(u, 90000).then(function (r) {
      var f = meanForcing(r);
      f.nPts = (Array.isArray(r) ? r : [r]).length;
      return f;
    });
  }

  /* Recent past + deterministic forecast, in one continuous series. The past
     window is what the model is spun up on before the forecast starts, so the
     soil-moisture state at the forecast origin reflects the real recent
     weather rather than an assumed starting condition. */
  function forecastForcing(lat, lon, area, pastDays, forecastDays, nPts) {
    var pts = catchmentPoints(lat, lon, area, nPts);
    var u = OM_FC + '?' + coordParams(pts)
      + '&hourly=precipitation&daily=temperature_2m_mean,et0_fao_evapotranspiration'
      + '&past_days=' + (pastDays || 10) + '&forecast_days=' + (forecastDays || 7) + '&timezone=UTC';
    return getJSON(u, 45000).then(function (r) {
      var f = meanForcing(r);
      f.nPts = (Array.isArray(r) ? r : [r]).length;
      return f;
    });
  }

  /* --------------------------------------------------------------------------
     SPIN-UP + FORECAST, SPLICED

     The spin-up must be forced with the same rainfall product the model was
     calibrated on. Measured on the Dart over the same 55 days, the two
     Open-Meteo products disagreed badly:

       ERA5 reanalysis          45.7 mm
       forecast API, past days  11.1 mm   (0.24x)

     with several days the forecast product recorded as completely dry that the
     reanalysis had at 3-5 mm. A model calibrated against ERA5 — and carrying a
     1.6x rainfall multiplier fitted to it — then gets spun up on a quarter of
     the rain it expects, and by the end of a dry summer window it is showing a
     river four times lower than the one in front of you. That was the single
     largest error in this app, and it was invisible in the calibration score.

     So: reanalysis for the spin-up, forecast product only where there is no
     reanalysis yet (the last few days) and forward. The remaining overlap is
     used to estimate a bias factor for the forecast rainfall, which closes most
     of the rest of the gap; whatever survives that is what assimilation onto
     the live gauge reading is for.
     ------------------------------------------------------------------------ */
  function liveForcing(lat, lon, area, pastDays, forecastDays, nPts) {
    var histTo = iso(new Date(Date.now() - 6 * 86400000));
    var histFrom = iso(new Date(Date.now() - (pastDays || 60) * 86400000));
    return Promise.all([
      historicForcing(lat, lon, area, histFrom, histTo, nPts).catch(function () { return null; }),
      forecastForcing(lat, lon, area, Math.min(pastDays || 60, 14), forecastDays, nPts)
    ]).then(function (res) {
      var hist = res[0], fc = res[1];
      if (!hist || !hist.time.length) { fc.spliced = false; fc.bias = 1; return fc; }

      /* bias of the forecast product against the reanalysis, over their overlap */
      var map = {}, i;
      for (i = 0; i < hist.time.length; i++) map[hist.time[i]] = hist.p[i];
      var sumF = 0, sumH = 0;
      for (i = 0; i < fc.time.length; i++) {
        if (map[fc.time[i]] !== undefined) { sumF += fc.p[i]; sumH += map[fc.time[i]]; }
      }
      /* only trust the ratio if there was enough rain in the window to measure */
      var bias = (sumH > 15 && sumF > 1) ? Math.max(0.6, Math.min(2.5, sumH / sumF)) : 1;

      var cut = hist.time[hist.time.length - 1];
      var tail = [];
      for (i = 0; i < fc.time.length; i++) if (fc.time[i] > cut) tail.push(i);

      var n = hist.time.length + tail.length;
      var out = { p: new Float64Array(n), t: new Float64Array(n), e: new Float64Array(n), time: [] };
      for (i = 0; i < hist.time.length; i++) {
        out.p[i] = hist.p[i]; out.t[i] = hist.t[i]; out.e[i] = hist.e[i];
        out.time.push(hist.time[i]);
      }
      for (i = 0; i < tail.length; i++) {
        var j = tail[i], k = hist.time.length + i;
        out.p[k] = fc.p[j] * bias; out.t[k] = fc.t[j]; out.e[k] = fc.e[j];
        out.time.push(fc.time[j]);
      }
      out.nPts = hist.nPts; out.bias = bias; out.spliced = true;
      return out;
    });
  }

  /* --------------------------------------------------------------------------
     RAINFALL ENSEMBLE

     40 members of the forecast rainfall, propagated separately through the
     hydrological model. Nearly all of the uncertainty in a three-day river
     forecast is uncertainty about how much rain falls and where; running the
     members individually turns that directly into a spread of hydrographs,
     rather than a single line with a made-up error bar bolted on.
     ------------------------------------------------------------------------ */
  function ensembleRain(lat, lon, area, forecastDays, nPts) {
    /* The ensemble endpoint costs one request per point, so sample a coarser
       spread of the catchment than the deterministic call. */
    var pts = catchmentPoints(lat, lon, area, Math.min(3, nPts || pointCountFor(area)));
    var u = OM_ENS + '?' + coordParams(pts)
      + '&hourly=precipitation&models=icon_seamless&forecast_days=' + (forecastDays || 5)
      + '&timezone=UTC';
    return getJSON(u, 60000).then(function (r) {
      var arr = Array.isArray(r) ? r : [r];
      var h0 = arr[0].hourly;
      var keys = Object.keys(h0).filter(function (k) { return k.indexOf('precipitation') === 0; });
      var n = h0.time.length;
      var members = keys.map(function (key) {
        var p = new Float64Array(n);
        for (var k = 0; k < arr.length; k++) {
          var src = arr[k].hourly[key] || h0[key];
          for (var i = 0; i < n; i++) p[i] += (src[i] || 0) / arr.length;
        }
        return p;
      });
      return { time: h0.time, members: members };
    });
  }

  root.RiverData = {
    getJSON: getJSON, iso: iso, daysAgo: daysAgo, haversine: haversine,
    searchStations: searchStations, stationByGuid: stationByGuid,
    nearbyStations: nearbyStations, hydroFromEaRef: hydroFromEaRef,
    dailySeries: dailySeries, liveReadings: liveReadings,
    catchmentPoints: catchmentPoints, pointCountFor: pointCountFor,
    historicForcing: historicForcing,
    liveForcing: liveForcing, forecastForcing: forecastForcing,
    ensembleRain: ensembleRain
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.RiverData;
})(typeof self !== 'undefined' ? self : this);
