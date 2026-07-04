const COLORS = { pine: "#3C5C3F", slate: "#4A6572", trailRed: "#C1442D" };

const EXTRA_STATS = [
  { key: "avgHr", label: "FC moyenne", fmt: (v) => `${v} bpm` },
  { key: "maxHr", label: "FC max", fmt: (v) => `${v} bpm` },
  { key: "calories", label: "Calories", fmt: (v) => `${v} kcal` },
  { key: "avgCadence", label: "Cadence moy.", fmt: (v) => `${v} ppm` },
  { key: "maxCadence", label: "Cadence max", fmt: (v) => `${v} ppm` },
  { key: "minTemp", label: "Température min", fmt: (v) => `${v}°C` },
  { key: "maxTemp", label: "Température max", fmt: (v) => `${v}°C` },
  { key: "trainingEffect", label: "Effet d'entraînement", fmt: (v) => v },
];

const LIAISON_STYLES = {
  bus: { color: COLORS.slate, dashArray: "6 8", icon: "🚌", label: "Bus" },
  rando: { color: COLORS.trailRed, dashArray: "2 6", icon: "🥾", label: "Rando non enregistrée" },
};

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
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h${String(m).padStart(2, "0")}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

function formatDateShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
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

let profileData = null;

// Repère les transferts en bus entre deux étapes (ex. Gèdre → Luz-St-Sauveur → Barèges)
// à partir des liaisons, pour assurer la continuité du profil.
function buildTransfers(manifest, tracksWithPoints) {
  const VIA_ELE = [{ re: /luz/i, ele: 710 }]; // altitudes approx. des villes-étapes de transfert
  const near = (a, b) => haversineKm(a.lat, a.lon, b.lat, b.lon);
  const shortName = (n) => (n || "").split(",")[0].trim();
  const buses = (manifest.liaisons || []).filter((l) => l.mode === "bus" && l.from && l.to);
  const out = new Array(tracksWithPoints.length).fill(null);

  for (let i = 0; i < tracksWithPoints.length - 1; i++) {
    const A = tracksWithPoints[i], B = tracksWithPoints[i + 1];
    const aEnd = A.points[A.points.length - 1], bStart = B.points[0];
    const legs = buses.filter((l) => l.date >= A.date && l.date <= B.date);
    if (!legs.length) continue;

    // chaîne gloutonne depuis la fin de l'étape
    const remaining = legs.slice();
    const chain = [];
    let cur = { lat: aEnd.lat, lon: aEnd.lon };
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      remaining.forEach((l, idx) => { const d = near(l.from, cur); if (d < bd) { bd = d; bi = idx; } });
      const leg = remaining.splice(bi, 1)[0];
      chain.push(leg);
      cur = { lat: leg.to.lat, lon: leg.to.lon };
    }
    // ne garder que si la chaîne relie vraiment fin d'étape → départ suivant
    if (near(chain[0].from, aEnd) > 3.5 || near(chain[chain.length - 1].to, bStart) > 3.5) continue;

    const eleFor = (name) => { const m = VIA_ELE.find((v) => v.re.test(name || "")); return m ? m.ele : null; };
    const pts = [{ lat: aEnd.lat, lon: aEnd.lon, ele: aEnd.ele }];
    chain.forEach((leg, idx) => {
      if (idx === chain.length - 1) return; // dernier point ≈ bStart (ajouté après)
      pts.push({ lat: leg.to.lat, lon: leg.to.lon, ele: eleFor(leg.to.name) });
    });
    pts.push({ lat: bStart.lat, lon: bStart.lon, ele: bStart.ele });
    out[i] = { mode: "bus", points: pts, label: `${shortName(chain[0].from.name)} → ${shortName(chain[chain.length - 1].to.name)}` };
  }
  return out;
}

