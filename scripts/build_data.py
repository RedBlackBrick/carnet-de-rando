#!/usr/bin/env python3
"""Génère docs/data/manifest.json + copie/compresse les traces GPX et photos.

Usage: python3 scripts/build_data.py
Ré-exécutable à volonté : régénère tout à partir de data/ à chaque run.
"""
import bisect
import json
import math
import re
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import ExifTags, Image, ImageOps

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pillow_heif = None

try:
    import imageio_ffmpeg

    FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FFMPEG_BIN = None

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DOCS = ROOT / "docs"
GEOCODE_CACHE_PATH = Path(__file__).resolve().parent / ".geocode_cache.json"

FULL_MAX_SIDE = 1600
FULL_QUALITY = 82
THUMB_MAX_SIDE = 400
THUMB_QUALITY = 78

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".heic", ".heif"}
VIDEO_EXTENSIONS = {".mp4", ".mov"}
TIME_MATCH_TOLERANCE_S = 3 * 3600  # tolérance pour rattacher une photo sans GPS à la trace GPX la plus proche dans le temps

VIDEO_MAX_HEIGHT = 720
VIDEO_CRF = 28
VIDEO_POSTER_MAX_SIDE = 400

DAY_COLORS = [
    "#2f6f4f", "#b5651d", "#3a6ea5", "#a13d3d",
    "#6b5b95", "#4c7a3f", "#c1875a", "#2b6f77",
]


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# GPX parsing
# ---------------------------------------------------------------------------

def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def elevation_gain_loss(points, smoothing_window=31):
    """Dénivelé +/- à partir d'une série d'altitudes lissée (moyenne glissante).

    Les traces montre échantillonnent l'altitude toutes les quelques secondes ; sommer les
    deltas bruts entre points consécutifs surestime fortement le dénivelé réel (le bruit du
    capteur barométrique s'accumule sur des milliers de points). Un lissage sur ~31 points
    (~1-2 min à la fréquence d'échantillonnage habituelle d'une montre Garmin) reproduit de
    très près le dénivelé calculé par Garmin Connect (écart <5% mesuré sur des traces réelles).
    """
    eles = [p["ele"] for p in points]
    n = len(eles)
    half = smoothing_window // 2
    smoothed = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        window_vals = [e for e in eles[lo:hi] if e is not None]
        smoothed.append(sum(window_vals) / len(window_vals) if window_vals else None)

    gain_m = 0.0
    loss_m = 0.0
    for a, b in zip(smoothed, smoothed[1:]):
        if a is None or b is None:
            continue
        delta = b - a
        if delta > 0:
            gain_m += delta
        else:
            loss_m += -delta
    return gain_m, loss_m


def parse_gpx_time(text):
    if not text:
        return None
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def parse_extensions(trk_el, ns):
    """Lit le bloc <extensions> écrit par fit_to_gpx.py (FC, calories, cadence, dénivelé exact...)."""
    ext_el = trk_el.find("g:extensions", ns)
    if ext_el is None:
        return {}
    result = {}
    for child in ext_el:
        tag = child.tag.split("}")[-1]
        if child.text is None:
            continue
        try:
            value = float(child.text)
            if value.is_integer():
                value = int(value)
        except ValueError:
            value = child.text
        result[tag] = value
    return result


