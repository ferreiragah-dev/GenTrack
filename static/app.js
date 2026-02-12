const els = {
  form: document.getElementById("target-form"),
  name: document.getElementById("name"),
  url: document.getElementById("url"),
  interval: document.getElementById("interval_seconds"),
  timeout: document.getElementById("timeout_seconds"),
  expectedSubstring: document.getElementById("expected_substring"),
  expectedJsonKeys: document.getElementById("expected_json_keys"),
  maxLatencyMs: document.getElementById("max_latency_ms"),
  message: document.getElementById("form-message"),
  kpiTotal: document.getElementById("kpi-total"),
  kpiUp: document.getElementById("kpi-up"),
  kpiDown: document.getElementById("kpi-down"),
  kpiUptime: document.getElementById("kpi-uptime"),
  kpiLastFailure: document.getElementById("kpi-last-failure"),
  kpiMttr: document.getElementById("kpi-mttr"),
  kpiMtbf: document.getElementById("kpi-mtbf"),
  kpiIncDay: document.getElementById("kpi-inc-day"),
  kpiIncWeek: document.getElementById("kpi-inc-week"),
  kpiIncMonth: document.getElementById("kpi-inc-month"),
  targetsBody: document.getElementById("targets-body"),
  historyTitle: document.getElementById("history-title"),
  historyBody: document.getElementById("history-body"),
  incidentsBody: document.getElementById("incidents-body"),
  uptimeChart: document.getElementById("uptime-chart"),
  latencyChart: document.getElementById("latency-chart"),
  trendChart: document.getElementById("trend-chart"),
  trendTitle: document.getElementById("trend-title"),
  refreshStatus: document.getElementById("refresh-status"),
  refreshNow: document.getElementById("refresh-now"),
  siteSelect: document.getElementById("site-select"),
  sideButtons: document.querySelectorAll(".side-item[data-view]"),
  views: document.querySelectorAll(".view"),
  pageTitle: document.getElementById("page-title"),
  pageCrumb: document.getElementById("page-crumb"),
  dbForm: document.getElementById("db-target-form"),
  dbName: document.getElementById("db_name"),
  dbEngine: document.getElementById("db_engine"),
  dbHost: document.getElementById("db_host"),
  dbPort: document.getElementById("db_port"),
  dbDatabaseName: document.getElementById("db_database_name"),
  dbUsername: document.getElementById("db_username"),
  dbPassword: document.getElementById("db_password"),
  dbSslmode: document.getElementById("db_sslmode"),
  dbIntervalSeconds: document.getElementById("db_interval_seconds"),
  dbTimeoutSeconds: document.getElementById("db_timeout_seconds"),
  dbFormMessage: document.getElementById("db-form-message"),
  dbTargetsBody: document.getElementById("db-targets-body"),
  dbHistoryTitle: document.getElementById("db-history-title"),
  dbHistoryBody: document.getElementById("db-history-body"),
};

const AUTO_REFRESH_SECONDS = 15;

const state = {
  targets: [],
  history: [],
  incidents: [],
  reliability: null,
  selectedTargetId: null,
  selectedTargetName: "",
  refreshCountdown: AUTO_REFRESH_SECONDS,
  activeView: "observability",
  dbTargets: [],
  dbSelectedTargetId: null,
  dbSelectedTargetName: "",
  selectedEntityType: "site",
};

const fmtDate = (iso) => {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("pt-BR");
};

const fmtUptime = (value) => (value == null ? "--" : `${value.toFixed(2)}%`);
const fmtLatency = (value) => (value == null ? "--" : `${value} ms`);
const fmtDuration = (seconds) => {
  if (seconds == null) return "--";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
};