function renderElevationProfile(tracksWithPoints, transfers) {
  const svg = document.getElementById("hero-profile");
  const BUS_VIS_KM = 4.5; // largeur "visuelle" d'un transfert (non comptée en km de marche)
  const raw = [];
  const dayMarks = [];
  const busMarks = [];
  let hikeKm = 0, pk = 0;

  tracksWithPoints.forEach((track, di) => {
    const pts = track.points.filter((p) => p.ele !== null);
    if (!pts.length) return;
    const dayStart = pk;
    let prev = null;
    for (const p of pts) {
      if (prev) { const d = haversineKm(prev.lat, prev.lon, p.lat, p.lon); hikeKm += d; pk += d; }
      raw.push({ km: hikeKm, pk, ele: p.ele, lat: p.lat, lon: p.lon, bus: false, day: di + 1 });
      prev = p;
    }
    dayMarks.push({ day: di + 1, color: track.color, pk0: dayStart, pk1: pk });

    const tr = transfers && transfers[di];
    if (tr && tr.points.length >= 2) {
      const wp = tr.points.map((w) => ({ ...w }));
      for (let k = 0; k < wp.length; k++) {
        if (wp[k].ele == null) {
          let a = k - 1; while (a >= 0 && wp[a].ele == null) a--;
          let b = k + 1; while (b < wp.length && wp[b].ele == null) b++;
          wp[k].ele = ((a >= 0 ? wp[a].ele : wp[b].ele) + (b < wp.length ? wp[b].ele : wp[a].ele)) / 2;
        }
      }
      const segs = [];
      let segTot = 0;
      for (let k = 1; k < wp.length; k++) { const d = haversineKm(wp[k - 1].lat, wp[k - 1].lon, wp[k].lat, wp[k].lon); segs.push(d); segTot += d; }
      const busStart = pk;
      for (let k = 1; k < wp.length; k++) {
        pk += (segTot > 0 ? segs[k - 1] / segTot : 1 / (wp.length - 1)) * BUS_VIS_KM;
        raw.push({ km: hikeKm, pk, ele: wp[k].ele, lat: wp[k].lat, lon: wp[k].lon, bus: true, day: di + 1, transferLabel: tr.label });
      }
      busMarks.push({ pk0: busStart, pk1: pk, label: tr.label });
    }
  });

  if (raw.length < 2) { svg.style.display = "none"; return; }

  const totalPk = raw[raw.length - 1].pk || 1;
  const eles = raw.map((s) => s.ele);
  const minEle = Math.min(...eles), maxEle = Math.max(...eles);
  const span = Math.max(maxEle - minEle, 1);
  raw.forEach((s) => {
    s.x = (s.pk / totalPk) * 1000;
    s.y = 110 - ((s.ele - minEle) / span) * 90;
  });
  const vx = (v) => (v / totalPk) * 1000;
  dayMarks.forEach((m) => { m.x0 = vx(m.pk0); m.x1 = vx(m.pk1); m.xMid = (m.x0 + m.x1) / 2; });
  busMarks.forEach((m) => { m.x0 = vx(m.pk0); m.x1 = vx(m.pk1); m.xMid = (m.x0 + m.x1) / 2; });

  // découpe en tronçons contigus marche / bus
  const runs = [];
  let run = null;
  raw.forEach((s, idx) => {
    if (!run || run.bus !== s.bus) {
      run = { bus: s.bus, pts: [] };
      if (s.bus && idx > 0) run.pts.push(raw[idx - 1]); // relie au dernier point de marche
      runs.push(run);
    }
    run.pts.push(s);
  });

  const busBands = busMarks
    .map((m) => `<rect x="${m.x0.toFixed(1)}" y="0" width="${(m.x1 - m.x0).toFixed(1)}" height="120" fill="${COLORS.slate}" opacity="0.07"></rect>`)
    .join("");
  const seps = dayMarks
    .slice(1)
    .map((m) => `<line x1="${m.x0.toFixed(1)}" y1="16" x2="${m.x0.toFixed(1)}" y2="120" stroke="#4B564A" stroke-width="1" stroke-dasharray="1 3" opacity="0.35"></line>`)
    .join("");
  const lines = runs
    .map((r) => {
      const line = r.pts.map((s) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" ");
      if (r.bus) {
        return `<polyline points="${line}" fill="none" stroke="${COLORS.slate}" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round"></polyline>`;
      }
      const p0 = r.pts[0], pN = r.pts[r.pts.length - 1];
      const area = `<path d="M ${p0.x.toFixed(1)},120 L ${r.pts.map((s) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" L ")} L ${pN.x.toFixed(1)},120 Z" fill="${COLORS.pine}" opacity="0.16"></path>`;
      return area + `<polyline points="${line}" fill="none" stroke="${COLORS.pine}" stroke-width="2"></polyline>`;
    })
    .join("");

  svg.innerHTML = busBands + seps + lines;
  profileData = { samples: raw, totalKm: hikeKm, minEle, maxEle, span, dayMarks, busMarks };
}

const POI_ICONS = { pic: "▲", col: "⛰", refuge: "⌂", cascade: "≈", lac: "◍", ville: "◉", lieu: "◆" };
let hoverMarker = null;