def parse_gpx(path: Path):
    tree = ET.parse(path)
    root = tree.getroot()
    ns_match = re.match(r"\{(.+)\}", root.tag)
    ns = {"g": ns_match.group(1)} if ns_match else {"g": ""}

    points = []
    for trkpt in root.findall(".//g:trkpt", ns):
        lat = float(trkpt.get("lat"))
        lon = float(trkpt.get("lon"))
        ele_el = trkpt.find("g:ele", ns)
        ele = float(ele_el.text) if ele_el is not None and ele_el.text else None
        time_el = trkpt.find("g:time", ns)
        t = parse_gpx_time(time_el.text) if time_el is not None else None
        points.append({"lat": lat, "lon": lon, "ele": ele, "time": t})

    if not points:
        return None

    distance_m = 0.0
    for a, b in zip(points, points[1:]):
        distance_m += haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])

    trk_el = root.find(".//g:trk", ns)
    extensions = parse_extensions(trk_el, ns) if trk_el is not None else {}
    if "ascentM" in extensions and "descentM" in extensions:
        gain_m, loss_m = extensions["ascentM"], extensions["descentM"]
    else:
        gain_m, loss_m = elevation_gain_loss(points)

    times = [p["time"] for p in points if p["time"] is not None]
    start_time = min(times) if times else None
    end_time = max(times) if times else None
    duration_s = (end_time - start_time).total_seconds() if start_time and end_time else None

    lats = [p["lat"] for p in points]
    lons = [p["lon"] for p in points]

    return {
        "points": points,
        "distance_km": round(distance_m / 1000, 2),
        "elevation_gain_m": round(gain_m),
        "elevation_loss_m": round(loss_m),
        "duration_s": duration_s,
        "start_time": start_time,
        "end_time": end_time,
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "extensions": extensions,
    }


EXTENSION_FIELDS = [
    "avgHr", "maxHr", "calories", "avgCadence", "maxCadence",
    "minTemp", "maxTemp", "trainingEffect", "movingTimeS",
]


def build_tracks(trip_days_by_date):
    gpx_files = sorted((DATA / "gpx").glob("*.gpx"))
    tracks = []
    all_time_points = []  # (timestamp, lat, lon) across every track, for photo fallback matching
    track_endpoints = {}  # id -> {"start": {...}, "end": {...}} pour résoudre les liaisons

    out_gpx_dir = DOCS / "data" / "gpx"
    out_gpx_dir.mkdir(parents=True, exist_ok=True)
    for existing in out_gpx_dir.glob("*.gpx"):
        existing.unlink()

    parsed = []
    for gpx_path in gpx_files:
        info = parse_gpx(gpx_path)
        if info is None:
            log(f"  ! {gpx_path.name}: aucun point trouvé, ignoré")
            continue
        parsed.append((gpx_path, info))

    parsed.sort(key=lambda pair: pair[1]["start_time"] or datetime.min.replace(tzinfo=timezone.utc))

    for idx, (gpx_path, info) in enumerate(parsed):
        track_id = f"day-{idx + 1}"
        dest_name = f"{track_id}.gpx"
        (out_gpx_dir / dest_name).write_bytes(gpx_path.read_bytes())

        date_str = info["start_time"].date().isoformat() if info["start_time"] else None
        day_meta = trip_days_by_date.get(date_str, {})
        label = day_meta.get("title") or f"Jour {idx + 1}"

        for p in info["points"]:
            if p["time"] is not None:
                all_time_points.append((p["time"], p["lat"], p["lon"]))

        track = {
            "id": track_id,
            "file": f"data/gpx/{dest_name}",
            "label": label,
            "description": day_meta.get("description", ""),
            "date": date_str,
            "color": DAY_COLORS[idx % len(DAY_COLORS)],
            "distanceKm": info["distance_km"],
            "elevationGainM": info["elevation_gain_m"],
            "elevationLossM": info["elevation_loss_m"],
            "durationS": info["duration_s"],
            "startTime": info["start_time"].isoformat() if info["start_time"] else None,
            "endTime": info["end_time"].isoformat() if info["end_time"] else None,
            "bounds": info["bounds"],
        }
        for field in EXTENSION_FIELDS:
            if field in info["extensions"]:
                track[field] = info["extensions"][field]
        tracks.append(track)

        first_pt, last_pt = info["points"][0], info["points"][-1]
        track_endpoints[track_id] = {
            "start": {"lat": first_pt["lat"], "lon": first_pt["lon"], "label": label},
            "end": {"lat": last_pt["lat"], "lon": last_pt["lon"], "label": label},
        }

        log(f"  - {gpx_path.name} -> {dest_name}: {info['distance_km']} km, +{info['elevation_gain_m']}m")

    all_time_points.sort(key=lambda t: t[0])
    return tracks, all_time_points, track_endpoints


