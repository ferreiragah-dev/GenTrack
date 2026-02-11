const els = {
  form: document.getElementById("target-form"),
  name: document.getElementById("name"),
  url: document.getElementById("url"),
  interval: document.getElementById("interval_seconds"),
  timeout: document.getElementById("timeout_seconds"),
  message: document.getElementById("form-message"),
  kpiTotal: document.getElementById("kpi-total"),
  kpiUp: document.getElementById("kpi-up"),
  kpiDown: document.getElementById("kpi-down"),
  kpiUptime: document.getElementById("kpi-uptime"),
  targetsBody: document.getElementById("targets-body"),
  historyTitle: document.getElementById("history-title"),
  historyBody: document.getElementById("history-body"),
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
};

const AUTO_REFRESH_SECONDS = 15;

const state = {
  targets: [],
  history: [],
  selectedTargetId: null,
  selectedTargetName: "",
  refreshCountdown: AUTO_REFRESH_SECONDS,
  activeView: "observability",
};

const fmtDate = (iso) => {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("pt-BR");
};

const fmtUptime = (value) => (value == null ? "--" : `${value.toFixed(2)}%`);
const fmtLatency = (value) => (value == null ? "--" : `${value} ms`);

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

function drawLineChart(canvas, labels, values) {
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
  ctx.strokeStyle = "#ff9f0a";
  ctx.lineWidth = 2;
  ctx.stroke();

  points.forEach((p, i) => {
    if (i % Math.ceil(points.length / 10) !== 0 && i !== points.length - 1) return;
    ctx.fillStyle = "#8ea3c1";
    ctx.font = "600 11px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.label, p.x, height - 12);
  });
}

function setActiveView(view) {
  const labels = {
    observability: ["Observabilidade Web", "General / GenTrack Uptime"],
    sites: ["Sites Monitorados", "General / Sites"],
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

function renderSiteSelect() {
  const previous = state.selectedTargetId;
  els.siteSelect.innerHTML = state.targets.length
    ? state.targets
        .map((t) => `<option value="${t.id}">${t.name}</option>`)
        .join("")
    : '<option value="">Sem sites cadastrados</option>';

  if (!state.targets.length) {
    state.selectedTargetId = null;
    state.selectedTargetName = "";
    return;
  }

  const hasPrev = previous != null && state.targets.some((t) => Number(t.id) === Number(previous));
  state.selectedTargetId = hasPrev ? Number(previous) : Number(state.targets[0].id);
  const selected = getSelectedTarget();
  state.selectedTargetName = selected?.name || "";
  els.siteSelect.value = String(state.selectedTargetId);
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
  const selected = getSelectedTarget();
  if (!selected) {
    els.kpiTotal.textContent = "--";
    els.kpiUp.textContent = "--";
    els.kpiDown.textContent = "--";
    els.kpiUptime.textContent = "--";
    return;
  }

  els.kpiTotal.textContent = selected.last_is_up === true ? "UP" : selected.last_is_up === false ? "DOWN" : "--";
  els.kpiUp.textContent = selected.last_status_code ?? "--";
  els.kpiDown.textContent = selected.last_latency_ms != null ? `${selected.last_latency_ms} ms` : "--";
  els.kpiUptime.textContent = fmtUptime(selected.uptime_24h);
}

function renderHistoryTable(history) {
  if (!history.length) {
    els.historyBody.innerHTML = `<tr><td colspan="5">Sem historico para esse site.</td></tr>`;
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
          <td>${item.error_message || "--"}</td>
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

  drawBarChart(
    els.uptimeChart,
    labels,
    sorted.map((item) => (item.is_up ? 100 : 0)),
    { suffix: "%", maxValue: 100, color: "#73d07d" }
  );

  drawLineChart(
    els.latencyChart,
    labels,
    sorted.map((item) => item.status_code ?? 0)
  );

  drawLineChart(
    els.trendChart,
    labels,
    sorted.map((item) => item.latency_ms ?? 0)
  );
}

async function loadSelectedHistory() {
  if (!state.selectedTargetId) {
    state.history = [];
    els.historyTitle.textContent = "Selecione um site para carregar o historico.";
    els.trendTitle.textContent = "Tendencia de latencia";
    renderHistoryTable([]);
    renderSelectedCharts();
    return;
  }

  const history = await api(`/api/targets/${state.selectedTargetId}/history?limit=80`);
  state.history = history || [];
  els.historyTitle.textContent = `Historico de ${state.selectedTargetName}`;
  els.trendTitle.textContent = `Tendencia de latencia - ${state.selectedTargetName}`;
  renderHistoryTable(state.history);
  renderSelectedCharts();
}

async function refreshDashboard() {
  const data = await api("/api/dashboard");
  state.targets = data.targets || [];
  renderTargetsTable(state.targets);
  renderSiteSelect();
  renderSelectedKpis();
  await loadSelectedHistory();
}

async function createTarget(event) {
  event.preventDefault();
  els.message.textContent = "";
  try {
    await api("/api/targets", {
      method: "POST",
      body: JSON.stringify({
        name: els.name.value,
        url: els.url.value,
        interval_seconds: Number(els.interval.value),
        timeout_seconds: Number(els.timeout.value),
      }),
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

async function deleteTarget(targetId) {
  await api(`/api/targets/${targetId}`, { method: "DELETE" });
  if (Number(state.selectedTargetId) === Number(targetId)) {
    state.selectedTargetId = null;
    state.selectedTargetName = "";
    state.history = [];
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
      state.selectedTargetId = targetId;
      const selected = getSelectedTarget();
      state.selectedTargetName = selected?.name || "";
      els.siteSelect.value = String(targetId);
      setActiveView("observability");
      await loadSelectedHistory();
      renderSelectedKpis();
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
      refreshDashboard().catch(() => {});
    }
    updateRefreshStatus();
  }, 1000);
}

els.form.addEventListener("submit", createTarget);
els.targetsBody.addEventListener("click", handleTargetsClick);
els.siteSelect.addEventListener("change", async () => {
  const value = Number(els.siteSelect.value);
  state.selectedTargetId = Number.isFinite(value) ? value : null;
  const selected = getSelectedTarget();
  state.selectedTargetName = selected?.name || "";
  renderSelectedKpis();
  await loadSelectedHistory().catch((err) => {
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
});

window.addEventListener("resize", () => {
  window.clearTimeout(window.__gtResizeTimer);
  window.__gtResizeTimer = window.setTimeout(redrawCharts, 120);
});

refreshDashboard()
  .then(() => {
    startAutoRefresh();
  })
  .catch((err) => {
    els.message.textContent = err.message;
  });