function setupProfileInteraction(map, pois) {
  if (!profileData) return;
  const wrap = document.getElementById("hero-profile-wrap");
  const poisEl = document.getElementById("hero-pois");
  const cursor = document.getElementById("hero-cursor");
  const cursorDot = cursor.querySelector(".hero-cursor-dot");
  const readout = document.getElementById("hero-readout");
  const samples = profileData.samples;

  const PROF_H = 90; // hauteur (px) de la zone de profil, cf. CSS .hero-profile

  // Accroche chaque POI au point de trace le plus proche (ignore ceux trop loin du tracé).
  const snapped = [];
  for (const poi of pois || []) {
    let best = Infinity, bi = -1;
    for (let i = 0; i < samples.length; i++) {
      const d = haversineKm(samples[i].lat, samples[i].lon, poi.lat, poi.lon);
      if (d < best) { best = d; bi = i; }
    }
    // Les villages/lieux sont souvent contournés par le tracé : seuil d'accroche plus large.
    // Un POI peut fixer son propre seuil (ex. sommet ou barrage un peu à l'écart du sentier).
    const maxSnap = poi.snap ?? (poi.kind === "ville" || poi.kind === "lieu" ? 1.3 : 0.35);
    if (bi < 0 || best > maxSnap) continue;
    const s = samples[bi];
    snapped.push({ ...poi, km: s.km, x: s.x, y: s.y, lat: s.lat, lon: s.lon });
  }
  snapped.sort((a, b) => a.km - b.km);

  // Placement des étiquettes (POIs "majeurs") sur plusieurs rangs pour éviter les chevauchements.
  // Sur petit écran on masque les étiquettes (trop serrées) : dots + infobulle tactile suffisent.
  const wrapW = wrap.getBoundingClientRect().width || 1000;
  const showLabels = wrapW > 640;
  const ROW_H = 15, TOP_PAD = 4;
  const rowsRight = []; // dernier bord droit occupé par rang
  if (showLabels) {
    snapped.filter((p) => p.major).forEach((p) => {
      const w = p.name.length * 6.2 + 8;
      const centerPx = (p.x / 1000) * wrapW;
      const leftEdge = centerPx - w / 2;
      let row = rowsRight.findIndex((right) => leftEdge > right + 6);
      if (row === -1) { row = rowsRight.length; rowsRight.push(0); }
      rowsRight[row] = centerPx + w / 2;
      p._row = row;
    });
  }
  const laneH = showLabels ? TOP_PAD + Math.max(rowsRight.length, 1) * ROW_H + 6 : 12;
  wrap.style.paddingTop = `${laneH}px`;

  const html = snapped.map((p, i) => {
    const leftPct = (p.x / 1000) * 100;
    const dotTop = laneH + (p.y / 120) * PROF_H;
    let extra = "";
    if (p.major && showLabels) {
      const rowTop = TOP_PAD + p._row * ROW_H;
      const lineTop = rowTop + 13;
      extra =
        `<span class="poi-line" style="left:${leftPct}%; top:${lineTop}px; height:${Math.max(dotTop - lineTop, 0)}px"></span>` +
        `<span class="poi-label" style="left:${leftPct}%; top:${rowTop}px">${p.name}</span>`;
    }
    return extra +
      `<span class="poi poi-${p.kind}${p.major ? " poi-major" : ""}" data-i="${i}" ` +
      `style="left:${leftPct}%; top:${dotTop}px"></span>`;
  }).join("");
  const dayHtml = (profileData.dayMarks || [])
    .map((m) => `<span class="hero-day" style="left:${(m.xMid / 1000) * 100}%; top:${laneH + PROF_H - 12}px">J${m.day}</span>`)
    .join("");
  const busHtml = (profileData.busMarks || [])
    .map((m) => `<span class="hero-bus" style="left:${(m.xMid / 1000) * 100}%; top:${laneH + PROF_H * 0.32}px" title="Bus · ${m.label}">🚌</span>`)
    .join("");
  poisEl.innerHTML = html + dayHtml + busHtml;
  const poiEls = Array.from(poisEl.querySelectorAll(".poi"));

  hoverMarker = L.circleMarker([samples[0].lat, samples[0].lon], {
    radius: 7, color: "#fff", weight: 3, fillColor: COLORS.trailRed, fillOpacity: 1, interactive: false,
  });

  function nearestByX(targetX) {
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].x < targetX) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(samples[lo - 1].x - targetX) < Math.abs(samples[lo].x - targetX)) lo--;
    return lo;
  }

  function showAt(clientX) {
    const rect = wrap.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const s = samples[nearestByX(fx * 1000)];

    cursor.hidden = false;
    cursor.style.left = `${(s.x / 1000) * 100}%`;
    cursorDot.style.top = `${laneH + (s.y / 120) * PROF_H}px`;

    if (!map.hasLayer(hoverMarker)) hoverMarker.addTo(map);
    hoverMarker.setLatLng([s.lat, s.lon]);

    let nearPoi = null;
    if (!s.bus) {
      let bestKm = 1.2;
      for (const p of snapped) {
        const dk = Math.abs(p.km - s.km);
        if (dk < bestKm) { bestKm = dk; nearPoi = p; }
      }
    }
    poiEls.forEach((el, i) => el.classList.toggle("poi-active", nearPoi && snapped[i] === nearPoi));

    readout.hidden = false;
    if (s.bus) {
      readout.innerHTML = `<span class="readout-main">🚌 Bus</span><span class="readout-poi">${s.transferLabel || "Transfert"}</span>`;
    } else {
      const poiTxt = nearPoi
        ? `<span class="readout-poi">${POI_ICONS[nearPoi.kind] || ""} ${nearPoi.name}${nearPoi.ele ? ` · ${nearPoi.ele} m` : ""}</span>`
        : "";
      readout.innerHTML =
        `<span class="readout-main">${Math.round(s.ele)} m<span class="readout-km">${s.km.toFixed(1)} km</span></span>${poiTxt}`;
    }
    const px = (s.x / 1000) * rect.width;
    readout.style.left = `${Math.min(Math.max(px, 70), rect.width - 70)}px`;
    readout.style.top = `${laneH + 2}px`;
  }

  function hide() {
    cursor.hidden = true;
    readout.hidden = true;
    if (hoverMarker && map.hasLayer(hoverMarker)) map.removeLayer(hoverMarker);
    poiEls.forEach((el) => el.classList.remove("poi-active"));
  }

  wrap.addEventListener("mousemove", (e) => showAt(e.clientX));
  wrap.addEventListener("mouseleave", hide);
  wrap.addEventListener("touchstart", (e) => showAt(e.touches[0].clientX), { passive: true });
  wrap.addEventListener("touchmove", (e) => showAt(e.touches[0].clientX), { passive: true });
  wrap.addEventListener("touchend", () => setTimeout(hide, 2500), { passive: true });
}