# ---------------------------------------------------------------------------
# Photos
# ---------------------------------------------------------------------------

def _to_deg(value_tuple):
    d, m, s = (float(v) for v in value_tuple)
    return d + m / 60 + s / 3600


def _compass_point(degrees):
    points = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
    return points[round(degrees / 45) % 8]


def _fmt_num(value):
    return f"{round(float(value), 1):g}"


def extract_camera_settings(exif):
    """Altitude/direction GPS + réglages photo (appareil, ouverture, vitesse, ISO, focale)."""
    settings = {}

    gps_ifd = exif.get_ifd(0x8825)
    if gps_ifd:
        try:
            alt = float(gps_ifd[6])
            if gps_ifd.get(5) == 1:
                alt = -alt
            settings["altitudeM"] = round(alt)
        except (KeyError, TypeError, ValueError):
            pass
        try:
            direction = float(gps_ifd[17])
            settings["direction"] = round(direction)
            settings["directionCompass"] = _compass_point(direction)
        except (KeyError, TypeError, ValueError):
            pass

    make = exif.get(271)
    model = exif.get(272)
    if model:
        model = model.strip()
        make = (make or "").strip()
        settings["camera"] = model if not make or model.lower().startswith(make.lower()) else f"{make} {model}"

    try:
        exif_ifd = exif.get_ifd(0x8769)
    except Exception:
        exif_ifd = {}
    if exif_ifd:
        try:
            settings["aperture"] = f"f/{_fmt_num(exif_ifd[33437])}"
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            pass
        try:
            exposure = float(exif_ifd[33434])
            settings["shutterSpeed"] = f"1/{round(1 / exposure)}s" if exposure < 1 else f"{_fmt_num(exposure)}s"
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            pass
        iso = exif_ifd.get(34855)
        if iso:
            settings["iso"] = int(iso[0]) if isinstance(iso, (tuple, list)) else int(iso)
        # Préfère l'équivalent 35 mm (plus parlant) à la focale réelle du capteur (ex. 5.4mm sur mobile).
        focal_35mm = exif_ifd.get(41989)
        try:
            if focal_35mm:
                settings["focalLength"] = f"{int(focal_35mm)}mm"
            else:
                settings["focalLength"] = f"{_fmt_num(exif_ifd[37386])}mm"
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            pass

    return settings


def extract_exif(img: Image.Image):
    exif = img.getexif()
    if not exif:
        return None, None, {}

    gps_ifd = exif.get_ifd(0x8825)
    lat = lon = None
    if gps_ifd:
        try:
            lat = _to_deg(gps_ifd[2])
            if gps_ifd.get(1) == "S":
                lat = -lat
            lon = _to_deg(gps_ifd[4])
            if gps_ifd.get(3) == "W":
                lon = -lon
        except (KeyError, TypeError, ZeroDivisionError):
            lat = lon = None

    dt = None
    try:
        exif_ifd = exif.get_ifd(0x8769)
        raw_dt = exif_ifd.get(36867) or exif.get(306)
    except Exception:
        raw_dt = exif.get(306)
    if raw_dt:
        try:
            dt = datetime.strptime(raw_dt, "%Y:%m:%d %H:%M:%S")
        except ValueError:
            dt = None

    has_gps = lat is not None and lon is not None and (lat, lon) != (0.0, 0.0)
    settings = extract_camera_settings(exif)
    return (lat, lon) if has_gps else None, dt, settings


def find_nearest_time_point(dt_utc, time_points):
    if not time_points or dt_utc is None:
        return None
    times = [t[0] for t in time_points]
    idx = bisect.bisect_left(times, dt_utc)
    candidates = [i for i in (idx - 1, idx) if 0 <= i < len(times)]
    if not candidates:
        return None
    best = min(candidates, key=lambda i: abs((times[i] - dt_utc).total_seconds()))
    if abs((times[best] - dt_utc).total_seconds()) > TIME_MATCH_TOLERANCE_S:
        return None
    return time_points[best][1], time_points[best][2]


