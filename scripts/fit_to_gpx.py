#!/usr/bin/env python3
"""Convertit des fichiers .fit (ou .zip Garmin Connect "Exporter l'original") en .gpx.

Usage:
  .venv/bin/python scripts/fit_to_gpx.py --csv /chemin/Activities.csv fichier1.zip fichier2.fit ...

Écrit les .gpx directement dans data/gpx/, nommés par date + titre (si trouvé dans le CSV).
"""
import argparse
import csv
import re
import sys
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


def load_csv_titles(csv_path, tz):
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
            date_key = date_str.split(" ")[0]
            titles[date_key] = title
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
    points = []
    start_time = None
    for msg in fit.get_messages("session"):
        vals = {d.name: d.value for d in msg}
        if vals.get("start_time"):
            start_time = vals["start_time"]

    for msg in fit.get_messages("record"):
        vals = {d.name: d.value for d in msg}
        lat = vals.get("position_lat")
        lon = vals.get("position_long")
        if lat is None or lon is None:
            continue
        ele = vals.get("enhanced_altitude", vals.get("altitude"))
        t = vals.get("timestamp")
        points.append({
            "lat": lat * (180 / 2**31),
            "lon": lon * (180 / 2**31),
            "ele": ele,
            "time": t,
        })
        if start_time is None and t is not None:
            start_time = t

    return points, start_time


def write_gpx(points, out_path: Path, name: str):
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<gpx version="1.1" creator="fit_to_gpx.py" xmlns="http://www.topografix.com/GPX/1/1">',
        f"<trk><name>{name}</name><trkseg>",
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
    titles_by_date = load_csv_titles(args.csv, tz)

    GPX_DIR.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for raw in args.files:
            path = Path(raw)
            try:
                fit_path = extract_fit_path(path, tmpdir)
                points, start_time = parse_fit(fit_path)
            except Exception as e:
                print(f"! {path.name}: échec de conversion ({e})")
                continue

            if not points:
                print(f"! {path.name}: aucun point GPS trouvé, ignoré")
                continue

            if tz:
                local_start = start_time.replace(tzinfo=timezone.utc).astimezone(tz)
            else:
                local_start = start_time
            date_key = local_start.date().isoformat()
            title = titles_by_date.get(date_key, f"Randonnée du {date_key}")

            out_name = f"{date_key}-{slugify(title)}.gpx"
            write_gpx(points, GPX_DIR / out_name, title)
            print(f"- {path.name} -> data/gpx/{out_name} ({len(points)} points, {title})")


if __name__ == "__main__":
    main()