function renderDayTabs(manifest, onSelectDay, onSelectOverview, onSelectLiaisons) {
  const nav = document.getElementById("day-tabs");
  const buttons = [];

  const overviewBtn = document.createElement("button");
  overviewBtn.className = "day-tab active";
  overviewBtn.innerHTML = `<span class="tab-index">Aperçu</span><span class="tab-label">Ensemble</span><span class="tab-meta">${manifest.stats.totalDistanceKm} km · ${manifest.stats.dayCount} jours</span>`;
  overviewBtn.addEventListener("click", () => {
    setActive(overviewBtn);
    onSelectOverview();
  });
  nav.appendChild(overviewBtn);
  buttons.push(overviewBtn);

  manifest.tracks.forEach((track, i) => {
    const btn = document.createElement("button");
    btn.className = "day-tab";
    btn.dataset.trackId = track.id;
    btn.style.setProperty("--day-color", track.color);
    btn.innerHTML = `<span class="tab-index">Jour ${i + 1} · ${formatDateShort(track.date)}</span><span class="tab-label">${track.label}</span><span class="tab-meta">${track.distanceKm} km · +${track.elevationGainM} m</span>`;
    btn.addEventListener("click", () => {
      setActive(btn);
      onSelectDay(track);
    });
    nav.appendChild(btn);
    buttons.push(btn);
  });

  if (manifest.liaisons.length > 0) {
    const liaisonBtn = document.createElement("button");
    liaisonBtn.className = "day-tab bus-toggle";
    liaisonBtn.innerHTML = `<span class="tab-index">Transferts</span><span class="tab-label">🚌🥾 Liaisons</span><span class="tab-meta">${manifest.liaisons.length} trajet(s)</span>`;
    liaisonBtn.addEventListener("click", () => {
      setActive(liaisonBtn);
      onSelectLiaisons();
    });
    nav.appendChild(liaisonBtn);
    buttons.push(liaisonBtn);
  }

  function setActive(target) {
    buttons.forEach((b) => b.classList.toggle("active", b === target));
  }
}

