# Riverwise

Probabilistic river forecasts for UK gauges, fitted and run entirely in the browser.
No server, no API keys, no account. Live at `/river/`.

Built after looking at [RiverPredictor](https://www.riverpredictor.uk/), which forecasts
UK river levels with four machine-learning models (linear regression, SVR, MLP and an
LSTM) driven by point rainfall forecasts. This takes a different route to the same
problem, and the reasoning is below.

## Why not just fit an ML model

Nothing is wrong with an LSTM on a river. The problems are practical:

- **It cannot use the reading in front of you.** A network trained offline produces the
  same answer whether the gauge currently agrees with it or not. Operational flood
  forecasting has used state updating for forty years because it is the single biggest
  short-range win available. Measured here: anchoring on the live gauge cuts six-hour
  error on the Severn from 26.5 to 5.2 m³/s.
- **It has no state.** 30 mm of rain on baked August ground and on saturated January
  ground do completely different things. A model whose inputs are recent rainfall has to
  infer catchment wetness from the rainfall itself; a model with a soil-moisture store
  just carries it.
- **It cannot extrapolate.** The flood you care about is bigger than anything in the
  training record, which is exactly where a statistical fit has nothing to stand on. A
  store-and-routing model is bounded by mass balance instead.
- **One number is the wrong output.** "Probably 12 m³/s" is not a decision. "62% chance
  of being in your band on Saturday morning" is.
- **RMSE hides the failure.** A model that predicts something near the mean scores
  respectably on RMSE and never calls a rise. Scoring on KGE stops that.

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
