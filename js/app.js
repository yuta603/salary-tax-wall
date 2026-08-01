(() => {
  "use strict";

  const STORAGE_KEY = "zeikin-kabe-data-v1";
  const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
  // 検証済みカテゴリカルパレット（dataviz skill: references/palette.md）固定順で割り当てる
  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

  const DEFAULT_DATA = {
    version: 1,
    sources: [
      { id: "salary-default", type: "salary", name: "給与（会社名を編集してください）", color: PALETTE[0] },
      { id: "misc-default", type: "misc", name: "Uber Eats", color: PALETTE[1] }
    ],
    entries: [],
    settings: {
      wallMiscYen: 620000,
      wallSalaryIncomeYen: 740000,
      wallCombinedYen: 1360000,
      deductionFlat: 650000,
      deductionCeiling: 1900000
    },
    updatedAt: 0
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_DATA);
      const parsed = JSON.parse(raw);
      return Object.assign(structuredClone(DEFAULT_DATA), parsed, {
        settings: Object.assign({}, DEFAULT_DATA.settings, parsed.settings || {})
      });
    } catch (e) {
      console.error("データの読み込みに失敗しました", e);
      return structuredClone(DEFAULT_DATA);
    }
  }

  function saveData() {
    state.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    pushToCloud();
  }

  let state = loadData();

  // ---------- 集計ロジック ----------

  function sourceById(id) {
    return state.sources.find(s => s.id === id);
  }

  function entriesForYear(year) {
    return state.entries.filter(e => e.year === year);
  }

  function monthlyTotalsBySource(year) {
    const map = {};
    for (const s of state.sources) map[s.id] = new Array(12).fill(0);
    for (const e of entriesForYear(year)) {
      if (!map[e.sourceId]) continue;
      const net = e.income - (e.expense || 0);
      map[e.sourceId][e.month - 1] += net;
    }
    return map;
  }

  function cumulativeRevenueByType(year) {
    const salary = new Array(12).fill(0);
    const misc = new Array(12).fill(0);
    const byMonth = { salary: new Array(12).fill(0), misc: new Array(12).fill(0) };
    for (const e of entriesForYear(year)) {
      const src = sourceById(e.sourceId);
      if (!src) continue;
      const net = e.income - (e.expense || 0);
      if (src.type === "salary") byMonth.salary[e.month - 1] += e.income; // 給与所得控除は収入ベースで適用
      else byMonth.misc[e.month - 1] += net;
    }
    let runSalary = 0, runMisc = 0;
    for (let i = 0; i < 12; i++) {
      runSalary += byMonth.salary[i];
      runMisc += byMonth.misc[i];
      salary[i] = runSalary;
      misc[i] = runMisc;
    }
    return { salaryRevenueCum: salary, miscIncomeCum: misc };
  }

  function salaryIncomeFromRevenue(revenue) {
    return Math.max(0, revenue - state.settings.deductionFlat);
  }

  function yearSummary(year) {
    const { salaryRevenueCum, miscIncomeCum } = cumulativeRevenueByType(year);
    const salaryRevenue = salaryRevenueCum[11];
    const miscIncome = miscIncomeCum[11];
    const salaryIncome = salaryIncomeFromRevenue(salaryRevenue);
    const combined = salaryIncome + miscIncome;
    const overCeiling = salaryRevenue > state.settings.deductionCeiling;

    const now = new Date();
    let monthsElapsed;
    if (year < now.getFullYear()) monthsElapsed = 12;
    else if (year > now.getFullYear()) monthsElapsed = 0;
    else monthsElapsed = now.getMonth() + 1;

    function project(cumValue) {
      if (year !== now.getFullYear() || monthsElapsed === 0) return cumValue;
      return Math.round((cumValue / monthsElapsed) * 12);
    }

    const salaryIncomeCumSeries = salaryRevenueCum.map(salaryIncomeFromRevenue);
    const combinedCumSeries = salaryIncomeCumSeries.map((v, i) => v + miscIncomeCum[i]);

    return {
      salaryRevenue, salaryIncome, miscIncome, combined, overCeiling,
      monthsElapsed,
      projectedSalaryIncome: project(salaryIncome),
      projectedMiscIncome: project(miscIncome),
      projectedCombined: project(combined),
      salaryIncomeCumSeries, miscIncomeCumSeries: miscIncomeCum, combinedCumSeries
    };
  }

  function availableYears() {
    const years = new Set(state.entries.map(e => e.year));
    years.add(new Date().getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }

  // ---------- 状態 ----------

  let currentYear = new Date().getFullYear();
  let currentView = "dashboard";

  // ---------- DOM: 年セレクタ ----------

  const yearSelect = document.getElementById("year-select");
  function renderYearSelect() {
    const years = availableYears();
    yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}年</option>`).join("");
    yearSelect.value = String(currentYear);
  }
  yearSelect.addEventListener("change", () => {
    currentYear = Number(yearSelect.value);
    renderAll();
  });

  // ---------- タブ切り替え ----------

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      currentView = btn.dataset.view;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
      document.getElementById("view-" + currentView).classList.remove("hidden");
      if (currentView === "entry") renderEntryView();
      if (currentView === "settings") renderSettingsView();
    });
  });

  // ---------- ダッシュボード: 壁カード ----------

  function statusForRatio(ratio) {
    if (ratio >= 1) return "danger";
    if (ratio >= 0.8) return "warn";
    return "ok";
  }

  function yen(n) {
    return Math.round(n).toLocaleString("ja-JP") + "円";
  }

  const WALL_DEFS = [
    { key: "misc", label: "雑所得（Uber等）の壁", icon: "🛵", tint: "rgba(235,104,52,0.14)", iconColor: "#eb6834" },
    { key: "salary", label: "給与所得の壁", icon: "💼", tint: "rgba(42,120,214,0.14)", iconColor: "#2a78d6" },
    { key: "combined", label: "合計所得の壁", icon: "📊", tint: "rgba(74,58,167,0.14)", iconColor: "#4a3aa7" }
  ];
  const STATUS_LABEL = { ok: "◯ 余裕", warn: "△ 注意", danger: "⚠ 超過見込み" };

  function wallsForSummary(summary) {
    return [
      { def: WALL_DEFS[0], current: summary.miscIncome, projected: summary.projectedMiscIncome, threshold: state.settings.wallMiscYen },
      { def: WALL_DEFS[1], current: summary.salaryIncome, projected: summary.projectedSalaryIncome, threshold: state.settings.wallSalaryIncomeYen },
      { def: WALL_DEFS[2], current: summary.combined, projected: summary.projectedCombined, threshold: state.settings.wallCombinedYen }
    ].map(w => {
      const currentRatio = w.threshold > 0 ? w.current / w.threshold : 0;
      const projectedRatio = w.threshold > 0 ? w.projected / w.threshold : 0;
      return Object.assign(w, { currentRatio, status: statusForRatio(projectedRatio) });
    });
  }

  function renderWallRows(summary) {
    const walls = wallsForSummary(summary);
    const container = document.getElementById("wall-rows");
    container.innerHTML = walls.map(w => {
      const barWidth = Math.min(100, w.currentRatio * 100);
      const revenueLine = w.def.key === "salary"
        ? `<div class="row-sub" style="margin-bottom:2px;">給与収入（控除前）${yen(summary.salaryRevenue)} － 給与所得控除 ${yen(state.settings.deductionFlat)} → 給与所得 ${yen(w.current)}</div>`
        : "";
      return `
        <div class="wall-row">
          <div class="avatar" style="background:${w.def.tint};">${w.def.icon}</div>
          <div class="row-main">
            <div class="row-title-line">
              <span class="row-title">${w.def.label}</span>
              <span class="badge ${w.status}">${STATUS_LABEL[w.status]}</span>
            </div>
            ${revenueLine}
            <div class="row-sub">${yen(w.current)} ／ ${yen(w.threshold)}（年末見込み ${yen(w.projected)}）</div>
            <div class="progress-track"><div class="progress-fill ${w.status}" style="width:${barWidth}%"></div></div>
          </div>
        </div>`;
    }).join("");

    if (summary.overCeiling) {
      container.innerHTML += `<div class="disclaimer" style="margin-top:10px;">給与収入が設定上の上限（${yen(state.settings.deductionCeiling)}）を超えました。給与所得控除額の前提が変わる可能性があるため、設定を見直すか国税庁の速算表を確認してください。</div>`;
    }
  }

  function renderHero(summary) {
    const hour = new Date().getHours();
    const greeting = hour < 5 ? "こんばんは" : hour < 11 ? "おはようございます" : hour < 17 ? "こんにちは" : "こんばんは";
    document.getElementById("hero-greeting").textContent = greeting;
    document.getElementById("hero-amount").textContent = "¥" + Math.round(summary.combined).toLocaleString("ja-JP");

    const walls = wallsForSummary(summary);
    const closest = walls.reduce((a, b) => (b.currentRatio > a.currentRatio ? b : a));
    const subEl = document.getElementById("hero-sub");
    if (closest.status === "danger") {
      subEl.textContent = `⚠ ${closest.def.label}を超える見込みです`;
    } else if (closest.status === "warn") {
      subEl.textContent = `△ ${closest.def.label}に近づいています（${Math.round(closest.currentRatio * 100)}%）`;
    } else {
      subEl.textContent = `◯ もっとも近い壁は${closest.def.label}（${Math.round(closest.currentRatio * 100)}%）`;
    }
  }

  // ---------- キャンバスチャート（依存ライブラリなし） ----------

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width || canvas.parentElement.clientWidth;
    const cssHeight = canvas.height;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function fillRoundedTopRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, [r, r, 0, 0]);
      ctx.fill();
      return;
    }
    const rr = Math.min(r, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  // ---------- チャートのツールチップ ----------

  function tooltipEl() {
    let el = document.getElementById("chart-tooltip");
    if (!el) {
      el = document.createElement("div");
      el.id = "chart-tooltip";
      el.className = "chart-tooltip hidden";
      document.body.appendChild(el);
    }
    return el;
  }

  function showChartTooltip(clientX, clientY, title, rows) {
    const el = tooltipEl();
    el.innerHTML = "";
    const titleEl = document.createElement("div");
    titleEl.className = "chart-tooltip-title";
    titleEl.textContent = title;
    el.appendChild(titleEl);
    rows.forEach(r => {
      const row = document.createElement("div");
      row.className = "chart-tooltip-row";
      const key = document.createElement("span");
      key.className = "chart-tooltip-key";
      key.style.background = r.color;
      const name = document.createElement("span");
      name.className = "chart-tooltip-name";
      name.textContent = r.name;
      const val = document.createElement("span");
      val.className = "chart-tooltip-value";
      val.textContent = r.value;
      row.appendChild(key);
      row.appendChild(name);
      row.appendChild(val);
      el.appendChild(row);
    });
    el.classList.remove("hidden");
    const pad = 14;
    let left = clientX + pad;
    let top = clientY + pad;
    const rect = el.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - pad;
    el.style.left = Math.max(8, left) + "px";
    el.style.top = Math.max(8, top) + "px";
  }

  let tooltipHideTimer = null;
  function hideChartTooltip() {
    tooltipEl().classList.add("hidden");
  }
  function scheduleHideChartTooltip(delay) {
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(hideChartTooltip, delay);
  }

  function attachChartTooltip(canvas, getLayout, buildContent) {
    if (canvas._tooltipBound) return;
    canvas._tooltipBound = true;

    function handle(ev) {
      const layout = getLayout();
      if (!layout) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (x < layout.padL - 10 || x > layout.padL + layout.chartW + 10 || y < 0 || y > layout.chartH + layout.padT + 20) {
        hideChartTooltip();
        return;
      }
      clearTimeout(tooltipHideTimer);
      const content = buildContent(layout, x);
      if (!content) { hideChartTooltip(); return; }
      showChartTooltip(ev.clientX, ev.clientY, content.title, content.rows);
    }

    canvas.addEventListener("pointermove", handle);
    canvas.addEventListener("pointerdown", handle);
    canvas.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType === "touch") scheduleHideChartTooltip(2000);
      else hideChartTooltip();
    });
    canvas.addEventListener("pointerup", (ev) => {
      if (ev.pointerType === "touch") scheduleHideChartTooltip(2500);
    });
  }

  function categoryIndexFromX(layout, x) {
    let idx = Math.floor((x - layout.padL) / layout.barSlot);
    return Math.max(0, Math.min(layout.categories.length - 1, idx));
  }

  function nearestIndexFromX(layout, x) {
    const idx = Math.round((x - layout.padL) / layout.xStep);
    return Math.max(0, Math.min(layout.categories.length - 1, idx));
  }

  function niceMax(value) {
    if (value <= 0) return 100000;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const residual = value / magnitude;
    let niceResidual;
    if (residual <= 1) niceResidual = 1;
    else if (residual <= 2) niceResidual = 2;
    else if (residual <= 5) niceResidual = 5;
    else niceResidual = 10;
    return niceResidual * magnitude;
  }

  function drawStackedBarChart(canvas, categories, series) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const padL = 56, padR = 12, padT = 10, padB = 24;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;

    const totals = categories.map((_, i) => series.reduce((sum, s) => sum + s.data[i], 0));
    const max = niceMax(Math.max(...totals, 1));
    const textColor = getComputedStyle(document.body).getPropertyValue("--ink-muted") || "#898781";
    const gridColor = getComputedStyle(document.body).getPropertyValue("--grid") || "#e1e0d9";

    ctx.strokeStyle = gridColor;
    ctx.fillStyle = textColor;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (let g = 0; g <= 4; g++) {
      const v = (max / 4) * g;
      const y = padT + chartH - (v / max) * chartH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + chartW, y);
      ctx.stroke();
      ctx.fillText(Math.round(v / 10000) + "万", padL - 6, y + 3);
    }

    const barSlot = chartW / categories.length;
    const barWidth = barSlot * 0.5;
    const segGap = 2;
    ctx.textAlign = "center";
    categories.forEach((cat, i) => {
      let yOffset = 0;
      const x = padL + barSlot * i + (barSlot - barWidth) / 2;
      const visible = series.map(s => s.data[i]).filter(v => v > 0).length;
      let segIndex = 0;
      series.forEach((s, si) => {
        const v = s.data[i];
        if (v <= 0) return;
        const isTop = segIndex === visible - 1;
        const h = Math.max(0, (v / max) * chartH - (visible > 1 ? segGap : 0));
        const y = padT + chartH - yOffset - h;
        ctx.fillStyle = s.color;
        if (isTop) {
          fillRoundedTopRect(ctx, x, y, barWidth, h, 4);
        } else {
          ctx.fillRect(x, y, barWidth, h);
        }
        yOffset += h + (visible > 1 ? segGap : 0);
        segIndex++;
      });
      ctx.fillStyle = textColor;
      ctx.fillText(cat, x + barWidth / 2, padT + chartH + 14);
    });

    canvas._layout = { padL, padT, chartW, chartH, barSlot, categories, series };
    attachChartTooltip(canvas, () => canvas._layout, (layout, x) => {
      const idx = categoryIndexFromX(layout, x);
      const rows = layout.series
        .map(s => ({ name: s.name, color: s.color, value: yen(s.data[idx]) }))
        .filter((r, i) => layout.series[i].data[idx] !== 0 || layout.series.length <= 4);
      const total = layout.series.reduce((sum, s) => sum + s.data[idx], 0);
      if (layout.series.length > 1) rows.push({ name: "合計", color: "transparent", value: yen(total) });
      return { title: layout.categories[idx], rows };
    });
  }

  function drawLineChart(canvas, categories, lines, thresholdLines) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const padL = 56, padR = 12, padT = 10, padB = 24;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;

    const allValues = lines.flatMap(l => l.data).concat(thresholdLines.map(t => t.value));
    const max = niceMax(Math.max(...allValues, 1));
    const textColor = getComputedStyle(document.body).getPropertyValue("--ink-muted") || "#898781";
    const gridColor = getComputedStyle(document.body).getPropertyValue("--grid") || "#e1e0d9";

    ctx.strokeStyle = gridColor;
    ctx.fillStyle = textColor;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (let g = 0; g <= 4; g++) {
      const v = (max / 4) * g;
      const y = padT + chartH - (v / max) * chartH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + chartW, y);
      ctx.stroke();
      ctx.fillText(Math.round(v / 10000) + "万", padL - 6, y + 3);
    }

    const xStep = chartW / (categories.length - 1 || 1);

    thresholdLines.forEach(t => {
      const y = padT + chartH - (t.value / max) * chartH;
      ctx.save();
      ctx.strokeStyle = t.color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + chartW, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = t.color;
      ctx.textAlign = "left";
      ctx.fillText(t.label, padL + 4, y - 3);
    });

    lines.forEach(l => {
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      l.data.forEach((v, i) => {
        const x = padL + xStep * i;
        const y = padT + chartH - (v / max) * chartH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    categories.forEach((cat, i) => {
      if (i % 2 !== 0 && categories.length > 8) return;
      const x = padL + xStep * i;
      ctx.fillText(cat, x, padT + chartH + 14);
    });

    canvas._layout = { padL, padT, chartW, chartH, xStep, categories, lines };
    attachChartTooltip(canvas, () => canvas._layout, (layout, x) => {
      const idx = nearestIndexFromX(layout, x);
      const rows = layout.lines.map(l => ({ name: l.name, color: l.color, value: yen(l.data[idx]) }));
      return { title: layout.categories[idx], rows };
    });
  }

  function drawGroupedBarChart(canvas, categories, seriesA, seriesB, labelA, labelB, colorA, colorB) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const padL = 56, padR = 12, padT = 10, padB = 24;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;
    const max = niceMax(Math.max(...seriesA, ...seriesB, 1));
    const textColor = getComputedStyle(document.body).getPropertyValue("--ink-muted") || "#898781";
    const gridColor = getComputedStyle(document.body).getPropertyValue("--grid") || "#e1e0d9";

    ctx.strokeStyle = gridColor;
    ctx.fillStyle = textColor;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (let g = 0; g <= 4; g++) {
      const v = (max / 4) * g;
      const y = padT + chartH - (v / max) * chartH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + chartW, y);
      ctx.stroke();
      ctx.fillText(Math.round(v / 10000) + "万", padL - 6, y + 3);
    }

    const barSlot = chartW / categories.length;
    const barWidth = barSlot * 0.3;
    ctx.textAlign = "center";
    categories.forEach((cat, i) => {
      const xBase = padL + barSlot * i + barSlot * 0.2;
      const hA = Math.max(0, (seriesA[i] / max) * chartH);
      const hB = Math.max(0, (seriesB[i] / max) * chartH);
      ctx.fillStyle = colorA;
      fillRoundedTopRect(ctx, xBase, padT + chartH - hA, barWidth, hA, 3);
      ctx.fillStyle = colorB;
      fillRoundedTopRect(ctx, xBase + barWidth + 3, padT + chartH - hB, barWidth, hB, 3);
      ctx.fillStyle = textColor;
      ctx.fillText(cat, xBase + barWidth + 1.5, padT + chartH + 14);
    });

    const legendY = 4;
    ctx.textAlign = "left";
    ctx.fillStyle = colorA;
    ctx.fillRect(padL, legendY, 8, 8);
    ctx.fillStyle = textColor;
    ctx.fillText(labelA, padL + 12, legendY + 8);
    ctx.fillStyle = colorB;
    ctx.fillRect(padL + 70, legendY, 8, 8);
    ctx.fillStyle = textColor;
    ctx.fillText(labelB, padL + 82, legendY + 8);

    canvas._layout = { padL, padT, chartW, chartH, barSlot, categories };
    attachChartTooltip(canvas, () => canvas._layout, (layout, x) => {
      const idx = categoryIndexFromX(layout, x);
      return {
        title: layout.categories[idx],
        rows: [
          { name: labelA, color: colorA, value: yen(seriesA[idx]) },
          { name: labelB, color: colorB, value: yen(seriesB[idx]) }
        ]
      };
    });
  }

  // ---------- ダッシュボード描画 ----------

  function renderDashboard() {
    const summary = yearSummary(currentYear);
    renderHero(summary);
    renderWallRows(summary);

    const monthly = monthlyTotalsBySource(currentYear);
    const series = state.sources.map(s => ({ data: monthly[s.id], name: s.name || "(未設定)", color: s.color }));
    drawStackedBarChart(document.getElementById("chart-monthly"), MONTH_NAMES, series);

    const legend = document.getElementById("legend-monthly");
    legend.innerHTML = state.sources.map(s =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.name || "(未設定)"}</span>`
    ).join("");

    const accent = (getComputedStyle(document.body).getPropertyValue("--accent") || "#2a78d6").trim();
    const mutedIcon = (getComputedStyle(document.body).getPropertyValue("--ink-muted") || "#898781").trim();

    drawLineChart(
      document.getElementById("chart-cumulative"),
      MONTH_NAMES,
      [
        { data: summary.salaryIncomeCumSeries, color: PALETTE[0], name: "給与所得（累計）" },
        { data: summary.miscIncomeCumSeries, color: PALETTE[1], name: "雑所得（累計）" },
        { data: summary.combinedCumSeries, color: PALETTE[6], name: "合計所得（累計）" }
      ],
      [
        { value: state.settings.wallSalaryIncomeYen, color: PALETTE[0], label: "給与所得の壁" },
        { value: state.settings.wallMiscYen, color: PALETTE[1], label: "雑所得の壁" },
        { value: state.settings.wallCombinedYen, color: PALETTE[6], label: "合計の壁" }
      ]
    );

    const lastYear = currentYear - 1;
    const thisYearMonthly = monthlyTotalsBySource(currentYear);
    const lastYearMonthly = monthlyTotalsBySource(lastYear);
    function combinedMonthly(map) {
      const out = new Array(12).fill(0);
      for (const arr of Object.values(map)) arr.forEach((v, i) => out[i] += v);
      return out;
    }
    drawGroupedBarChart(
      document.getElementById("chart-yoy"),
      MONTH_NAMES,
      combinedMonthly(lastYearMonthly),
      combinedMonthly(thisYearMonthly),
      `${lastYear}年`, `${currentYear}年`,
      mutedIcon, accent
    );
  }

  // ---------- 入力画面 ----------

  const monthSelect = document.getElementById("entry-month");
  monthSelect.innerHTML = MONTH_NAMES.map((m, i) => `<option value="${i+1}">${m}</option>`).join("");

  const entrySourceSelect = document.getElementById("entry-source");
  const expenseField = document.getElementById("expense-field");

  function renderSourceOptions() {
    entrySourceSelect.innerHTML = state.sources.map(s =>
      `<option value="${s.id}">${s.name || "(未設定)"}（${s.type === "salary" ? "給与" : "雑所得"}）</option>`
    ).join("");
    toggleExpenseField();
  }

  function toggleExpenseField() {
    const src = sourceById(entrySourceSelect.value);
    expenseField.classList.toggle("hidden", !src || src.type !== "misc");
  }
  entrySourceSelect.addEventListener("change", toggleExpenseField);

  function renderSourceList() {
    const list = document.getElementById("source-list");
    list.innerHTML = state.sources.map(s => `
      <div class="source-row">
        <span class="swatch" style="background:${s.color}">${(s.name || "?").trim().charAt(0)}</span>
        <span class="name">${s.name || "(未設定)"}</span>
        <span class="type-badge">${s.type === "salary" ? "給与" : "雑所得"}</span>
        <button data-id="${s.id}" class="delete-source-btn">削除</button>
      </div>
    `).join("");
    list.querySelectorAll(".delete-source-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const hasEntries = state.entries.some(e => e.sourceId === id);
        if (hasEntries && !confirm("この収入源には入力済みのデータがあります。関連する入力データも削除されますが、よろしいですか？")) return;
        state.sources = state.sources.filter(s => s.id !== id);
        state.entries = state.entries.filter(e => e.sourceId !== id);
        saveData();
        renderSourceList();
        renderSourceOptions();
      });
    });
  }

  document.getElementById("add-source-btn").addEventListener("click", () => {
    document.getElementById("source-color").value = PALETTE[state.sources.length % PALETTE.length];
    document.getElementById("source-form").classList.remove("hidden");
  });
  document.getElementById("cancel-source-btn").addEventListener("click", () => {
    document.getElementById("source-form").classList.add("hidden");
  });
  document.getElementById("source-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = document.getElementById("source-name").value.trim();
    const type = document.getElementById("source-type").value;
    const color = document.getElementById("source-color").value;
    if (!name) return;
    state.sources.push({ id: uid(), type, name, color });
    saveData();
    document.getElementById("source-form").reset();
    document.getElementById("source-form").classList.add("hidden");
    renderSourceList();
    renderSourceOptions();
  });

  function renderEntryTable() {
    const rows = state.entries
      .filter(e => e.year === currentYear)
      .sort((a, b) => b.month - a.month)
      .map(e => {
        const src = sourceById(e.sourceId);
        return { e, src };
      })
      .filter(r => r.src);

    if (rows.length === 0) {
      document.getElementById("entry-table").innerHTML = `<p class="hint">この年の入力はまだありません。</p>`;
      return;
    }

    document.getElementById("entry-table").innerHTML = `
      <table>
        <thead><tr><th>月</th><th>収入源</th><th>収入</th><th>経費</th><th>純額</th><th></th></tr></thead>
        <tbody>
          ${rows.map(({ e, src }) => {
            let expenseCell = "-";
            if (src.type === "misc") {
              expenseCell = e.expense ? yen(e.expense) : `<span class="hint" style="margin:0;">未入力</span>`;
            }
            return `
            <tr>
              <td>${MONTH_NAMES[e.month - 1]}</td>
              <td>${src.name}</td>
              <td>${yen(e.income)}</td>
              <td>${expenseCell}</td>
              <td>${yen(e.income - (e.expense || 0))}</td>
              <td>
                <button data-id="${e.id}" class="edit-entry-btn">編集</button>
                <button data-id="${e.id}" class="delete-entry-btn">削除</button>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    `;
    document.querySelectorAll(".delete-entry-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        state.entries = state.entries.filter(e => e.id !== btn.dataset.id);
        if (editingEntryId === btn.dataset.id) cancelEntryEdit();
        saveData();
        renderEntryTable();
      });
    });
    document.querySelectorAll(".edit-entry-btn").forEach(btn => {
      btn.addEventListener("click", () => startEntryEdit(btn.dataset.id));
    });
  }

  // ---------- 月次入力フォーム（新規追加 / 既存編集の両方を扱う） ----------

  let editingEntryId = null;
  const entryForm = document.getElementById("entry-form");
  const entrySubmitBtn = document.getElementById("entry-submit-btn");
  const entryCancelBtn = document.getElementById("entry-cancel-btn");
  const entryFormTitle = document.getElementById("entry-form-title");

  function startEntryEdit(entryId) {
    const entry = state.entries.find(e => e.id === entryId);
    if (!entry) return;
    editingEntryId = entryId;
    document.getElementById("entry-year").value = entry.year;
    monthSelect.value = String(entry.month);
    entrySourceSelect.value = entry.sourceId;
    toggleExpenseField();
    document.getElementById("entry-income").value = entry.income;
    document.getElementById("entry-expense").value = entry.expense || "";
    entrySubmitBtn.textContent = "更新する";
    entryFormTitle.textContent = "月次入力（編集中）";
    entryCancelBtn.classList.remove("hidden");
    entryForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelEntryEdit() {
    editingEntryId = null;
    entryForm.reset();
    document.getElementById("entry-year").value = currentYear;
    toggleExpenseField();
    entrySubmitBtn.textContent = "保存";
    entryFormTitle.textContent = "月次入力";
    entryCancelBtn.classList.add("hidden");
  }

  entryCancelBtn.addEventListener("click", cancelEntryEdit);

  entryForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const year = Number(document.getElementById("entry-year").value);
    const month = Number(document.getElementById("entry-month").value);
    const sourceId = entrySourceSelect.value;
    const income = Number(document.getElementById("entry-income").value);
    const src = sourceById(sourceId);
    const expenseRaw = document.getElementById("entry-expense").value;
    const expense = src && src.type === "misc" && expenseRaw !== "" ? Number(expenseRaw) : 0;

    if (editingEntryId) {
      const entry = state.entries.find(e => e.id === editingEntryId);
      if (entry) {
        entry.year = year;
        entry.month = month;
        entry.sourceId = sourceId;
        entry.income = income;
        entry.expense = expense;
      }
    } else {
      const existing = state.entries.find(e => e.year === year && e.month === month && e.sourceId === sourceId);
      if (existing) {
        existing.income = income;
        existing.expense = expense;
      } else {
        state.entries.push({ id: uid(), year, month, sourceId, income, expense });
      }
    }
    saveData();
    cancelEntryEdit();
    if (year === currentYear) renderEntryTable();
    renderYearSelect();
  });

  function renderEntryView() {
    document.getElementById("entry-year").value = currentYear;
    renderSourceList();
    renderSourceOptions();
    renderEntryTable();
  }

  // ---------- 設定画面 ----------

  function renderSettingsView() {
    document.getElementById("wall-misc").value = state.settings.wallMiscYen;
    document.getElementById("wall-salary").value = state.settings.wallSalaryIncomeYen;
    document.getElementById("wall-combined").value = state.settings.wallCombinedYen;
    document.getElementById("deduction-flat").value = state.settings.deductionFlat;
    document.getElementById("deduction-ceiling").value = state.settings.deductionCeiling;
  }

  document.getElementById("wall-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    state.settings.wallMiscYen = Number(document.getElementById("wall-misc").value);
    state.settings.wallSalaryIncomeYen = Number(document.getElementById("wall-salary").value);
    state.settings.wallCombinedYen = Number(document.getElementById("wall-combined").value);
    saveData();
    renderAll();
    alert("保存しました");
  });

  document.getElementById("deduction-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    state.settings.deductionFlat = Number(document.getElementById("deduction-flat").value);
    state.settings.deductionCeiling = Number(document.getElementById("deduction-ceiling").value);
    saveData();
    renderAll();
    alert("保存しました");
  });

  document.getElementById("export-btn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zeikin-kabe-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("import-btn").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!confirm("現在のデータを上書きします。よろしいですか？")) return;
        state = Object.assign(structuredClone(DEFAULT_DATA), parsed, {
          settings: Object.assign({}, DEFAULT_DATA.settings, parsed.settings || {})
        });
        saveData();
        renderAll();
        renderEntryView();
        renderSettingsView();
        alert("インポートしました");
      } catch (e) {
        alert("読み込みに失敗しました。ファイル形式を確認してください。");
      }
    };
    reader.readAsText(file);
    ev.target.value = "";
  });

  document.getElementById("reset-btn").addEventListener("click", () => {
    if (!confirm("全てのデータを削除します。この操作は取り消せません。よろしいですか？")) return;
    state = structuredClone(DEFAULT_DATA);
    saveData();
    renderAll();
    renderEntryView();
    renderSettingsView();
  });

  // ---------- クラウド同期（Firebase Auth + Firestore） ----------

  const cloudEnabled = typeof firebase !== "undefined" && !!window.fbAuth && !!window.fbDb;

  let currentUser = null;
  let unsubscribeSnapshot = null;
  let lastPushedUpdatedAt = 0;
  let pushTimer = null;

  function userDocRef(uid) {
    return fbDb.collection("users").doc(uid);
  }

  function pushToCloud() {
    if (!cloudEnabled || !currentUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const uid = currentUser.uid;
      const ref = userDocRef(uid);
      const localSnapshot = state;
      // 書き込む直前にサーバー側の最新値を読み直し、こちらの方が新しい場合だけ上書きする
      // （2端末がほぼ同時に初回ログインした場合の上書き競合を防ぐ）
      fbDb.runTransaction(tx => tx.get(ref).then(doc => {
        const remote = doc.exists ? doc.data() : null;
        if (remote && (remote.updatedAt || 0) > (localSnapshot.updatedAt || 0)) {
          return { skipped: true, remote };
        }
        tx.set(ref, localSnapshot);
        return { skipped: false };
      })).then(result => {
        if (result.skipped) {
          if ((result.remote.updatedAt || 0) > (state.updatedAt || 0)) adoptRemoteState(result.remote);
        } else {
          lastPushedUpdatedAt = localSnapshot.updatedAt;
        }
      }).catch(err => {
        console.error("クラウドへの保存に失敗しました", err);
      });
    }, 800);
  }

  function adoptRemoteState(remote) {
    state = Object.assign(structuredClone(DEFAULT_DATA), remote, {
      settings: Object.assign({}, DEFAULT_DATA.settings, remote.settings || {})
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    lastPushedUpdatedAt = state.updatedAt;
    renderAll();
    if (currentView === "entry") renderEntryView();
    if (currentView === "settings") renderSettingsView();
  }

  function subscribeSnapshot(user) {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = userDocRef(user.uid).onSnapshot(snap => {
      if (snap.metadata.hasPendingWrites || !snap.exists) return;
      const remote = snap.data();
      if ((remote.updatedAt || 0) === lastPushedUpdatedAt) return;
      if ((remote.updatedAt || 0) > (state.updatedAt || 0)) adoptRemoteState(remote);
    }, err => console.error("同期の監視に失敗しました", err));
  }

  function startCloudSync(user) {
    currentUser = user;
    updateSyncUI();
    userDocRef(user.uid).get().then(snap => {
      if (snap.exists) {
        const remote = snap.data();
        if ((remote.updatedAt || 0) > (state.updatedAt || 0)) {
          adoptRemoteState(remote);
        } else {
          pushToCloud();
        }
      } else {
        pushToCloud();
      }
      subscribeSnapshot(user);
    }).catch(err => {
      console.error("初回同期に失敗しました", err);
      subscribeSnapshot(user);
    });
  }

  function stopCloudSync() {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = null;
    currentUser = null;
    updateSyncUI();
  }

  function updateSyncUI() {
    const authBtn = document.getElementById("auth-btn");
    const settingsAuthBtn = document.getElementById("settings-auth-btn");
    const accountInfo = document.getElementById("account-info");
    const heroSync = document.getElementById("hero-sync");
    if (!cloudEnabled) {
      authBtn.classList.add("hidden");
      settingsAuthBtn.classList.add("hidden");
      accountInfo.textContent = "この端末ではクラウド同期を利用できません。";
      heroSync.textContent = "";
      return;
    }
    authBtn.classList.remove("hidden");
    settingsAuthBtn.classList.remove("hidden");
    if (currentUser) {
      const label = currentUser.displayName || currentUser.email || "ログイン中";
      authBtn.textContent = "☁ " + label;
      settingsAuthBtn.textContent = "ログアウト";
      accountInfo.textContent = `${currentUser.email} で同期しています。`;
      heroSync.textContent = "☁ 同期中";
    } else {
      authBtn.textContent = "ログイン";
      settingsAuthBtn.textContent = "Googleでログイン";
      accountInfo.textContent = "ログインしていません（この端末だけに保存されます）。";
      heroSync.textContent = "";
    }
  }

  function toggleAuth() {
    if (!cloudEnabled) return;
    if (currentUser) {
      fbAuth.signOut();
    } else {
      fbAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(err => {
        console.error("サインインに失敗しました", err);
        if (err && err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
          alert("ログインに失敗しました: " + err.message);
        }
      });
    }
  }

  document.getElementById("auth-btn").addEventListener("click", toggleAuth);
  document.getElementById("settings-auth-btn").addEventListener("click", toggleAuth);

  if (cloudEnabled) {
    fbAuth.onAuthStateChanged(user => {
      if (user) startCloudSync(user); else stopCloudSync();
    });
  }

  updateSyncUI();

  // ---------- 初期化 ----------

  function renderAll() {
    renderYearSelect();
    renderDashboard();
  }

  renderAll();

  window.addEventListener("resize", () => {
    if (currentView === "dashboard") renderDashboard();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