function renderFilmstrip(mediaForDay) {
  if (mediaForDay.length === 0) return "";
  return `<div class="filmstrip">${mediaForDay
    .map(
      (m) => `<div class="film-item" data-media-index="${m._index}">
        <img src="${m.thumb}" alt="${m.caption || ""}">
        ${m.type === "video" ? '<span class="play-icon">▶</span>' : ""}
      </div>`
    )
    .join("")}</div>`;
}

function renderDetailForDay(track, mediaForDay) {
  const el = document.getElementById("detail");
  const extraStatsHtml = EXTRA_STATS.filter((s) => track[s.key] != null)
    .map((s) => `<div><span>${s.label}</span>${s.fmt(track[s.key])}</div>`)
    .join("");
  el.innerHTML = `
    <span class="detail-badge" style="--day-color:${track.color}">Jour ${track.dayNumber} / ${tripDayCount}</span>
    <h2>${track.label}</h2>
    <p class="detail-date">${formatDate(track.date)}</p>
    ${track.description ? `<p class="detail-description">${track.description}</p>` : ""}
    <div class="detail-stats">
      <div><span>Distance</span>${track.distanceKm} km</div>
      <div><span>Dénivelé +</span>${track.elevationGainM} m</div>
      <div><span>Dénivelé -</span>${track.elevationLossM} m</div>
      <div><span>Durée</span>${formatDuration(track.durationS)}</div>
    </div>
    ${extraStatsHtml ? `<div class="detail-stats detail-stats-extra">${extraStatsHtml}</div>` : ""}
    <div class="day-chart" id="day-chart" data-track-id="${track.id}"></div>
    ${renderFilmstrip(mediaForDay)}
  `;
  el.querySelectorAll("[data-media-index]").forEach((item) => {
    item.addEventListener("click", () => openLightbox(parseInt(item.dataset.mediaIndex, 10)));
  });
  mountDayChart(track.id);
}

// ---------- Courbes par jour (données Garmin : altitude, vitesse, FC, cadence, température) ----------
const METRICS = {
  ele:   { label: "Altitude",   color: "#3C5C3F", fill: true,  fmt: (v) => `${Math.round(v)} m` },
  speed: { label: "Vitesse",    color: "#4A6572", fill: false, fmt: (v) => `${v.toFixed(1)} km/h` },
  hr:    { label: "Fréq. card.", color: "#C1442D", fill: false, fmt: (v) => `${Math.round(v)} bpm` },
  cad:   { label: "Cadence",    color: "#8a6d3b", fill: false, fmt: (v) => `${Math.round(v)} pas/min` },
  temp:  { label: "Temp. poignet", color: "#c77d33", fill: false, fmt: (v) => `${Math.round(v)}°C`,
           note: "Température mesurée au poignet par la montre — influencée par la chaleur du corps, ce n'est pas la température de l'air." },
};
const METRIC_ORDER = ["ele", "speed", "hr", "cad", "temp"];
const seriesCache = {};

async function loadSeries(id) {
  if (id in seriesCache) return seriesCache[id];
  try {
    const s = await fetch(`data/series/${id}.json`).then((r) => (r.ok ? r.json() : null));
    seriesCache[id] = s;
  } catch {
    seriesCache[id] = null;
  }
  return seriesCache[id];
}

async function mountDayChart(id) {
  if (!document.getElementById("day-chart")) return;
  const s = await loadSeries(id);
  const host = document.getElementById("day-chart");
  if (!host || host.dataset.trackId !== id) return; // l'utilisateur a changé de jour
  if (!s || !s.metrics || !s.metrics.length) { host.remove(); return; }

  const order = METRIC_ORDER.filter((m) => s.metrics.includes(m));
  let current = order[0];
  let activity = "";
  if (s.movingS != null && s.pauseS != null) {
    const tot = s.movingS + s.pauseS || 1;
    const movePct = Math.round((s.movingS / tot) * 100);
    activity = `<div class="day-activity" title="Pauses = arrêts + temps « sur place » (GPS qui tourne sans progresser)">
      <div class="day-activity-bar"><span style="width:${movePct}%"></span></div>
      <div class="day-activity-legend">
        <span class="dal-move"><b>${formatDuration(s.movingS)}</b> de marche</span>
        <span class="dal-pause"><b>${formatDuration(s.pauseS)}</b> de pause</span>
      </div>
    </div>`;
  }
  host.innerHTML = `
    <div class="day-chart-head">
      <span class="day-chart-title">Données de la montre</span>
      <div class="day-chart-tabs">${order
        .map((m) => `<button class="dc-tab${m === current ? " active" : ""}" data-metric="${m}">${METRICS[m].label}</button>`)
        .join("")}</div>
    </div>
    ${activity}
    <div class="day-chart-plot">
      <svg class="day-chart-svg" viewBox="0 0 1000 140" preserveAspectRatio="none" aria-hidden="true"></svg>
      <div class="day-chart-range"></div>
    </div>
    <div class="day-chart-axis"><span>0 km</span><span class="day-chart-dist"></span></div>
    <p class="day-chart-note" hidden></p>
  `;
  renderDayMetric(host, s, current);
  host.querySelectorAll(".dc-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      current = btn.dataset.metric;
      host.querySelectorAll(".dc-tab").forEach((b) => b.classList.toggle("active", b === btn));
      renderDayMetric(host, s, current);
    });
  });
}

