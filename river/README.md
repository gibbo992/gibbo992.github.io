# Riverwise

Probabilistic river forecasts for UK gauges, fitted and run entirely in the browser.
No server, no API keys, no account. Live at `/river/`.

Built after looking at [RiverPredictor](https://www.riverpredictor.uk/), which forecasts
UK river levels with four machine-learning models (linear regression, SVR, MLP and an
LSTM) driven by point rainfall forecasts. This takes a different route to the same
problem, and the reasoning is below.

## How this compares to an ML approach

**There is no head-to-head against RiverPredictor.** The two have never been run side by
side, and anyone claiming one is better than the other without that comparison is guessing.

It does publish accuracy, per river, which an earlier version of this file wrongly said it
did not — `api/accuracy.php` backs an Accuracy Report on every river page. For the Einig
over a 30-day window: mean absolute error 0.010 m at one hour rising to 0.060 m at six,
with a "correct" rate of 99.3% falling to 92.3%. Those are good numbers and more
transparency than most such apps offer.

Two things make them hard to compare against anything here. Its horizon is **1–6 hours**;
this app forecasts five days, which is a different product answering a different question.
And the figures carry no baseline, so there is no way to tell how much of that 0.06 m is
the model working and how much is the river simply not moving much in six hours — the
exact trap this app's own trust panel was in until persistence was added to it.

What can be measured is the *approach*. Below, a ridge regression on lagged catchment
rainfall — the class of thing RiverPredictor's linear/SVR/MLP models are, though weaker
than its LSTM — trained on the same data, the same 60/40 split, the same target, and
scored on the same held-out days. MAE at +1 day, m³/s, lower is better:

| | Dart, 248 km² | Kent, 209 km² | Severn, 4325 km² |
|---|---|---|---|
| persistence ("no change") | 5.82 | 5.57 | 10.24 |
| ridge, rainfall only | 7.68 | 4.56 | 28.28 |
| conceptual, no assimilation | 4.59 | 3.39 | 27.41 |
| ridge, rainfall + current level | 4.72 | 3.18 | 12.87 |
| **conceptual + assimilation** | **3.70** | **2.92** | **11.23** |

Read that honestly. The conceptual model wins on all three, but by 8–22%, not by a mile —
and a *linear regression* given the current gauge reading gets most of the way there. An
LSTM would likely do better than this baseline. The gap between the two approaches is much
smaller than the gap between using the live reading and not using it.

### Two things the earlier version of this file got wrong

- It claimed a machine-learned model "cannot use the reading in front of you". That is
  false: feed the current level in as a feature and it does. The rows above show exactly
  how much that is worth — on the Severn it takes the statistical model from 28.28 to
  12.87. What is fairly claimed is narrower: rescaling physical stores is a more
  self-consistent way of applying that information than an autoregressive input, and it
  keeps working when the gauge drops out.
- It claimed such a model "has no state". An LSTM's cell state is the entire point of the
  architecture, and published work finds it tracks catchment wetness closely. The honest
  distinction is that the state here is *interpretable and directly manipulable* — it can
  be warm-started from a known flow and rescaled onto a live reading — not that the other
  has none.

### What does hold up

- **Extrapolation.** The flood you care about is bigger than anything in the training
  record, which is where a statistical fit has least to stand on. A store-and-routing model
  is bounded by mass balance instead. Untested here — by definition it needs an event
  larger than the record.
- **One number is the wrong output.** "Probably 12 m³/s" is not a decision. "62% chance of
  being in your band on Saturday morning" is.
- **Scoring on KGE rather than RMSE.** RMSE lets a model sit near the mean, never call a
  rise, and still score respectably.

### Where this is plainly worse

- **Coverage.** England only. RiverPredictor covers Wales and Scotland too, which is most
  of the good whitewater.
- **Maturity.** RiverPredictor is a finished, maintained app with real users. This is days
  old and has been run against about five gauges by its author.

## What it does

Per gauge, in the browser, once:

1. Pulls two years of daily mean flow from the **Environment Agency Hydrology API** and
   two years of hourly rainfall from the **Open-Meteo ERA5 archive**.
2. Fits eight physical parameters by differential evolution in a Web Worker, maximising
   **KGE on square-root-transformed flow**. Takes a few seconds; cached for 45 days.
3. Fits a **rating curve** from paired daily level/flow so the answer can be given in
   metres as well as cumecs. The model itself works in flow, where mass balance is
   additive.

Then, on every open:

4. Spins the model up over the last 60 days of reanalysis rainfall.
5. **Assimilates** the live 15-minute EA reading by rescaling the model stores.
6. Pushes **40 rainfall ensemble members** through the model separately, giving a real
   spread rather than an error bar bolted onto a single line.
7. **Verifies itself** — a rolling-origin hindcast over the last fortnight at the gauge,
   scored against persistence and climatology, shown in the app.
8. **Writes the forecast down**, and scores it later against what the river did.

## Each river back-tests against itself

Before the first forecast is shown, every gauge is validated against its own record.
Two separate questions, easy to conflate:

**Has the calibration just memorised the record?** Split-sample: fit the parameters on the
first 60% of the record, score them on the later 40% the optimiser never saw. On the Dart
that is KGE 0.92 → 0.95 (no loss). On the Severn it is 0.94 → 0.73, which says plainly
that the in-sample number flatters itself, and the app says so.

**How well does it actually forecast?** A rolling-origin back-test across the whole
record — every day, assimilate what the gauge read, forecast five days, compare. 536–539
forecasts per gauge, spanning every flood and drought in two years rather than whatever
the last fortnight contained.

Results are broken down **by flow regime**, and that is the part that matters on the day:

| Gauge | low water | middling | high water |
|---|---|---|---|
| Dart at Austins Bridge | +21% | +44% | +47% |
| Severn at Bewdley | **−22%** | +22% | +18% |

Skill against "no change" at one day. The Severn's low-water number is negative: on a flat
summer recession the model is *worse* than assuming nothing changes. Averaged across all
conditions that gauge scores +16% at one day and the failure disappears. The app reads off
the regime the river is in right now and says which of those applies — on the Severn today
it prints "believe the gauge over the forecast."

### What the back-test changes

It is not just reporting. Three things feed back into the model:

- **Assimilation weight.** How hard to pull the model onto the live gauge reading is not a
  constant. The back-test sweeps it and each river picks its own: the Dart takes 100%, the
  Kent and Severn 75%. On the Severn, no anchoring at all scores −8% against persistence
  and the tuned weight scores +28%.
- **Fan width.** Per-lead error comes from two years of the river's own forecasts rather
  than a fortnight of whatever the weather was doing.
- **Which numbers to believe.** Where split-sample shows a large drop, the app points the
  user at the back-test rather than the calibration score.

The whole thing runs in the worker on data already downloaded — the back-test itself takes
about 50 ms, the split-sample fit about 2 s — and is cached for 45 days alongside the
calibration.

## The forecast archive

Every forecast the app issues is stored in IndexedDB — the 10th/50th/90th percentiles at
each hourly lead, the gauge reading at issue, and which calibration produced it. On each
subsequent open, any forecast whose valid times now sit inside the observed window is
scored against the live 15-minute record, which the app has already fetched, so
verification costs nothing over the wire.

This matters because it measures a different thing from the hindcast. A hindcast replays
the model with the rainfall already known; it never pays for the rain forecast being
wrong, which by day two or three is the dominant error. The archive is the only number in
the app that has paid for it, and it is always the worse of the two. Both are shown, and
labelled for what they are.

The loop closes on the **ensemble spread**. Ensembles are typically under-dispersed: the
stated 80% band contains the outcome rather less than 80% of the time, and no amount of
hindcasting reveals it. The archive measures the coverage directly and rescales the band
by the factor the record says it was short by.

That correction is deliberately asymmetric and shrunk toward 1 by sample size:

- Shrinkage `raw^(n/(n+25))` — ten forecasts is a hint, not a measurement.
- Widening allowed up to 3×; **tightening capped at 0.85×**. A band that turns out too
  narrow is the failure that puts someone on the water in the wrong conditions. A band
  that turns out too wide only ever costs a little false caution. The app would rather
  look uncertain than be wrong quietly.
- Nothing is applied until at least 12 forecasts have fully matured.

Records are capped at 250 per gauge, one per gauge per hour, a few KB each. **Export the
record** hands the whole archive over as JSON via the iOS share sheet, so it can come off
the phone and be analysed or pooled.

### What it does not yet do

The archive is per-device and only covers gauges you actually open, so it cannot feed a
cross-river recalibration — that needs the exported records pooled somewhere. The obvious
next uses of a pooled archive: trigger recalibration when bias drifts (a shifted rating,
a new abstraction), and A/B the model variants against real issued forecasts rather than
hindcasts.

Note the division of labour: the per-river back-test covers two years and every regime,
but replays with rainfall known. The live archive is small and slow to accumulate, but it
is the only thing that pays for the rain forecast being wrong. Neither substitutes for the
other, so the app shows both, labelled.

## Named runs (Scotland)

The rest of this app derives "runnable" from a gauge's own flow duration curve, because
for most rivers nobody has written down what good water actually is. For Scotland somebody
has. The Scottish Canoe Association's [Where's the Water](https://github.com/jriddell/wheres-the-water)
publishes 122 sections under CC-BY-SA 4.0 with the levels paddlers actually use — scrape,
low, medium, high, very high, huge — plus grades, put-in and take-out, guidebook links, and
free-text notes.

That is knowledge no amount of statistics recovers, and it is properly open. It is vendored
into `sections.json` (52 KB, 108 of 122 with usable bands) and shown against live SEPA
readings. SEPA's KiWIS endpoint is open, CORS-enabled, reaches back to 1997, and takes many
timeseries ids per request — the current level of all 122 runs costs one round trip, about
a second.

Two things worth noting about how the data is handled:

- The SCA notes contain author-written HTML. It is stripped to text at build time rather
  than injected into the page.
- 14 sections carry notes about trees, wires, weirs or sewage releases. Those matter more
  than the level does, so they are surfaced as a banner rather than a footnote.

**These are observed levels, not forecasts.** Scotland publishes stage, not flow, and the
model needs a different calibration path to predict it — see below.

### Why Scotland can't just use the existing model

The model works in flow, where mass balance is additive, and converts to metres through a
rating fitted from paired EA level/flow records. SEPA has no flow record to fit against, and
publishes no catchment areas. Forecasting Scottish runs needs a second calibration path:
absorb catchment area into a scale parameter and fit a monotone stage-discharge transform
jointly during calibration, scoring KGE on stage. That is the next piece of work.

## Model structure

```
        rain, temperature, potential ET  (catchment mean)
                      |
                 snow store           degree-day melt
                      |
                 soil store           saturation excess: qgen = P·(S/Smax)^beta
                   /     \                 with actual ET drawn against S
        saturation       percolation
          excess              |
             |          groundwater store   NONLINEAR: out ∝ S^bs
        quick store 1         |
             |                |
        quick store 2         |
              \              /
               ----> flow ---
```

Parameters: `pcorr` `smax` `beta` `perc` `k1` `k2` `ks` `bs`.

The groundwater store is nonlinear (Wittenberg). A linear store drains at a fixed
proportional rate and so empties completely through a dry summer, showing a river heading
for zero while the real one sits on baseflow into September.

## Measured skill

Rolling-origin hindcasts, 348 forecasts per gauge, November 2025 – February 2026,
verified against 15-minute observed flow. Skill = reduction in MAE against persistence.

| Gauge | 6 h | 12 h | 24 h | 48 h | 72 h |
|---|---|---|---|---|---|
| Dart at Austins Bridge, 248 km² | +27% | +40% | +52% | +57% | +54% |
| Kent at Sedgwick, 209 km² | +18% | +35% | +46% | +55% | +57% |
| Severn at Bewdley, 4325 km² | −2% | +2% | +10% | +26% | +37% |

Calibration fit (KGE on sqrt flow, 2 years daily): Dart 0.95, Kent 0.93, Severn 0.96,
Trent at Colwick 0.97.

Read honestly: on a big slow river, persistence is hard to beat in the first few hours.
And in a flat summer recession persistence wins outright — the app says so on the page
rather than hiding it.

## Things that were measured and rejected

- **Catchment-averaged rainfall, applied uniformly.** Averaging rainfall over a disc
  matching the catchment area helps large catchments and *hurts* small ones, because on a
  small catchment the weather grid cell is already the size of the catchment and widening
  the disc just mixes in rain that fell elsewhere. Dart NSE: 0.872 with one point, 0.846
  with five, 0.837 with nine. Severn: 0.899, 0.906, 0.902. The sampling now scales with
  catchment size, switching over at 600 km².
- **Elevation-weighted sampling** (weighting points above the gauge, since the catchment
  is uphill). Worth +0.003 NSE at best. Not shipped.

## Bugs worth recording

- The forecast API's past-days rainfall and the ERA5 archive disagree badly: 11.1 mm vs
  45.7 mm over the same 55 days on the Dart, with several days the forecast product had
  as bone dry that the reanalysis had at 3–5 mm. Calibrating on one and spinning up on
  the other left the model showing a quarter of the river's real flow. The spin-up now
  uses the reanalysis, and the forecast rainfall is bias-corrected against it over the
  overlap.
- Scaling a *nonlinear* store's storage by a ratio changes its *outflow* by that ratio
  raised to the store exponent. Assimilation was turning a 4× correction into a 64× one,
  and the Severn's 24-hour error was 49 m³/s on a river carrying 10. Assimilation now
  inverts the exponent per store.

## Limits

- Catchment approximated as a disc around the gauge, not delineated from terrain.
- Calibration rainfall (reanalysis) and forecast rainfall are different products; the
  mean offset is corrected, the storm-by-storm difference is not.
- Reservoir releases, abstraction and hydro operation are invisible to the model. On a
  regulated river it will be wrong in ways the error bars do not cover.
- Snowmelt uses a fixed degree-day factor rather than a fitted one.
- England only. The EA publishes the open flow record and catchment areas the model
  needs; NRW and SEPA have equivalents behind different APIs.

## Data

River data © Environment Agency, [Open Government Licence v3](http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
Weather from [Open-Meteo](https://open-meteo.com/) (CC-BY-4.0), ERA5 and ICON.

**A forecast is not a safety check.** Look at the river before you commit to it.