def build_photos(time_points, trip_timezone, captions):
    photo_paths = sorted(
        p for p in (DATA / "photos").rglob("*")
        if p.suffix.lower() in PHOTO_EXTENSIONS and p.is_file()
    )

    full_dir = DOCS / "photos" / "full"
    thumb_dir = DOCS / "photos" / "thumb"
    for d in (full_dir, thumb_dir):
        d.mkdir(parents=True, exist_ok=True)
        for existing in d.glob("*"):
            existing.unlink()

    tz = ZoneInfo(trip_timezone) if ZoneInfo and trip_timezone else None

    entries = []
    skipped = []
    for i, path in enumerate(photo_paths, start=1):
        try:
            img = Image.open(path)
        except Exception as e:
            skipped.append((path.name, f"lecture impossible ({e})"))
            continue

        gps, dt_naive, settings = extract_exif(img)
        source = None
        lat = lon = None

        if gps:
            lat, lon = gps
            source = "exif"
        elif dt_naive is not None:
            dt_local = dt_naive.replace(tzinfo=tz) if tz else dt_naive.replace(tzinfo=timezone.utc)
            dt_utc = dt_local.astimezone(timezone.utc)
            match = find_nearest_time_point(dt_utc, time_points)
            if match:
                lat, lon = match
                source = "interpolated"

        if lat is None:
            skipped.append((path.name, "pas de position GPS ni de trace GPX proche dans le temps"))
            continue

        slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", path.stem).strip("-").lower() or "photo"
        out_name = f"{i:04d}-{slug}.jpg"

        try:
            oriented = ImageOps.exif_transpose(img).convert("RGB")
        except Exception as e:
            skipped.append((path.name, f"traitement impossible ({e})"))
            continue

        full_img = oriented.copy()
        full_img.thumbnail((FULL_MAX_SIDE, FULL_MAX_SIDE), Image.LANCZOS)
        full_img.save(full_dir / out_name, "JPEG", quality=FULL_QUALITY)

        thumb_img = oriented.copy()
        thumb_img.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE), Image.LANCZOS)
        thumb_img.save(thumb_dir / out_name, "JPEG", quality=THUMB_QUALITY)

        date_iso = None
        if dt_naive is not None:
            dt_local = dt_naive.replace(tzinfo=tz) if tz else dt_naive.replace(tzinfo=timezone.utc)
            date_iso = dt_local.isoformat()

        entry = {
            "file": f"photos/full/{out_name}",
            "thumb": f"photos/thumb/{out_name}",
            "lat": lat,
            "lon": lon,
            "date": date_iso,
            "caption": captions.get(path.name, ""),
            "positionSource": source,
        }
        entry.update(settings)
        entries.append(entry)

    entries.sort(key=lambda e: e["date"] or "")

    log(f"  {len(entries)} photo(s) géolocalisée(s), {len(skipped)} ignorée(s)")
    for name, reason in skipped:
        log(f"  ! {name}: {reason}")

    return entries


# ---------------------------------------------------------------------------
# Vidéos
# ---------------------------------------------------------------------------

def probe_video(path: Path):
    """Lit creation_time / position GPS / durée via la sortie -i de ffmpeg (pas besoin de ffprobe)."""
    result = subprocess.run([FFMPEG_BIN, "-i", str(path)], capture_output=True, text=True)
    stderr = result.stderr

    lat = lon = None
    loc_match = re.search(r"location\s*:\s*([+-]\d+\.\d+)([+-]\d+\.\d+)", stderr)
    if loc_match:
        lat, lon = float(loc_match.group(1)), float(loc_match.group(2))

    dt = None
    time_match = re.search(r"creation_time\s*:\s*(\S+)", stderr)
    if time_match:
        try:
            dt = datetime.fromisoformat(time_match.group(1).replace("Z", "+00:00"))
        except ValueError:
            dt = None

    duration_s = None
    dur_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+)\.(\d+)", stderr)
    if dur_match:
        h, m, s, cs = (int(x) for x in dur_match.groups())
        duration_s = h * 3600 + m * 60 + s + cs / 100

    return lat, lon, dt, duration_s