function renderDayMetric(host, series, metric) {
  const meta = METRICS[metric];
  const pts = series.points;
  const totalD = pts[pts.length - 1].d || 1;
  const vp = [];
  pts.forEach((p, i) => {
    if (p[metric] != null) vp.push({ x: (p.d / totalD) * 1000, v: p[metric], gap: p.gap, idx: i });
  });
  const svg = host.querySelector(".day-chart-svg");
  if (vp.length < 2) { svg.innerHTML = ""; return; }

  const vals = vp.map((o) => o.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) max = min + 1;
  const H = 140, pad = 10, base = H - pad, plotH = H - 2 * pad;
  const Y = (v) => pad + (1 - (v - min) / (max - min)) * plotH;

  let solid = `M ${vp[0].x.toFixed(1)},${Y(vp[0].v).toFixed(1)}`;
  let dotted = "";
  for (let k = 1; k < vp.length; k++) {
    const a = vp[k - 1], b = vp[k];
    const gap = b.gap || b.idx - a.idx > 1;
    if (gap) {
      dotted += ` M ${a.x.toFixed(1)},${Y(a.v).toFixed(1)} L ${b.x.toFixed(1)},${Y(b.v).toFixed(1)}`;
      solid += ` M ${b.x.toFixed(1)},${Y(b.v).toFixed(1)}`;
    } else {
      solid += ` L ${b.x.toFixed(1)},${Y(b.v).toFixed(1)}`;
    }
  }
  const area = meta.fill
    ? `<path d="M ${vp[0].x.toFixed(1)},${base} L ${vp.map((o) => `${o.x.toFixed(1)},${Y(o.v).toFixed(1)}`).join(" L ")} L ${vp[vp.length - 1].x.toFixed(1)},${base} Z" fill="${meta.color}" opacity="0.14"/>`
    : "";
  svg.innerHTML = `
    ${area}
    <path d="${solid}" fill="none" stroke="${meta.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${dotted ? `<path d="${dotted}" fill="none" stroke="${meta.color}" stroke-width="2" stroke-dasharray="3 4" opacity="0.7" vector-effect="non-scaling-stroke"/>` : ""}
  `;
  host.querySelector(".day-chart-range").innerHTML = `<span>${meta.fmt(max)}</span><span>${meta.fmt(min)}</span>`;
  host.querySelector(".day-chart-dist").textContent = `${totalD.toFixed(1)} km`;
  const note = host.querySelector(".day-chart-note");
  note.textContent = meta.note || "";
  note.hidden = !meta.note;
}

function renderDetailOverview(manifest) {
  const el = document.getElementById("detail");
  const daysHtml = manifest.tracks
    .map(
      (t) => `<li>
        <button class="day-row" data-day-id="${t.id}" style="--day-color:${t.color}">
          <span class="day-row-index">J${t.dayNumber}</span>
          <span class="day-row-body">
            <span class="day-row-title">${t.label}</span>
            <span class="day-row-meta">${formatDateShort(t.date)} · ${t.distanceKm} km · +${t.elevationGainM} m</span>
          </span>
        </button>
      </li>`
    )
    .join("");
  el.innerHTML = `
    <h2>${manifest.trip.title || "La randonnée"}</h2>
    <p class="detail-description">${manifest.trip.intro || ""}</p>
    <div class="detail-stats">
      <div><span>Distance totale</span>${manifest.stats.totalDistanceKm} km</div>
      <div><span>Dénivelé total</span>+${manifest.stats.totalElevationGainM} m</div>
      <div><span>Jours</span>${manifest.stats.dayCount}</div>
      <div><span>Photos</span>${manifest.photos.length}</div>
      <div><span>Vidéos</span>${manifest.videos.length}</div>
    </div>
    <p class="day-list-title">Les étapes</p>
    <ol class="day-list">${daysHtml}</ol>
  `;
  el.querySelectorAll("[data-day-id]").forEach((b) => {
    b.addEventListener("click", () => {
      const tab = document.querySelector(`.day-tab[data-track-id="${b.dataset.dayId}"]`);
      if (tab) tab.click();
    });
  });
}

