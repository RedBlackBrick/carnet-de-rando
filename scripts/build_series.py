#!/usr/bin/env python3
"""Génère des séries temporelles par jour (altitude, vitesse, FC, cadence, température)
à partir des fichiers .fit natifs de la montre Garmin, pour tracer des courbes dans le
détail de chaque étape du site.

Usage :
    python3 scripts/build_series.py ~/Téléchargements/234*.zip
    python3 scripts/build_series.py data/fit/*.fit

Accepte des .fit ou des .zip (contenant un .fit, comme l'export « original » de Garmin
Connect). Les activités sont triées par heure de départ et associées aux jours 1..N,
dans le même ordre que build_data.py (une étape par jour).

Sortie : docs/data/series/day-1.json … day-N.json (sous-échantillonnées et lissées),
plus docs/data/series/index.json (récap des métriques disponibles par jour).
"""
import sys
import io
import json
import zipfile
import statistics
from pathlib import Path
from fitparse import FitFile

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "data" / "series"

TARGET_POINTS = 320        # nb de points après sous-échantillonnage
GAP_SECONDS = 20           # au-delà, on considère un trou d'enregistrement (pointillé)
SEMI = 180.0 / 2**31       # semicircles -> degrés


def load_fit(path: Path) -> FitFile:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as z:
            name = next((n for n in z.namelist() if n.lower().endswith(".fit")), None)
            if not name:
                raise ValueError(f"pas de .fit dans {path.name}")
            return FitFile(io.BytesIO(z.read(name)))
    return FitFile(str(path))


def extract_records(fit: FitFile):
    recs = []
    for m in fit.get_messages("record"):
        d = {f.name: f.value for f in m}
        ts = d.get("timestamp")
        if ts is None:
            continue
        ele = d.get("enhanced_altitude", d.get("altitude"))
        spd = d.get("enhanced_speed", d.get("speed"))
        cad = d.get("cadence")
        frac = d.get("fractional_cadence") or 0
        pl = d.get("position_lat")
        po = d.get("position_long")
        recs.append({
            "t": ts,
            "dist": d.get("distance"),
            "ele": ele,
            "lat": pl * SEMI if pl is not None else None,
            "lon": po * SEMI if po is not None else None,
            "speed": (spd * 3.6) if spd is not None else None,     # m/s -> km/h
            "hr": d.get("heart_rate"),
            # cadence de marche : (rpm d'un pied) x2 = pas/min
            "cad": ((cad + frac) * 2) if cad is not None else None,
            "temp": d.get("temperature"),
        })
    recs.sort(key=lambda r: r["t"])
    return recs


def session_start(fit: FitFile):
    for s in fit.get_messages("session"):
        for f in s:
            if f.name == "start_time":
                return f.value
    return None


def _haversine_m(a, b):
    import math
    R = 6371000.0
    la1, lo1 = math.radians(a[0]), math.radians(a[1])
    la2, lo2 = math.radians(b[0]), math.radians(b[1])
    dla, dlo = la2 - la1, lo2 - lo1
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def moving_pause(recs):
    """Sépare temps de marche effectif et temps de pause.

    Un instant est « en pause » si le déplacement NET sur une fenêtre de ~WIN secondes
    est inférieur à NET_MIN mètres : ça capte les arrêts francs *mais aussi* le
    « loitering » (la trace GPS qui tourne en rond au même endroit sans progresser).
    Les gros trous d'enregistrement (auto-pause de la montre) comptent comme pause.
    """
    WIN = 30       # secondes (demi-fenêtre avant / après)
    NET_MIN = 18   # mètres de déplacement net pour être considéré « en marche »
    n = len(recs)
    if n < 2:
        return 0, 0, 0

    # positions (avec remplissage avant/arrière des trous GPS)
    pos = [(r.get("lat"), r.get("lon")) for r in recs]
    last = None
    for i in range(n):
        if pos[i][0] is None and last is not None:
            pos[i] = last
        elif pos[i][0] is not None:
            last = pos[i]
    nxt = None
    for i in range(n - 1, -1, -1):
        if pos[i][0] is None and nxt is not None:
            pos[i] = nxt
        elif pos[i][0] is not None:
            nxt = pos[i]

    times = [r["t"] for r in recs]
    moving = pause = 0.0
    lo = hi = 0
    for i in range(n - 1):
        dt = (times[i + 1] - times[i]).total_seconds()
        if dt <= 0:
            continue
        if dt > 20:                       # arrêt franc / auto-pause
            pause += dt
            continue
        # fenêtre [t_i - WIN, t_i + WIN]
        while lo < i and (times[i] - times[lo]).total_seconds() > WIN:
            lo += 1
        if hi < i:
            hi = i
        while hi < n - 1 and (times[hi] - times[i]).total_seconds() < WIN:
            hi += 1
        net = _haversine_m(pos[lo], pos[hi]) if pos[lo][0] is not None and pos[hi][0] is not None else 0
        if net >= NET_MIN:
            moving += dt
        else:
            pause += dt
    elapsed = (times[-1] - times[0]).total_seconds()
    return round(moving), round(pause), round(elapsed)


