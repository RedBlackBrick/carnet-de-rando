# Site de la randonnée

Mini-site statique présentant une randonnée de plusieurs jours : traces GPX sur une carte, trajets en bus, et photos géolocalisées.

## 1. Récupérer les données

### Traces GPX (montre Garmin)
1. Aller sur [connect.garmin.com](https://connect.garmin.com), se connecter.
2. Ouvrir chaque activité de la randonnée (en général une par jour).
3. Menu `...` (en haut à droite de l'activité) → **Exporter en GPX**.
4. Déposer les fichiers `.gpx` téléchargés dans `data/gpx/` (un fichier par jour, nom libre).

### Photos (téléphone)
- Copier les photos **originales** (pas de version compressée envoyée par messagerie/WhatsApp, ça supprime la position GPS) dans `data/photos/`.
- Formats acceptés : `.jpg`, `.jpeg`, `.heic`.
- Si une photo n'a pas de position GPS dans ses métadonnées, le script essaie de la positionner automatiquement en comparant son horodatage à la trace GPX la plus proche dans le temps.

### Trajets en bus
- Il n'y a pas de GPX pour les bus. Compléter `data/bus.json` avec, pour chaque trajet : lieu de départ, lieu d'arrivée, date. Les coordonnées peuvent rester à `null`, le script les retrouve automatiquement à partir du nom de lieu (géocodage OpenStreetMap).

### Texte de présentation
- Compléter `data/trip.json` : titre, dates, et un petit texte par jour (facultatif).

## 2. Générer le site

```bash
python3 scripts/build_data.py
```

Le script est ré-exécutable à volonté (idempotent) au fur et à mesure que tu ajoutes des photos/traces. Il régénère `docs/data/manifest.json` et les photos compressées dans `docs/photos/`.

Dépendances Python : `pip install Pillow pillow-heif` (pillow-heif seulement si des photos sont en `.heic`).

## 3. Prévisualiser en local

```bash
cd docs && python3 -m http.server 8000
```
puis ouvrir http://localhost:8000

## 4. Publier

Le contenu de `docs/` est prévu pour être servi par GitHub Pages (branche `main`, dossier `/docs`).

## ⚠️ Note sur la confidentialité

Le dépôt GitHub est **public** (nécessaire pour GitHub Pages gratuit). Le site est protégé par un simple code d'accès (page de garde en JavaScript) qui empêche la consultation normale et l'indexation par les moteurs de recherche, mais **n'empêche pas** quelqu'un qui connaîtrait l'URL du dépôt GitHub de retrouver les photos/GPX en parcourant les fichiers du repo directement. C'est suffisant pour éviter les curieux/l'indexation, mais ce n'est pas une vraie protection si le contenu est sensible. Pour une vraie confidentialité (dépôt privé), il faudrait passer par un hébergeur qui accepte de builder depuis un repo privé gratuitement (ex. Cloudflare Pages).