function renderDetailLiaisons(manifest) {
  const el = document.getElementById("detail");
  el.innerHTML = `
    <h2>Liaisons</h2>
    <ul class="bus-list">
      ${manifest.liaisons
        .map((l) => {
          const style = LIAISON_STYLES[l.mode] || LIAISON_STYLES.bus;
          return `<li>
            <div class="bus-route">${style.icon} ${l.from.name} → ${l.to.name}</div>
            <div class="bus-date">${style.label} · ${formatDate(l.date)}${l.note ? " · " + l.note : ""}</div>
          </li>`;
        })
        .join("")}
    </ul>
  `;
}

function formatMediaMeta(media) {
  const parts = [];
  if (media.altitudeM != null) parts.push(`${media.altitudeM} m`);
  if (media.direction != null) parts.push(`${media.direction}° ${media.directionCompass || ""}`.trim());
  if (media.camera) parts.push(media.camera);
  const settings = [media.aperture, media.shutterSpeed, media.iso ? `ISO ${media.iso}` : null, media.focalLength]
    .filter(Boolean)
    .join(" · ");
  if (settings) parts.push(settings);
  return parts.join(" · ");
}

let allMedia = [];
let tripDayCount = 0;

function preloadNeighbor(i) {
  const m = allMedia[((i % allMedia.length) + allMedia.length) % allMedia.length];
  if (m && m.type !== "video") {
    const img = new Image();
    img.src = m.file;
  }
}

