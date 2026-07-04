# Site de la randonnée

Mini-site statique présentant une randonnée de plusieurs jours : traces GPX sur une carte, trajets en bus, et photos géolocalisées.

## 1. Récupérer les données

### Traces GPX (montre Garmin)
Deux méthodes :
- **Simple** : sur [connect.garmin.com](https://connect.garmin.com), ouvrir chaque activité → menu `...` → **Exporter en GPX** → déposer les fichiers dans `data/gpx/`. Cette méthode ne fournit que la trace (pas de FC/calories/cadence).
- **Complète (recommandée)** : sur chaque activité, menu `...` → **Exporter l'original** (télécharge un `.zip` contenant le `.fit` natif de la montre), puis convertir avec :
  ```bash
  .venv/bin/python scripts/fit_to_gpx.py --csv ~/Téléchargements/Activities.csv ~/Téléchargements/*.zip
  ```
  Le `--csv` (export CSV de la liste des activités) est optionnel mais permet de récupérer automatiquement le titre de chaque activité. Cette méthode embarque aussi FC, calories, cadence, température, dénivelé exact et temps de mouvement dans le GPX généré (lus ensuite par `build_data.py`).

### Photos (téléphone)
- Copier les photos **originales** (pas de version compressée envoyée par messagerie/WhatsApp, ça supprime la position GPS) dans `data/photos/`.
- Formats acceptés : `.jpg`, `.jpeg`, `.heic`.
- Si une photo n'a pas de position GPS dans ses métadonnées, le script essaie de la positionner automatiquement en comparant son horodatage à la trace GPX la plus proche dans le temps.

### Vidéos (téléphone)
- Copier les vidéos **originales** dans `data/videos/` (`.mp4`/`.mov`).
- Le script lit la position GPS et la date de tournage directement depuis les métadonnées vidéo (via `ffmpeg`), avec le même repli par horodatage que les photos si le GPS est absent.
- Chaque vidéo est automatiquement compressée en 720p (H.264/AAC) pour rester légère sur le site, et une vignette est extraite pour l'affichage sur la carte et dans le carrousel du jour.

### Liaisons (bus, portions non enregistrées)
- Compléter `data/liaisons.json` : chaque entrée a un `mode` (`"bus"` ou `"rando"` pour une portion à pied non enregistrée par la montre), une date, et un point `from`/`to`.
- Un point peut être : `{"name": "Lieu, Ville"}` (géocodé automatiquement via OpenStreetMap), `{"lat":, "lon":}` (coordonnées explicites), ou `{"trackRef": "day-3", "point": "end"}` (réutilise le début/fin d'une trace GPX déjà présente — pratique pour enchaîner directement sur le point où une trace s'arrête, sans redonner de coordonnées).

### Texte de présentation
- Compléter `data/trip.json` : titre, dates, et un petit texte par jour (facultatif).

## 2. Générer le site

```bash
python3 scripts/build_data.py
```

Le script est ré-exécutable à volonté (idempotent) au fur et à mesure que tu ajoutes des photos/traces. Il régénère `docs/data/manifest.json` et les photos compressées dans `docs/photos/`.

Dépendances Python (dans un venv du projet) :
```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
```

## 3. Prévisualiser en local

```bash
cd docs && python3 -m http.server 8000
```
puis ouvrir http://localhost:8000

## 4. Publier

Le contenu de `docs/` est prévu pour être servi par GitHub Pages (branche `main`, dossier `/docs`).

## ⚠️ Note sur la confidentialité

Le dépôt GitHub est **public** (nécessaire pour GitHub Pages gratuit). Le site est protégé par un simple code d'accès (page de garde en JavaScript) qui empêche la consultation normale et l'indexation par les moteurs de recherche, mais **n'empêche pas** quelqu'un qui connaîtrait l'URL du dépôt GitHub de retrouver les photos/GPX en parcourant les fichiers du repo directement. C'est suffisant pour éviter les curieux/l'indexation, mais ce n'est pas une vraie protection si le contenu est sensible. Pour une vraie confidentialité (dépôt privé), il faudrait passer par un hébergeur qui accepte de builder depuis un repo privé gratuitement (ex. Cloudflare Pages).