def bucketize(recs):
    """Sous-échantillonne en TARGET_POINTS paquets (moyenne par canal) et repère les trous."""
    n = len(recs)
    if n == 0:
        return []
    t0 = recs[0]["t"]
    # distance cumulée : certains records ont dist=None -> on comble avec la dernière connue
    last_dist = 0.0
    for r in recs:
        if r["dist"] is None:
            r["dist"] = last_dist
        else:
            last_dist = r["dist"]

    # marque un record comme début-de-trou si l'écart temporel au précédent est grand
    for i in range(1, n):
        dt = (recs[i]["t"] - recs[i - 1]["t"]).total_seconds()
        recs[i]["_gap"] = dt > GAP_SECONDS
    recs[0]["_gap"] = False

    step = max(1, round(n / TARGET_POINTS))
    out = []
    for start in range(0, n, step):
        chunk = recs[start:start + step]
        mid = chunk[len(chunk) // 2]

        def avg(key):
            vals = [c[key] for c in chunk if c[key] is not None]
            return round(statistics.fmean(vals), 2) if vals else None

        out.append({
            "d": round(mid["dist"] / 1000, 3),
            "t": round((mid["t"] - t0).total_seconds()),
            "ele": avg("ele"),
            "speed": avg("speed"),
            "hr": avg("hr"),
            "cad": avg("cad"),
            "temp": avg("temp"),
            "gap": any(c.get("_gap") for c in chunk),
        })
    return out


METRIC_KEYS = ["ele", "speed", "hr", "cad", "temp"]


def has_signal(points, key):
    vals = [p[key] for p in points if p[key] is not None]
    if len(vals) < 5:
        return False
    # au moins un peu de variation et pas quasi tout à zéro
    nonzero = [v for v in vals if v not in (0, None)]
    return len(nonzero) >= max(5, 0.1 * len(vals))


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    paths = [Path(a) for a in args]
    activities = []
    for p in paths:
        if not p.exists():
            print(f"  ! introuvable : {p}")
            continue
        try:
            fit = load_fit(p)
            recs = extract_records(fit)
            if not recs:
                print(f"  ! aucun record : {p.name}")
                continue
            start = session_start(fit) or recs[0]["t"]
            activities.append({"path": p, "start": start, "recs": recs})
            print(f"  lu {p.name} : {len(recs)} points, départ {start}")
        except Exception as e:
            print(f"  ! erreur {p.name} : {e}")

    activities.sort(key=lambda a: a["start"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    index = []
    for i, act in enumerate(activities, start=1):
        points = bucketize(act["recs"])
        metrics = [k for k in METRIC_KEYS if has_signal(points, k)]
        # n'écrit que les canaux retenus (allège le JSON)
        slim = []
        for p in points:
            e = {"d": p["d"], "t": p["t"], "gap": p["gap"]}
            for k in metrics:
                e[k] = p[k]
            slim.append(e)
        moving_s, pause_s, elapsed_s = moving_pause(act["recs"])
        day = {
            "day": i,
            "date": act["start"].date().isoformat(),
            "metrics": metrics,
            "movingS": moving_s,
            "pauseS": pause_s,
            "elapsedS": elapsed_s,
            "points": slim,
        }
        out_path = OUT_DIR / f"day-{i}.json"
        out_path.write_text(json.dumps(day, ensure_ascii=False, separators=(",", ":")))
        index.append({"day": i, "date": day["date"], "metrics": metrics, "n": len(slim)})
        h = lambda s: f"{s//3600}h{(s % 3600)//60:02d}"
        print(f"  → day-{i}.json  ({day['date']}) marche {h(moving_s)} / pause {h(pause_s)} / total {h(elapsed_s)}  pts={len(slim)}")

    (OUT_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False))
    print(f"\nÉcrit {len(index)} série(s) dans {OUT_DIR}")


if __name__ == "__main__":
    main()