const statusLabel = (isUp) => {
  if (isUp === true) return { text: "UP", css: "up" };
  if (isUp === false) return { text: "DOWN", css: "down" };
  return { text: "SEM DADOS", css: "" };
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Erro ${response.status}`);
  return payload;
}

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(180, Math.floor(rect.height));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function drawEmptyChart(canvas, text) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(143, 160, 184, 0.85)";
  ctx.font = "600 14px Rajdhani, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height / 2);
}

function drawBarChart(canvas, labels, values, { suffix = "", maxValue = null, color = "#ff9f0a" } = {}) {
  if (!labels.length) return drawEmptyChart(canvas, "Sem dados");
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { top: 14, right: 12, bottom: 54, left: 12 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(maxValue ?? 0, ...values, 1);
  const barW = (innerW / labels.length) * 0.62;
  const gap = (innerW / labels.length) * 0.38;

  ctx.clearRect(0, 0, width, height);
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (innerH / 4) * i;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  labels.forEach((label, i) => {
    const value = values[i] ?? 0;
    const x = pad.left + i * (barW + gap) + gap / 2;
    const h = (value / max) * innerH;
    const y = pad.top + innerH - h;
    const gradient = ctx.createLinearGradient(0, y, 0, y + h);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "rgba(255, 140, 0, 0.35)");
    ctx.fillStyle = gradient;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, 5);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barW, h);
    }
    ctx.fillStyle = "#d9e4f2";
    ctx.font = "600 12px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(value)}${suffix}`, x + barW / 2, y - 6);
    ctx.fillStyle = "#93a6c1";
    const short = label.length > 14 ? `${label.slice(0, 11)}...` : label;
    ctx.fillText(short, x + barW / 2, height - 18);
  });
}

