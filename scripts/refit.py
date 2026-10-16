"""Refit the Central PM2.5 forecast model and rewrite lib/model.js.

Usage:
  python3 scripts/refit.py https://<your-site>/api/data      # use the live 14-day history
  python3 scripts/refit.py history.csv                        # or a CSV: ts,central,...

Ridge regression per horizon (1, 3, 6, 12, 24 h) on: bias, PM2.5 now, 1 h ago, 3 h ago,
24-h mean, and the daily cycle (sin/cos of the target hour). Each horizon is also scored on a held-out final 30 % against "no change" (see
the printed table and `backtest` in model.js). Meteorological adjustments in met_adjust are
hand-set priors, not fitted or validated, and are kept as they are.
"""
import json, sys, urllib.request, pathlib
import numpy as np, pandas as pd

src = sys.argv[1]
if src.startswith("http"):
    d = json.load(urllib.request.urlopen(src))
    s = pd.Series({pd.Timestamp(r["ts"]): r["pm25"]["central"] for r in d["readings"]})
else:
    df = pd.read_csv(src, parse_dates=["ts"])
    s = df.set_index("ts")["central"]
s = s.sort_index().astype(float)
s.index = pd.to_datetime(s.index, utc=True).tz_convert("Asia/Singapore")
s = s.asfreq("h")  # gaps become NaN and are skipped below

def ridge(X, Y, lam_v=5.0):
    lam = np.eye(X.shape[1]) * lam_v
    lam[0, 0] = 0
    return np.linalg.solve(X.T @ X + lam, X.T @ Y)

out, report, backtest = {}, {}, {}
for h in [1, 3, 6, 12, 24]:
    X, Y, P = [], [], []
    v = s.values
    for i in range(23, len(v) - h):
        win = v[i - 23 : i + 1]
        if np.isnan(win).any() or np.isnan(v[i + h]):
            continue
        hr = (s.index[i].hour + h) % 24
        X.append([1, v[i], v[i - 1], v[i - 3], win.mean(), np.sin(2 * np.pi * hr / 24), np.cos(2 * np.pi * hr / 24), np.sin(4 * np.pi * hr / 24), np.cos(4 * np.pi * hr / 24)])
        Y.append(v[i + h])
        P.append(v[i])  # persistence ("no change") baseline
    X, Y, P = np.array(X), np.array(Y), np.array(P)
    if len(Y) < 150:
        sys.exit(f"Only {len(Y)} usable rows for h={h}; need 150.")

    # Walk-forward backtest: train on the earlier 70 %, score on the later 30 %.
    # A gap of h rows keeps training targets from overlapping the test period.
    cut = int(len(Y) * 0.7)
    w_bt = ridge(X[: cut - h], Y[: cut - h])
    res = X[cut:] @ w_bt - Y[cut:]
    mae, pmae = float(np.mean(np.abs(res))), float(np.mean(np.abs(P[cut:] - Y[cut:])))
    backtest[str(h)] = {"mae": round(mae, 1), "persistence_mae": round(pmae, 1), "n_test": int(len(Y) - cut)}

    # Final model uses all data; the range width is the larger of in-sample and out-of-sample spread.
    w = ridge(X, Y)
    sd = max(float(np.std(X @ w - Y)), float(np.std(res)))
    out[str(h)] = {"w": [round(float(a), 5) for a in w], "sd": round(sd, 1)}
    report[h] = len(Y)
    print(f"h={h:>2}: out-of-sample MAE {mae:5.1f} vs persistence {pmae:5.1f} (n={len(Y) - cut})")

path = pathlib.Path(__file__).resolve().parent.parent / "lib" / "model.js"
old = json.loads(path.read_text().split("module.exports = ", 1)[1].rstrip().rstrip(";"))
old["horizons"] = out
first, last = s.dropna().index[0], s.dropna().index[-1]
old["trained_on"] = f"{first.day} {first:%b} – {last.day} {last:%b %Y} (Central hourly PM2.5)"
old["backtest"] = backtest
path.write_text("// Ridge-regression PM2.5 model for Central Singapore. Refit with scripts/refit.py.\nmodule.exports = " + json.dumps(old, indent=1) + ";\n")
print("Refit done:", report, "->", path)