def transcode_video(src: Path, out_path: Path):
    # scale=-2:'min(H,ih)' (plutôt que -2:H avec force_original_aspect_ratio) : évite une largeur
    # impaire sur les vidéos verticales (rotation via displaymatrix, cf. vidéos Samsung portrait).
    subprocess.run([
        FFMPEG_BIN, "-y", "-i", str(src),
        "-vf", f"scale=-2:'min({VIDEO_MAX_HEIGHT},ih)'",
        "-c:v", "libx264", "-crf", str(VIDEO_CRF), "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        str(out_path),
    ], capture_output=True, check=True)


def extract_poster(src: Path, out_path: Path, at_second: float):
    subprocess.run([
        FFMPEG_BIN, "-y", "-ss", str(at_second), "-i", str(src),
        "-frames:v", "1", "-vf", f"scale=-2:'min({VIDEO_POSTER_MAX_SIDE},ih)'",
        str(out_path),
    ], capture_output=True, check=True)


def build_videos(time_points, trip_timezone, captions):
    video_paths = sorted(
        p for p in (DATA / "videos").rglob("*")
        if p.suffix.lower() in VIDEO_EXTENSIONS and p.is_file()
    )

    out_dir = DOCS / "videos"
    poster_dir = out_dir / "thumb"
    for d in (out_dir, poster_dir):
        d.mkdir(parents=True, exist_ok=True)
    for existing in out_dir.glob("*.mp4"):
        existing.unlink()
    for existing in poster_dir.glob("*"):
        existing.unlink()

    if video_paths and FFMPEG_BIN is None:
        log("  ! ffmpeg (imageio-ffmpeg) non installé, vidéos ignorées : .venv/bin/pip install -r scripts/requirements.txt")
        return []

    tz = ZoneInfo(trip_timezone) if ZoneInfo and trip_timezone else None

    entries = []
    skipped = []
    for i, path in enumerate(video_paths, start=1):
        try:
            lat, lon, dt_utc, duration_s = probe_video(path)
        except Exception as e:
            skipped.append((path.name, f"lecture impossible ({e})"))
            continue

        source = None
        if lat is not None and lon is not None:
            source = "gps"
        elif dt_utc is not None:
            match = find_nearest_time_point(dt_utc, time_points)
            if match:
                lat, lon = match
                source = "interpolated"

        if lat is None:
            skipped.append((path.name, "pas de position GPS ni de trace GPX proche dans le temps"))
            continue

        slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", path.stem).strip("-").lower() or "video"
        out_name = f"{i:04d}-{slug}.mp4"
        poster_name = f"{i:04d}-{slug}.jpg"

        try:
            transcode_video(path, out_dir / out_name)
            extract_poster(path, poster_dir / poster_name, at_second=min(1.0, (duration_s or 2) / 2))
        except subprocess.CalledProcessError as e:
            skipped.append((path.name, f"transcodage échoué ({e})"))
            continue

        date_iso = None
        if dt_utc is not None:
            dt_local = dt_utc.astimezone(tz) if tz else dt_utc
            date_iso = dt_local.isoformat()

        entries.append({
            "file": f"videos/{out_name}",
            "poster": f"videos/thumb/{poster_name}",
            "lat": lat,
            "lon": lon,
            "date": date_iso,
            "durationS": duration_s,
            "caption": captions.get(path.name, ""),
            "positionSource": source,
        })
        log(f"  - {path.name} -> {out_name} ({source})")

    entries.sort(key=lambda e: e["date"] or "")

    log(f"  {len(entries)} vidéo(s) géolocalisée(s), {len(skipped)} ignorée(s)")
    for name, reason in skipped:
        log(f"  ! {name}: {reason}")

    return entries


# ---------------------------------------------------------------------------
# Liaisons (bus ou portions de rando non enregistrées), géocodage
# ---------------------------------------------------------------------------

def load_geocode_cache():
    if GEOCODE_CACHE_PATH.exists():
        return json.loads(GEOCODE_CACHE_PATH.read_text())
    return {}


def save_geocode_cache(cache):
    GEOCODE_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2))


