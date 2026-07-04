#!/usr/bin/env python3
"""Convertit des fichiers .fit (ou .zip Garmin Connect "Exporter l'original") en .gpx.

Usage:
  .venv/bin/python scripts/fit_to_gpx.py --csv /chemin/Activities.csv fichier1.zip fichier2.fit ...

Écrit les .gpx directement dans data/gpx/, nommés par date + titre (si trouvé dans le CSV).
Les stats de session (FC, calories, cadence, température, dénivelé, temps de mouvement)
sont intégrées dans un bloc <extensions> du GPX, lues ensuite par build_data.py.
"""
import argparse
import csv
import re
import zipfile
from datetime import timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import fitparse

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None

ROOT = Path(__file__).resolve().parent.parent
GPX_DIR = ROOT / "data" / "gpx"
MOVING_SPEED_THRESHOLD_MS = 0.3  # en dessous, on considère que la personne est à l'arrêt


def load_csv_titles(csv_path):
    """Retourne {date_locale (YYYY-MM-DD): titre} à partir de l'export CSV Garmin Connect."""
    titles = {}
    if not csv_path:
        return titles
    with open(csv_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            date_str = row.get("Date")
            title = row.get("Titre")
            if not date_str or not title:
                continue
            titles[date_str.split(" ")[0]] = title
    return titles


def extract_fit_path(path: Path, tmpdir: Path) -> Path:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            fit_names = [n for n in zf.namelist() if n.lower().endswith(".fit")]
            if not fit_names:
                raise ValueError(f"aucun .fit trouvé dans {path.name}")
            zf.extract(fit_names[0], tmpdir)
            return tmpdir / fit_names[0]
    return path


def parse_fit(fit_path: Path):
    fit = fitparse.FitFile(str(fit_path))

    session = {}
    for msg in fit.get_messages("session"):
        session = {d.name: d.value for d in msg}  # dernière session = résumé complet

    points = []
    start_time = None
    min_temp = max_temp = None
    moving_s = 0.0
    prev_t = None

    for msg in fit.get_messages("record"):
        vals = {d.name: d.value for d in msg}
        lat = vals.get("position_lat")
        lon = vals.get("position_long")
        t = vals.get("timestamp")

        temp = vals.get("temperature")
        if temp is not None:
            min_temp = temp if min_temp is None else min(min_temp, temp)
            max_temp = temp if max_temp is None else max(max_temp, temp)

        speed = vals.get("enhanced_speed", vals.get("speed"))
        if prev_t is not None and t is not None and speed is not None and speed > MOVING_SPEED_THRESHOLD_MS:
            moving_s += (t - prev_t).total_seconds()
        if t is not None:
            prev_t = t
            if start_time is None:
                start_time = t

        if lat is None or lon is None:
            continue
        ele = vals.get("enhanced_altitude", vals.get("altitude"))
        points.append({
            "lat": lat * (180 / 2**31),
            "lon": lon * (180 / 2**31),
            "ele": ele,
            "time": t,
        })

    if session.get("start_time"):
        start_time = session["start_time"]

    cadence_factor = 2  # Garmin stocke la cadence de rando/course sur une jambe, Connect l'affiche x2
    avg_cadence = session.get("avg_cadence")
    avg_cadence_frac = session.get("avg_fractional_cadence") or 0
    max_cadence = session.get("max_cadence")

    extensions = {
        "avgHr": session.get("avg_heart_rate"),
        "maxHr": session.get("max_heart_rate"),
        "calories": session.get("total_calories"),
        "avgCadence": round((avg_cadence + avg_cadence_frac) * cadence_factor) if avg_cadence is not None else None,
        "maxCadence": round(max_cadence * cadence_factor) if max_cadence is not None else None,
        "minTemp": min_temp,
        "maxTemp": max_temp,
        "trainingEffect": session.get("total_training_effect"),
        "ascentM": session.get("total_ascent"),
        "descentM": session.get("total_descent"),
        "movingTimeS": round(moving_s) if moving_s else None,
    }

    return points, start_time, extensions


def write_gpx(points, extensions, out_path: Path, name: str):
    ext_lines = "".join(f"<{k}>{v}</{k}>" for k, v in extensions.items() if v is not None)
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="fit_to_gpx.py" xmlns="http://www.topografix.com/GPX/1/1">',
        f"<trk><name>{name}</name><extensions>{ext_lines}</extensions><trkseg>",
    ]
    for p in points:
        ele_tag = f"<ele>{p['ele']:.1f}</ele>" if p["ele"] is not None else ""
        time_tag = f'<time>{p["time"].strftime("%Y-%m-%dT%H:%M:%SZ")}</time>' if p["time"] else ""
        lines.append(f'<trkpt lat="{p["lat"]:.7f}" lon="{p["lon"]:.7f}">{ele_tag}{time_tag}</trkpt>')
    lines.append("</trkseg></trk></gpx>")
    out_path.write_text("\n".join(lines))


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", help="fichiers .zip ou .fit exportés de Garmin Connect")
    parser.add_argument("--csv", help="chemin vers Activities.csv (pour retrouver le titre de l'activité)")
    args = parser.parse_args()

    tz = ZoneInfo("Europe/Paris") if ZoneInfo else None
    titles_by_date = load_csv_titles(args.csv)

    GPX_DIR.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for raw in args.files:
            path = Path(raw)
            try:
                fit_path = extract_fit_path(path, tmpdir)
                points, start_time, extensions = parse_fit(fit_path)
            except Exception as e:
                print(f"! {path.name}: échec de conversion ({e})")
                continue

            if not points:
                print(f"! {path.name}: aucun point GPS trouvé, ignoré")
                continue

            local_start = start_time.replace(tzinfo=timezone.utc).astimezone(tz) if tz else start_time
            date_key = local_start.date().isoformat()
            title = titles_by_date.get(date_key, f"Randonnée du {date_key}")

            out_name = f"{date_key}-{slugify(title)}.gpx"
            write_gpx(points, extensions, GPX_DIR / out_name, title)
            print(f"- {path.name} -> data/gpx/{out_name} ({len(points)} points, {title})")


if __name__ == "__main__":
    main()
