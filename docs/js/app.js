const COLORS = { pine: "#3C5C3F", slate: "#4A6572", trailRed: "#C1442D" };

function maybeInit() {
  if (sessionStorage.getItem("randoUnlocked") === "1") {
    init();
  } else {
    window.addEventListener("rando:unlocked", init, { once: true });
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function parseGpx(url) {
  const res = await fetch(url);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const pts = Array.from(doc.getElementsByTagName("trkpt")).map((el) => {
    const eleEl = el.getElementsByTagName("ele")[0];
    return {
      lat: parseFloat(el.getAttribute("lat")),
      lon: parseFloat(el.getAttribute("lon")),
      ele: eleEl ? parseFloat(eleEl.textContent) : null,
    };
  });
  return pts;
}

function formatDuration(seconds) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

function renderHero(manifest) {
  document.getElementById("hero-eyebrow").textContent =
    `${manifest.trip.startDate ?? ""} → ${manifest.trip.endDate ?? ""}`.trim();
  document.getElementById("hero-title").textContent = manifest.trip.title || "Notre randonnée";
  document.getElementById("hero-subtitle").textContent = manifest.trip.subtitle || manifest.trip.intro || "";

  const stats = [
    { value: `${manifest.stats.totalDistanceKm} km`, label: "Distance" },
    { value: `+${manifest.stats.totalElevationGainM} m`, label: "Dénivelé" },
    { value: manifest.stats.dayCount, label: manifest.stats.dayCount > 1 ? "Jours" : "Jour" },
  ];
  const dl = document.getElementById("hero-stats");
  dl.innerHTML = stats.map((s) => `<div><dd>${s.value}</dd><dt>${s.label}</dt></div>`).join("");
}

function renderElevationProfile(tracksWithPoints) {
  const svg = document.getElementById("hero-profile");
  const samples = [];
  let runningKm = 0;
  for (const track of tracksWithPoints) {
    const pts = track.points.filter((p) => p.ele !== null);
    if (pts.length === 0) continue;
    let prev = null;
    for (const p of pts) {
      if (prev) runningKm += haversineKm(prev.lat, prev.lon, p.lat, p.lon);
      samples.push({ km: runningKm, ele: p.ele });
      prev = p;
    }
  }
  if (samples.length < 2) {
    svg.style.display = "none";
    return;
  }
  const totalKm = samples[samples.length - 1].km || 1;
  const eles = samples.map((s) => s.ele);
  const minEle = Math.min(...eles);
  const maxEle = Math.max(...eles);
  const span = Math.max(maxEle - minEle, 1);

  const toXY = (s) => {
    const x = (s.km / totalKm) * 1000;
    const y = 110 - ((s.ele - minEle) / span) * 90;
    return [x, y];
  };

  const points = samples.map(toXY);
  let d = `M 0,120 L ${points[0][0]},${points[0][1]} `;
  d += points.slice(1).map(([x, y]) => `L ${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  d += ` L 1000,120 Z`;

  svg.innerHTML = `
    <path d="${d}" fill="${COLORS.pine}" opacity="0.18"></path>
    <polyline points="${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}"
      fill="none" stroke="${COLORS.pine}" stroke-width="2"></polyline>
  `;
}

function renderDayTabs(manifest, onSelectDay, onSelectOverview, onSelectBuses) {
  const nav = document.getElementById("day-tabs");
  const buttons = [];

  const overviewBtn = document.createElement("button");
  overviewBtn.className = "day-tab active";
  overviewBtn.innerHTML = `<span class="tab-label">Ensemble</span><span class="tab-meta">${manifest.stats.totalDistanceKm} km</span>`;
  overviewBtn.addEventListener("click", () => {
    setActive(overviewBtn);
    onSelectOverview();
  });
  nav.appendChild(overviewBtn);
  buttons.push(overviewBtn);

  manifest.tracks.forEach((track) => {
    const btn = document.createElement("button");
    btn.className = "day-tab";
    btn.style.setProperty("--day-color", track.color);
    btn.innerHTML = `<span class="tab-label">${track.label}</span><span class="tab-meta">${track.distanceKm} km · +${track.elevationGainM} m</span>`;
    btn.addEventListener("click", () => {
      setActive(btn);
      onSelectDay(track);
    });
    nav.appendChild(btn);
    buttons.push(btn);
  });

  if (manifest.buses.length > 0) {
    const busBtn = document.createElement("button");
    busBtn.className = "day-tab bus-toggle";
    busBtn.innerHTML = `<span class="tab-label">🚌 Bus</span><span class="tab-meta">${manifest.buses.length} trajet(s)</span>`;
    busBtn.addEventListener("click", () => {
      setActive(busBtn);
      onSelectBuses();
    });
    nav.appendChild(busBtn);
    buttons.push(busBtn);
  }

  function setActive(target) {
    buttons.forEach((b) => b.classList.toggle("active", b === target));
  }
}

function renderDetailForDay(track, photosForDay) {
  const el = document.getElementById("detail");
  const photosHtml =
    photosForDay.length > 0
      ? `<div class="filmstrip">${photosForDay
          .map((p, i) => `<img src="${p.thumb}" data-photo-index="${p._index}" alt="${p.caption || ""}">`)
          .join("")}</div>`
      : "";
  el.innerHTML = `
    <span class="detail-badge" style="--day-color:${track.color}">${track.label}</span>
    <h2>${track.label}</h2>
    <p class="detail-date">${formatDate(track.date)}</p>
    ${track.description ? `<p class="detail-description">${track.description}</p>` : ""}
    <div class="detail-stats">
      <div><span>Distance</span>${track.distanceKm} km</div>
      <div><span>Dénivelé +</span>${track.elevationGainM} m</div>
      <div><span>Dénivelé -</span>${track.elevationLossM} m</div>
      <div><span>Durée</span>${formatDuration(track.durationS)}</div>
    </div>
    ${photosHtml}
  `;
  el.querySelectorAll("img[data-photo-index]").forEach((img) => {
    img.addEventListener("click", () => openLightbox(parseInt(img.dataset.photoIndex, 10)));
  });
}

function renderDetailOverview(manifest) {
  const el = document.getElementById("detail");
  el.innerHTML = `
    <h2>${manifest.trip.title || "La randonnée"}</h2>
    <p class="detail-description">${manifest.trip.intro || ""}</p>
    <div class="detail-stats">
      <div><span>Distance totale</span>${manifest.stats.totalDistanceKm} km</div>
      <div><span>Dénivelé total</span>+${manifest.stats.totalElevationGainM} m</div>
      <div><span>Jours</span>${manifest.stats.dayCount}</div>
      <div><span>Photos</span>${manifest.photos.length}</div>
    </div>
  `;
}

function renderDetailBuses(manifest) {
  const el = document.getElementById("detail");
  el.innerHTML = `
    <h2>Trajets en bus</h2>
    <ul class="bus-list">
      ${manifest.buses
        .map(
          (b) => `<li>
            <div class="bus-route">${b.from.name} → ${b.to.name}</div>
            <div class="bus-date">${formatDate(b.date)}${b.note ? " · " + b.note : ""}</div>
          </li>`
        )
        .join("")}
    </ul>
  `;
}

let allPhotos = [];
function openLightbox(index) {
  const lb = document.getElementById("lightbox");
  const photo = allPhotos[index];
  if (!photo) return;
  document.getElementById("lightbox-img").src = photo.file;
  document.getElementById("lightbox-img").alt = photo.caption || "";
  document.getElementById("lightbox-caption-text").textContent = photo.caption || "";
  document.getElementById("lightbox-date").textContent = photo.date ? formatDate(photo.date) : "";
  lb.dataset.index = index;
  lb.hidden = false;
}

function setupLightbox() {
  const lb = document.getElementById("lightbox");
  const close = () => (lb.hidden = true);
  document.getElementById("lightbox-close").addEventListener("click", close);
  lb.addEventListener("click", (e) => { if (e.target === lb) close(); });
  document.getElementById("lightbox-prev").addEventListener("click", () => step(-1));
  document.getElementById("lightbox-next").addEventListener("click", () => step(1));
  function step(dir) {
    const idx = (parseInt(lb.dataset.index, 10) + dir + allPhotos.length) % allPhotos.length;
    openLightbox(idx);
  }
  document.addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
}

async function init() {
  setupLightbox();

  const manifest = await fetch("data/manifest.json").then((r) => r.json());
  renderHero(manifest);

  allPhotos = manifest.photos.map((p, i) => ({ ...p, _index: i }));

  const map = L.map("map", { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    attribution:
      'Fond de carte © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), données © OpenStreetMap',
  }).addTo(map);

  const tracksWithPoints = [];
  const trackLayers = {};
  const allBounds = [];

  for (const track of manifest.tracks) {
    const points = await parseGpx(track.file);
    tracksWithPoints.push({ ...track, points });
    const latlngs = points.map((p) => [p.lat, p.lon]);
    const layer = L.polyline(latlngs, { color: track.color, weight: 4, opacity: 1 }).addTo(map);
    if (latlngs.length) {
      L.circleMarker(latlngs[0], { radius: 5, color: track.color, fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(map);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 5, color: track.color, fillColor: track.color, fillOpacity: 1, weight: 2 }).addTo(map);
    }
    trackLayers[track.id] = layer;
    allBounds.push(...latlngs);
  }

  renderElevationProfile(tracksWithPoints);

  const busLayers = [];
  manifest.buses.forEach((bus) => {
    const from = [bus.from.lat, bus.from.lon];
    const to = [bus.to.lat, bus.to.lon];
    const line = L.polyline([from, to], { color: COLORS.slate, weight: 3, dashArray: "6 8" }).addTo(map);
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    L.marker(mid, {
      icon: L.divIcon({ className: "", html: '<div class="bus-marker">🚌</div>', iconSize: [26, 26] }),
    }).addTo(map).bindPopup(`${bus.from.name} → ${bus.to.name}`);
    busLayers.push(line);
    allBounds.push(from, to);
  });

  const cluster = L.markerClusterGroup({ maxClusterRadius: 40 });
  allPhotos.forEach((photo) => {
    const icon = L.divIcon({
      className: "",
      html: `<div class="photo-marker" style="background-image:url('${photo.thumb}')"></div>`,
      iconSize: [38, 38],
    });
    const marker = L.marker([photo.lat, photo.lon], { icon });
    marker.on("click", () => openLightbox(photo._index));
    cluster.addLayer(marker);
    allBounds.push([photo.lat, photo.lon]);
  });
  map.addLayer(cluster);

  if (allBounds.length) map.fitBounds(allBounds, { padding: [30, 30] });

  function photosForTrack(track) {
    if (!track.date) return [];
    return allPhotos.filter((p) => p.date && p.date.slice(0, 10) === track.date);
  }

  function resetOpacity(activeId) {
    Object.entries(trackLayers).forEach(([id, layer]) => {
      layer.setStyle({ opacity: activeId && id !== activeId ? 0.35 : 1 });
    });
  }

  renderDayTabs(
    manifest,
    (track) => {
      resetOpacity(track.id);
      const layer = trackLayers[track.id];
      if (layer) map.fitBounds(layer.getBounds(), { padding: [40, 40] });
      renderDetailForDay(track, photosForTrack(track));
    },
    () => {
      resetOpacity(null);
      if (allBounds.length) map.fitBounds(allBounds, { padding: [30, 30] });
      renderDetailOverview(manifest);
    },
    () => {
      resetOpacity(null);
      if (busLayers.length) {
        const group = L.featureGroup(busLayers);
        map.fitBounds(group.getBounds(), { padding: [40, 40] });
      }
      renderDetailBuses(manifest);
    }
  );

  renderDetailOverview(manifest);
}

maybeInit();