def geocode(name, cache):
    if name in cache:
        return cache[name]
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
        "q": name, "format": "json", "limit": 1,
    })
    req = urllib.request.Request(url, headers={"User-Agent": "rando-site-builder/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            results = json.loads(resp.read().decode())
        time.sleep(1)  # politesse envers l'API Nominatim (max 1 req/s)
    except Exception as e:
        log(f"  ! géocodage échoué pour '{name}': {e}")
        cache[name] = None
        return None
    if not results:
        log(f"  ! aucun résultat de géocodage pour '{name}'")
        cache[name] = None
        return None
    coords = {"lat": float(results[0]["lat"]), "lon": float(results[0]["lon"])}
    cache[name] = coords
    return coords


def resolve_point(spec, track_endpoints, cache):
    """Résout un point de liaison : référence à une trace GPX, coordonnées explicites, ou géocodage par nom."""
    spec = dict(spec or {})
    if "trackRef" in spec:
        endpoint = track_endpoints.get(spec["trackRef"], {}).get(spec.get("point", "start"))
        if not endpoint:
            return None
        return {"name": spec.get("name") or endpoint["label"], "lat": endpoint["lat"], "lon": endpoint["lon"]}
    if spec.get("lat") is not None and spec.get("lon") is not None:
        return {"name": spec.get("name", ""), "lat": spec["lat"], "lon": spec["lon"]}
    if spec.get("name"):
        coords = geocode(spec["name"], cache)
        if coords:
            return {"name": spec["name"], "lat": coords["lat"], "lon": coords["lon"]}
    return None


def build_liaisons(track_endpoints):
    liaisons_path = DATA / "liaisons.json"
    if not liaisons_path.exists():
        return []
    raw = json.loads(liaisons_path.read_text())
    cache = load_geocode_cache()
    resolved = []
    for leg in raw:
        from_point = resolve_point(leg.get("from"), track_endpoints, cache)
        to_point = resolve_point(leg.get("to"), track_endpoints, cache)
        if from_point and to_point:
            resolved.append({
                "id": leg.get("id"),
                "mode": leg.get("mode", "bus"),
                "date": leg.get("date"),
                "note": leg.get("note", ""),
                "from": from_point,
                "to": to_point,
            })
        else:
            log(f"  ! liaison '{leg.get('id')}' ignorée (point introuvable)")
    save_geocode_cache(cache)
    return resolved


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    trip = json.loads((DATA / "trip.json").read_text())
    captions_path = DATA / "captions.json"
    captions = json.loads(captions_path.read_text()) if captions_path.exists() else {}
    trip_days_by_date = {d["date"]: d for d in trip.get("days", []) if d.get("date")}

    log("Traces GPX:")
    tracks, time_points, track_endpoints = build_tracks(trip_days_by_date)

    log("Liaisons (bus / rando non enregistrée):")
    liaisons = build_liaisons(track_endpoints)

    log("Photos:")
    photos = build_photos(time_points, trip.get("timezone", "Europe/Paris"), captions)

    log("Vidéos:")
    videos = build_videos(time_points, trip.get("timezone", "Europe/Paris"), captions)

    total_distance = round(sum(t["distanceKm"] for t in tracks), 1)
    total_gain = round(sum(t["elevationGainM"] for t in tracks))
    total_duration = sum(t["durationS"] or 0 for t in tracks)

    manifest = {
        "trip": trip,
        "stats": {
            "totalDistanceKm": total_distance,
            "totalElevationGainM": total_gain,
            "totalDurationS": total_duration,
            "dayCount": len(tracks),
        },
        "tracks": tracks,
        "liaisons": liaisons,
        "photos": photos,
        "videos": videos,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }

    manifest_path = DOCS / "data" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    log(f"\nOK -> {manifest_path.relative_to(ROOT)}")
    log(f"   {len(tracks)} jour(s), {total_distance} km, +{total_gain} m, {len(photos)} photo(s), {len(videos)} vidéo(s), {len(liaisons)} liaison(s)")


if __name__ == "__main__":
    main()