function openLightbox(index) {
  const lb = document.getElementById("lightbox");
  const media = allMedia[index];
  if (!media) return;
  const img = document.getElementById("lightbox-img");
  const video = document.getElementById("lightbox-video");

  if (media.type === "video") {
    video.src = media.file;
    video.poster = media.thumb;
    video.hidden = false;
    img.hidden = true;
    img.removeAttribute("src");
  } else {
    img.src = media.file;
    img.alt = media.caption || "";
    img.hidden = false;
    video.hidden = true;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  document.getElementById("lightbox-caption-text").textContent = media.caption || "";
  document.getElementById("lightbox-date").textContent = media.date ? formatDate(media.date) : "";
  document.getElementById("lightbox-meta").textContent = formatMediaMeta(media);
  document.getElementById("lightbox-counter").textContent = `${index + 1} / ${allMedia.length}`;
  lb.dataset.index = index;
  lb.hidden = false;

  updateLightboxMiniMap(media);
  preloadNeighbor(index + 1);
  preloadNeighbor(index - 1);
}

let miniMap = null;
let miniMapMarker = null;
function updateLightboxMiniMap(media) {
  const container = document.getElementById("lightbox-minimap");
  if (media.lat == null || media.lon == null) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  // Créée au premier usage : un conteneur caché (display:none) donnerait à Leaflet une taille de 0x0.
  if (!miniMap) {
    miniMap = L.map(container, {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      keyboard: false,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OSM",
    }).addTo(miniMap);
  }

  const latlng = [media.lat, media.lon];
  miniMap.setView(latlng, 14);
  if (miniMapMarker) {
    miniMapMarker.setLatLng(latlng);
  } else {
    miniMapMarker = L.marker(latlng).addTo(miniMap);
  }
  requestAnimationFrame(() => miniMap.invalidateSize());
}

function setupLightbox() {
  const lb = document.getElementById("lightbox");
  const video = document.getElementById("lightbox-video");
  const close = () => {
    lb.hidden = true;
    video.pause();
  };
  document.getElementById("lightbox-close").addEventListener("click", close);
  lb.addEventListener("click", (e) => { if (e.target === lb) close(); });
  document.getElementById("lightbox-prev").addEventListener("click", () => step(-1));
  document.getElementById("lightbox-next").addEventListener("click", () => step(1));
  function step(dir) {
    const idx = (parseInt(lb.dataset.index, 10) + dir + allMedia.length) % allMedia.length;
    openLightbox(idx);
  }
  document.addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  // Navigation par glissement (mobile)
  let touchX = null, touchY = null;
  lb.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = touchY = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      step(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
}

// Cale la zone carte + détail pour qu'elle remplisse pile la hauteur restante de
// l'écran (l'ensemble tient dans un viewport). Sous 900px on laisse couler (mobile).
function fitLayout() {
  const layout = document.querySelector(".layout");
  if (!layout) return;
  if (window.innerWidth <= 900) { layout.style.height = ""; return; }
  const footer = document.querySelector(".site-footer");
  const top = layout.getBoundingClientRect().top + window.scrollY;
  const footerH = footer ? footer.offsetHeight : 0;
  layout.style.height = `${Math.max(window.innerHeight - top - footerH - 6, 360)}px`;
}

async function init() {
  setupLightbox();

  const manifest = await fetch("data/manifest.json").then((r) => r.json());
  const pois = await fetch("data/pois.json").then((r) => r.json()).then((d) => d.pois || []).catch(() => []);
  manifest.tracks.forEach((t, i) => (t.dayNumber = i + 1));
  tripDayCount = manifest.tracks.length;
  renderHero(manifest);

  allMedia = [
    ...manifest.photos.map((p) => ({ ...p, type: "photo" })),
    ...manifest.videos.map((v) => ({ ...v, type: "video", thumb: v.poster })),
  ];
  allMedia.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  allMedia.forEach((m, i) => (m._index = i));

  const map = L.map("map", { scrollWheelZoom: false });

  const baseLayers = {
    "Relief (topo)": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution:
        'Fond de carte © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), données © OpenStreetMap',
    }),
    "Plan": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    "Satellite": L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagerie © Esri, Maxar, Earthstar Geographics" }
    ),
  };
  baseLayers["Plan"].addTo(map);
  L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);

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

  const transfers = buildTransfers(manifest, tracksWithPoints);
  renderElevationProfile(tracksWithPoints, transfers);
  setupProfileInteraction(map, pois);

  const liaisonLayers = [];
  manifest.liaisons.forEach((liaison) => {
    const style = LIAISON_STYLES[liaison.mode] || LIAISON_STYLES.bus;
    const from = [liaison.from.lat, liaison.from.lon];
    const to = [liaison.to.lat, liaison.to.lon];
    const line = L.polyline([from, to], { color: style.color, weight: 3, dashArray: style.dashArray }).addTo(map);
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    L.marker(mid, {
      icon: L.divIcon({ className: "", html: `<div class="bus-marker">${style.icon}</div>`, iconSize: [26, 26] }),
    }).addTo(map).bindPopup(`${style.label} · ${liaison.from.name} → ${liaison.to.name}`);
    liaisonLayers.push(line);
    allBounds.push(from, to);
  });

  const cluster = L.markerClusterGroup({ maxClusterRadius: 40 });
  allMedia.forEach((media) => {
    const icon = L.divIcon({
      className: "",
      html:
        media.type === "video"
          ? `<div class="photo-marker video-marker" style="background-image:url('${media.thumb}')"><span class="play-icon">▶</span></div>`
          : `<div class="photo-marker" style="background-image:url('${media.thumb}')"></div>`,
      iconSize: [38, 38],
    });
    const marker = L.marker([media.lat, media.lon], { icon });
    marker.on("click", () => openLightbox(media._index));
    cluster.addLayer(marker);
    allBounds.push([media.lat, media.lon]);
  });
  map.addLayer(cluster);

  if (allBounds.length) map.fitBounds(allBounds, { padding: [30, 30] });

  function mediaForTrack(track) {
    if (!track.date) return [];
    return allMedia.filter((m) => m.date && m.date.slice(0, 10) === track.date);
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
      renderDetailForDay(track, mediaForTrack(track));
    },
    () => {
      resetOpacity(null);
      if (allBounds.length) map.fitBounds(allBounds, { padding: [30, 30] });
      renderDetailOverview(manifest);
    },
    () => {
      resetOpacity(null);
      if (liaisonLayers.length) {
        const group = L.featureGroup(liaisonLayers);
        map.fitBounds(group.getBounds(), { padding: [40, 40] });
      }
      renderDetailLiaisons(manifest);
    }
  );

  renderDetailOverview(manifest);

  fitLayout();
  map.invalidateSize();
  window.addEventListener("resize", () => {
    fitLayout();
    map.invalidateSize();
  });
}

maybeInit();