function drawLineChart(canvas, labels, values, color = "#ff9f0a") {
  if (!labels.length) return drawEmptyChart(canvas, "Sem dados");
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { top: 16, right: 14, bottom: 36, left: 20 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(1, max - min);

  ctx.clearRect(0, 0, width, height);
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (innerH / 4) * i;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  const points = values.map((value, i) => {
    const x = pad.left + (i / Math.max(1, values.length - 1)) * innerW;
    const y = pad.top + innerH - ((value - min) / range) * innerH;
    return { x, y, label: labels[i] };
  });

  const fill = ctx.createLinearGradient(0, pad.top, 0, pad.top + innerH);
  fill.addColorStop(0, "rgba(255, 159, 10, 0.28)");
  fill.addColorStop(1, "rgba(255, 159, 10, 0.02)");

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.lineTo(points[points.length - 1].x, pad.top + innerH);
  ctx.lineTo(points[0].x, pad.top + innerH);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function setActiveView(view) {
  const labels = {
    observability: ["Observabilidade Web", "General / GenTrack Uptime"],
    sites: ["Sites Monitorados", "General / Sites"],
    database: ["Monitoramento de Banco", "General / Database"],
    alerts: ["Alertas", "General / Alertas"],
    errors: ["Erros", "General / Erros"],
    config: ["Configuracoes", "General / Config"],
  };
  state.activeView = view;
  els.sideButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  els.views.forEach((panel) => panel.classList.toggle("hidden", panel.id !== `view-${view}`));
  const [title, crumb] = labels[view] || labels.observability;
  els.pageTitle.textContent = title;
  els.pageCrumb.textContent = crumb;
}

function getSelectedTarget() {
  return state.targets.find((t) => Number(t.id) === Number(state.selectedTargetId)) || null;
}

function getSelectedDbTarget() {
  return state.dbTargets.find((t) => Number(t.id) === Number(state.selectedTargetId)) || null;
}

function renderSiteSelect() {
  const options = [
    ...state.targets.map((t) => ({ key: `site:${t.id}`, label: `[Site] ${t.name}`, type: "site", id: Number(t.id) })),
    ...state.dbTargets.map((t) => ({ key: `db:${t.id}`, label: `[Banco] ${t.name}`, type: "db", id: Number(t.id) })),
  ];

  els.siteSelect.innerHTML = options.length
    ? options.map((o) => `<option value="${o.key}">${o.label}</option>`).join("")
    : '<option value="">Sem alvos cadastrados</option>';

  if (!options.length) {
    state.selectedTargetId = null;
    state.selectedTargetName = "";
    state.selectedEntityType = "site";
    return;
  }

  const previousKey = state.selectedTargetId != null ? `${state.selectedEntityType}:${state.selectedTargetId}` : null;
  const selectedOption = options.find((o) => o.key === previousKey) || options[0];
  state.selectedEntityType = selectedOption.type;
  state.selectedTargetId = selectedOption.id;
  state.selectedTargetName = selectedOption.label.replace(/^\[(Site|Banco)\]\s*/, "");
  els.siteSelect.value = selectedOption.key;
}

function renderTargetsTable(targets) {
  if (!targets.length) {
    els.targetsBody.innerHTML = `<tr><td colspan="8">Nenhum alvo cadastrado.</td></tr>`;
    return;
  }

  els.targetsBody.innerHTML = targets
    .map((target) => {
      const status = statusLabel(target.last_is_up);
      return `
        <tr>
          <td>${target.name}</td>
          <td><a href="${target.url}" target="_blank" rel="noreferrer">${target.url}</a></td>
          <td><span class="status ${status.css}">${status.text}</span></td>
          <td>${target.last_status_code ?? "--"}</td>
          <td>${fmtLatency(target.last_latency_ms)}</td>
          <td>${fmtUptime(target.uptime_24h)}</td>
          <td>${fmtDate(target.last_checked_at)}</td>
          <td>
            <div class="actions">
              <button data-action="check" data-id="${target.id}">Check</button>
              <button data-action="open" data-id="${target.id}">Abrir</button>
              <button data-action="delete" data-id="${target.id}">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderSelectedKpis() {
  const selected = state.selectedEntityType === "db" ? getSelectedDbTarget() : getSelectedTarget();
  if (!selected) {
    els.kpiTotal.textContent = "--";
    els.kpiUp.textContent = "--";
    els.kpiDown.textContent = "--";
    els.kpiUptime.textContent = "--";
    els.kpiLastFailure.textContent = "--";
    els.kpiMttr.textContent = "--";
    els.kpiMtbf.textContent = "--";
    els.kpiIncDay.textContent = "--";
    els.kpiIncWeek.textContent = "--";
    els.kpiIncMonth.textContent = "--";
    return;
  }

  els.kpiTotal.textContent = selected.last_is_up === true ? "UP" : selected.last_is_up === false ? "DOWN" : "--";
  els.kpiUp.textContent = state.selectedEntityType === "db" ? selected.engine?.toUpperCase() || "DB" : selected.last_status_code ?? "--";
  els.kpiDown.textContent = selected.last_latency_ms != null ? `${selected.last_latency_ms} ms` : "--";
  if (state.selectedEntityType === "db") {
    const history = state.history || [];
    const uptime = history.length
      ? (history.filter((h) => h.is_up).length / history.length) * 100
      : null;
    const now = new Date();
    const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const failures = history.filter((h) => h.is_up === false);
    const lastFailure = failures.length ? failures[0] : null;
    const countInWindow = (sinceMs) =>
      failures.filter((f) => new Date(f.checked_at).getTime() >= sinceMs).length;

    els.kpiUptime.textContent = uptime == null ? "--" : `${uptime.toFixed(2)}%`;
    els.kpiLastFailure.textContent = lastFailure ? fmtDate(lastFailure.checked_at) : "--";
    els.kpiMttr.textContent = "--";
    els.kpiMtbf.textContent = "--";
    els.kpiIncDay.textContent = String(countInWindow(dayAgo));
    els.kpiIncWeek.textContent = String(countInWindow(weekAgo));
    els.kpiIncMonth.textContent = String(countInWindow(monthAgo));
    return;
  }

  els.kpiUptime.textContent = fmtUptime(selected.uptime_24h);
  const rel = state.reliability;
  els.kpiLastFailure.textContent = rel?.last_incident?.started_at ? fmtDate(rel.last_incident.started_at) : "--";
  els.kpiMttr.textContent = fmtDuration(rel?.mttr_seconds);
  els.kpiMtbf.textContent = fmtDuration(rel?.mtbf_seconds);
  els.kpiIncDay.textContent = String(rel?.incidents_day ?? "--");
  els.kpiIncWeek.textContent = String(rel?.incidents_week ?? "--");
  els.kpiIncMonth.textContent = String(rel?.incidents_month ?? "--");
}

function renderHistoryTable(history) {
  const emptyLabel = state.selectedEntityType === "db" ? "Sem historico para esse banco." : "Sem historico para esse site.";
  if (!history.length) {
    els.historyBody.innerHTML = `<tr><td colspan="5">${emptyLabel}</td></tr>`;
    return;
  }

  if (state.selectedEntityType === "db") {
    els.historyBody.innerHTML = history
      .map((item) => {
        const status = statusLabel(item.is_up);
        return `
          <tr>
            <td>${fmtDate(item.checked_at)}</td>
            <td><span class="status ${status.css}">${status.text}</span></td>
            <td>--</td>
            <td>${fmtLatency(item.latency_ms)}</td>
            <td>${item.error_message || "--"}</td>
          </tr>
        `;
      })
      .join("");
    return;
  }

  els.historyBody.innerHTML = history
    .map((item) => {
      const status = statusLabel(item.is_up);
      return `
        <tr>
          <td>${fmtDate(item.checked_at)}</td>
          <td><span class="status ${status.css}">${status.text}</span></td>
          <td>${item.status_code ?? "--"}</td>
          <td>${fmtLatency(item.latency_ms)}</td>
          <td>${item.error_message || item.reason_code || "--"}</td>
        </tr>
      `;
    })
    .join("");
}

function renderIncidentsTable(incidents) {
  if (state.selectedEntityType === "db") {
    els.incidentsBody.innerHTML = `<tr><td colspan="5">Incidentes detalhados disponiveis apenas para sites HTTP.</td></tr>`;
    return;
  }
  if (!incidents.length) {
    els.incidentsBody.innerHTML = `<tr><td colspan="5">Sem incidentes registrados.</td></tr>`;
    return;
  }
  els.incidentsBody.innerHTML = incidents
    .map((inc) => {
      const status = inc.is_resolved ? "Resolvido" : "Aberto";
      return `
        <tr>
          <td>${fmtDate(inc.started_at)}</td>
          <td>${fmtDate(inc.ended_at)}</td>
          <td>${fmtDuration(inc.duration_seconds)}</td>
          <td>${inc.reason_message || inc.reason_code || "--"}</td>
          <td>${status}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSelectedCharts() {
  if (!state.history.length) {
    drawEmptyChart(els.uptimeChart, "Sem dados");
    drawEmptyChart(els.latencyChart, "Sem dados");
    drawEmptyChart(els.trendChart, "Sem dados");
    return;
  }

  const sorted = [...state.history].sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at)).slice(-30);
  const labels = sorted.map((item) =>
    new Date(item.checked_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
  );

  drawBarChart(els.uptimeChart, labels, sorted.map((item) => (item.is_up ? 100 : 0)), {
    suffix: "%",
    maxValue: 100,
    color: "#73d07d",
  });

  if (state.selectedEntityType === "db") {
    drawLineChart(
      els.latencyChart,
      labels,
      sorted.map((item) => (item.is_up ? 1 : 0)),
      "#78a9ff"
    );
  } else {
    drawLineChart(
      els.latencyChart,
      labels,
      sorted.map((item) => item.status_code ?? 0),
      "#78a9ff"
    );
  }

  drawLineChart(
    els.trendChart,
    labels,
    sorted.map((item) => item.latency_ms ?? 0),
    "#ff9f0a"
  );
}

async function loadSelectedDetails() {
  if (!state.selectedTargetId) {
    state.history = [];
    state.incidents = [];
    state.reliability = null;
    els.historyTitle.textContent = "Selecione um site para carregar o historico.";
    els.trendTitle.textContent = "Tendencia de latencia";
    renderHistoryTable([]);
    renderIncidentsTable([]);
    renderSelectedCharts();
    renderSelectedKpis();
    return;
  }

  if (state.selectedEntityType === "db") {
    const history = await api(`/api/db-targets/${state.selectedTargetId}/history?limit=80`);
    state.history = history || [];
    state.reliability = null;
    state.incidents = [];
    els.historyTitle.textContent = `Historico de ${state.selectedTargetName}`;
    els.trendTitle.textContent = `Tendencia de latencia - ${state.selectedTargetName}`;
    renderHistoryTable(state.history);
    renderIncidentsTable(state.incidents);
    renderSelectedCharts();
    renderSelectedKpis();
    return;
  }

  const [history, reliability, incidents] = await Promise.all([
    api(`/api/targets/${state.selectedTargetId}/history?limit=80`),
    api(`/api/targets/${state.selectedTargetId}/reliability`),
    api(`/api/targets/${state.selectedTargetId}/incidents?limit=80`),
  ]);

  state.history = history || [];
  state.reliability = reliability || null;
  state.incidents = incidents || [];

  els.historyTitle.textContent = `Historico de ${state.selectedTargetName}`;
  els.trendTitle.textContent = `Tendencia de latencia - ${state.selectedTargetName}`;
  renderHistoryTable(state.history);
  renderIncidentsTable(state.incidents);
  renderSelectedCharts();
  renderSelectedKpis();
}

async function refreshDashboard() {
  const [siteDashboard, dbTargets] = await Promise.all([api("/api/dashboard"), api("/api/db-targets")]);
  state.targets = siteDashboard.targets || [];
  state.dbTargets = dbTargets || [];
  renderTargetsTable(state.targets);
  renderDbTargetsTable(state.dbTargets);
  renderSiteSelect();
  await loadSelectedDetails();
}

function renderDbTargetsTable(targets) {
  if (!targets.length) {
    els.dbTargetsBody.innerHTML = `<tr><td colspan="6">Nenhum monitor de banco cadastrado.</td></tr>`;
    return;
  }

  els.dbTargetsBody.innerHTML = targets
    .map((target) => {
      const status = statusLabel(target.last_is_up);
      return `
        <tr>
          <td>${target.name}</td>
          <td>${target.host}:${target.port}/${target.database_name}</td>
          <td><span class="status ${status.css}">${status.text}</span></td>
          <td>${fmtLatency(target.last_latency_ms)}</td>
          <td>${fmtDate(target.last_checked_at)}</td>
          <td>
            <div class="actions">
              <button data-db-action="check" data-id="${target.id}">Check</button>
              <button data-db-action="history" data-id="${target.id}" data-name="${target.name}">Histórico</button>
              <button data-db-action="delete" data-id="${target.id}">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function loadDbHistory(dbTargetId, dbTargetName) {
  const history = await api(`/api/db-targets/${dbTargetId}/history?limit=80`);
  state.dbSelectedTargetId = Number(dbTargetId);
  state.dbSelectedTargetName = dbTargetName;
  state.selectedEntityType = "db";
  state.selectedTargetId = Number(dbTargetId);
  state.selectedTargetName = dbTargetName;
  const key = `db:${dbTargetId}`;
  if ([...els.siteSelect.options].some((opt) => opt.value === key)) {
    els.siteSelect.value = key;
  }
  els.dbHistoryTitle.textContent = `Histórico de ${dbTargetName}`;

  if (!history.length) {
    els.dbHistoryBody.innerHTML = `<tr><td colspan="4">Sem histórico para esse banco.</td></tr>`;
    return;
  }

  els.dbHistoryBody.innerHTML = history
    .map((item) => {
      const status = statusLabel(item.is_up);
      return `
        <tr>
          <td>${fmtDate(item.checked_at)}</td>
          <td><span class="status ${status.css}">${status.text}</span></td>
          <td>${fmtLatency(item.latency_ms)}</td>
          <td>${item.error_message || "--"}</td>
        </tr>
      `;
    })
    .join("");
}

async function refreshDbTargets() {
  const data = await api("/api/db-targets");
  state.dbTargets = data || [];
  renderDbTargetsTable(state.dbTargets);
  renderSiteSelect();

  if (state.dbSelectedTargetId != null) {
    const selected = state.dbTargets.find((t) => Number(t.id) === Number(state.dbSelectedTargetId));
    if (!selected) {
      state.dbSelectedTargetId = null;
      state.dbSelectedTargetName = "";
      els.dbHistoryTitle.textContent = 'Clique em "Histórico" em um banco.';
      els.dbHistoryBody.innerHTML = `<tr><td colspan="4">Sem histórico para esse banco.</td></tr>`;
      return;
    }
    await loadDbHistory(selected.id, selected.name);
  }

  if (state.activeView === "observability") {
    await loadSelectedDetails();
  }
}

async function createTarget(event) {
  event.preventDefault();
  els.message.textContent = "";

  const maxLatencyRaw = (els.maxLatencyMs.value || "").trim();
  const payload = {
    name: els.name.value,
    url: els.url.value,
    interval_seconds: Number(els.interval.value),
    timeout_seconds: Number(els.timeout.value),
    expected_substring: (els.expectedSubstring.value || "").trim() || null,
    expected_json_keys: (els.expectedJsonKeys.value || "").trim() || null,
    max_latency_ms: maxLatencyRaw ? Number(maxLatencyRaw) : null,
  };

  try {
    await api("/api/targets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.form.reset();
    els.interval.value = "60";
    els.timeout.value = "8";
    els.message.textContent = "Alvo cadastrado com sucesso.";
    await refreshDashboard();
  } catch (err) {
    els.message.textContent = err.message;
  }
}

async function createDbTarget(event) {
  event.preventDefault();
  els.dbFormMessage.textContent = "";

  const payload = {
    name: (els.dbName.value || "").trim(),
    engine: (els.dbEngine.value || "postgres").trim(),
    host: (els.dbHost.value || "").trim(),
    port: Number(els.dbPort.value),
    database_name: (els.dbDatabaseName.value || "").trim(),
    username: (els.dbUsername.value || "").trim(),
    password: els.dbPassword.value || "",
    sslmode: (els.dbSslmode.value || "disable").trim(),
    interval_seconds: Number(els.dbIntervalSeconds.value),
    timeout_seconds: Number(els.dbTimeoutSeconds.value),
  };

  try {
    await api("/api/db-targets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.dbForm.reset();
    els.dbPort.value = "5432";
    els.dbIntervalSeconds.value = "60";
    els.dbTimeoutSeconds.value = "5";
    els.dbEngine.value = "postgres";
    els.dbSslmode.value = "disable";
    els.dbFormMessage.textContent = "Monitor de banco cadastrado com sucesso.";
    await refreshDbTargets();
  } catch (err) {
    els.dbFormMessage.textContent = err.message;
  }
}

async function deleteTarget(targetId) {
  await api(`/api/targets/${targetId}`, { method: "DELETE" });
  if (Number(state.selectedTargetId) === Number(targetId)) {
    state.selectedTargetId = null;
    state.selectedTargetName = "";
  }
  await refreshDashboard();
}

async function checkTarget(targetId) {
  await api(`/api/targets/${targetId}/check`, { method: "POST" });
  await refreshDashboard();
}

async function handleTargetsClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const targetId = Number(button.dataset.id);

  try {
    if (action === "delete") {
      await deleteTarget(targetId);
    } else if (action === "check") {
      await checkTarget(targetId);
    } else if (action === "open") {
      state.selectedEntityType = "site";
      state.selectedTargetId = targetId;
      const selected = getSelectedTarget();
      state.selectedTargetName = selected?.name || "";
      els.siteSelect.value = `site:${targetId}`;
      setActiveView("observability");
      await loadSelectedDetails();
    }
  } catch (err) {
    window.alert(err.message);
  }
}

async function handleDbTargetsClick(event) {
  const button = event.target.closest("button[data-db-action]");
  if (!button) return;

  const action = button.dataset.dbAction;
  const dbTargetId = Number(button.dataset.id);
  const dbTargetName = button.dataset.name || "banco";

  try {
    if (action === "delete") {
      await api(`/api/db-targets/${dbTargetId}`, { method: "DELETE" });
      if (Number(state.dbSelectedTargetId) === Number(dbTargetId)) {
        state.dbSelectedTargetId = null;
        state.dbSelectedTargetName = "";
      }
      await refreshDbTargets();
    } else if (action === "check") {
      await api(`/api/db-targets/${dbTargetId}/check`, { method: "POST" });
      await refreshDbTargets();
    } else if (action === "history") {
      await loadDbHistory(dbTargetId, dbTargetName);
    }
  } catch (err) {
    window.alert(err.message);
  }
}

function redrawCharts() {
  renderSelectedCharts();
}

function updateRefreshStatus() {
  els.refreshStatus.textContent = `Auto refresh em ${state.refreshCountdown}s`;
}

function startAutoRefresh() {
  state.refreshCountdown = AUTO_REFRESH_SECONDS;
  updateRefreshStatus();
  window.setInterval(() => {
    state.refreshCountdown -= 1;
    if (state.refreshCountdown <= 0) {
      state.refreshCountdown = AUTO_REFRESH_SECONDS;
      Promise.all([refreshDashboard(), refreshDbTargets()]).catch(() => {});
    }
    updateRefreshStatus();
  }, 1000);
}

els.form.addEventListener("submit", createTarget);
els.targetsBody.addEventListener("click", handleTargetsClick);
els.dbForm.addEventListener("submit", createDbTarget);
els.dbTargetsBody.addEventListener("click", handleDbTargetsClick);
els.siteSelect.addEventListener("change", async () => {
  const raw = (els.siteSelect.value || "").trim();
  if (!raw || !raw.includes(":")) {
    state.selectedEntityType = "site";
    state.selectedTargetId = null;
    state.selectedTargetName = "";
  } else {
    const [entityType, idStr] = raw.split(":");
    state.selectedEntityType = entityType === "db" ? "db" : "site";
    state.selectedTargetId = Number(idStr);
    const selected = state.selectedEntityType === "db" ? getSelectedDbTarget() : getSelectedTarget();
    state.selectedTargetName = selected?.name || "";
  }
  await loadSelectedDetails().catch((err) => {
    els.message.textContent = err.message;
  });
});
els.sideButtons.forEach((btn) => {
  btn.addEventListener("click", () => setActiveView(btn.dataset.view || "observability"));
});
els.refreshNow.addEventListener("click", () => {
  state.refreshCountdown = AUTO_REFRESH_SECONDS;
  updateRefreshStatus();
  refreshDashboard().catch((err) => {
    els.message.textContent = err.message;
  });
  refreshDbTargets().catch((err) => {
    els.dbFormMessage.textContent = err.message;
  });
});
window.addEventListener("resize", () => {
  window.clearTimeout(window.__gtResizeTimer);
  window.__gtResizeTimer = window.setTimeout(redrawCharts, 120);
});

refreshDashboard()
  .then(() => {
    return refreshDbTargets();
  })
  .then(() => {
    startAutoRefresh();
  })
  .catch((err) => {
    els.message.textContent = err.message;
  });
