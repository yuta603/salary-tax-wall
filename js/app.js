(() => {
  "use strict";

  const STORAGE_KEY = "zeikin-kabe-data-v1";
  const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];

  const DEFAULT_DATA = {
    version: 1,
    sources: [
      { id: "salary-default", type: "salary", name: "給与（会社名を編集してください）", color: "#1f6feb" },
      { id: "misc-default", type: "misc", name: "Uber Eats", color: "#2da44e" }
    ],
    entries: [],
    settings: {
      wallMiscYen: 620000,
      wallSalaryIncomeYen: 740000,
      wallCombinedYen: 1360000,
      deductionFlat: 650000,
      deductionCeiling: 1900000
    }
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

  function renderWallCards(summary) {
    const walls = [
      { label: "雑所得（Uber等）単体の壁", current: summary.miscIncome, projected: summary.projectedMiscIncome, threshold: state.settings.wallMiscYen },
      { label: "給与所得単体の壁", current: summary.salaryIncome, projected: summary.projectedSalaryIncome, threshold: state.settings.wallSalaryIncomeYen },
      { label: "合計所得の壁", current: summary.combined, projected: summary.projectedCombined, threshold: state.settings.wallCombinedYen }
    ];
    const container = document.getElementById("wall-cards");
    container.innerHTML = walls.map(w => {
      const currentRatio = w.threshold > 0 ? w.current / w.threshold : 0;
      const projectedRatio = w.threshold > 0 ? w.projected / w.threshold : 0;
      const status = statusForRatio(projectedRatio);
      const barWidth = Math.min(100, currentRatio * 100);
      let alertText = "";
      if (status === "danger") alertText = "⚠ このペースだと壁を超える見込みです";
      else if (status === "warn") alertText = "△ 壁の80%を超えています。ペース配分に注意してください";
      else alertText = "◯ 余裕があります";
      return `
        <div class="wall-card">
          <div class="wall-title"><span>${w.label}</span><span>${(currentRatio*100).toFixed(1)}%</span></div>
          <div class="wall-numbers">
            <span>現在: ${yen(w.current)}</span>
            <span>壁: ${yen(w.threshold)}</span>
          </div>
          <div class="progress-track"><div class="progress-fill ${status}" style="width:${barWidth}%"></div></div>
          <div class="wall-numbers" style="margin-top:4px;">
            <span>年末見込み: ${yen(w.projected)}</span>
          </div>
          <div class="wall-alert ${status}">${alertText}</div>
        </div>`;
    }).join("");

    if (summary.overCeiling) {
      container.innerHTML += `<div class="disclaimer">給与収入が設定上の上限（${yen(state.settings.deductionCeiling)}）を超えました。給与所得控除額の前提が変わる可能性があるため、設定を見直すか国税庁の速算表を確認してください。</div>`;
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

  function drawStackedBarChart(canvas, categories, series, colors) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const padL = 56, padR = 12, padT = 10, padB = 24;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;

    const totals = categories.map((_, i) => series.reduce((sum, s) => sum + s.data[i], 0));
    const max = niceMax(Math.max(...totals, 1));
    const textColor = getComputedStyle(document.body).getPropertyValue("--text-muted") || "#666";

    ctx.strokeStyle = "#8884";
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
    const barWidth = barSlot * 0.55;
    ctx.textAlign = "center";
    categories.forEach((cat, i) => {
      let yOffset = 0;
      const x = padL + barSlot * i + (barSlot - barWidth) / 2;
      series.forEach((s, si) => {
        const v = s.data[i];
        if (v <= 0) return;
        const h = (v / max) * chartH;
        const y = padT + chartH - yOffset - h;
        ctx.fillStyle = colors[si];
        ctx.fillRect(x, y, barWidth, h);
        yOffset += h;
      });
      ctx.fillStyle = textColor;
      ctx.fillText(cat, x + barWidth / 2, padT + chartH + 14);
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
    const textColor = getComputedStyle(document.body).getPropertyValue("--text-muted") || "#666";

    ctx.strokeStyle = "#8884";
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
  }

  function drawGroupedBarChart(canvas, categories, seriesA, seriesB, labelA, labelB, colorA, colorB) {
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const padL = 56, padR = 12, padT = 10, padB = 24;
    const chartW = width - padL - padR;
    const chartH = height - padT - padB;
    const max = niceMax(Math.max(...seriesA, ...seriesB, 1));
    const textColor = getComputedStyle(document.body).getPropertyValue("--text-muted") || "#666";

    ctx.strokeStyle = "#8884";
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
    const barWidth = barSlot * 0.32;
    ctx.textAlign = "center";
    categories.forEach((cat, i) => {
      const xBase = padL + barSlot * i + barSlot * 0.18;
      const hA = (seriesA[i] / max) * chartH;
      const hB = (seriesB[i] / max) * chartH;
      ctx.fillStyle = colorA;
      ctx.fillRect(xBase, padT + chartH - hA, barWidth, hA);
      ctx.fillStyle = colorB;
      ctx.fillRect(xBase + barWidth + 3, padT + chartH - hB, barWidth, hB);
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
  }

  // ---------- ダッシュボード描画 ----------

  function renderDashboard() {
    const summary = yearSummary(currentYear);
    renderWallCards(summary);

    const monthly = monthlyTotalsBySource(currentYear);
    const series = state.sources.map(s => ({ data: monthly[s.id] }));
    const colors = state.sources.map(s => s.color);
    drawStackedBarChart(document.getElementById("chart-monthly"), MONTH_NAMES, series, colors);

    const legend = document.getElementById("legend-monthly");
    legend.innerHTML = state.sources.map(s =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.name || "(未設定)"}</span>`
    ).join("");

    drawLineChart(
      document.getElementById("chart-cumulative"),
      MONTH_NAMES,
      [
        { data: summary.salaryIncomeCumSeries, color: "#1f6feb" },
        { data: summary.miscIncomeCumSeries, color: "#2da44e" },
        { data: summary.combinedCumSeries, color: "#8250df" }
      ],
      [
        { value: state.settings.wallSalaryIncomeYen, color: "#1f6feb", label: "給与所得の壁" },
        { value: state.settings.wallMiscYen, color: "#2da44e", label: "雑所得の壁" },
        { value: state.settings.wallCombinedYen, color: "#8250df", label: "合計の壁" }
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
      "#9aa7b2", "#1f6feb"
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
        <span class="swatch" style="background:${s.color}"></span>
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
          ${rows.map(({ e, src }) => `
            <tr>
              <td>${MONTH_NAMES[e.month - 1]}</td>
              <td>${src.name}</td>
              <td>${yen(e.income)}</td>
              <td>${e.expense ? yen(e.expense) : "-"}</td>
              <td>${yen(e.income - (e.expense || 0))}</td>
              <td><button data-id="${e.id}" class="delete-entry-btn">削除</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    document.querySelectorAll(".delete-entry-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        state.entries = state.entries.filter(e => e.id !== btn.dataset.id);
        saveData();
        renderEntryTable();
      });
    });
  }

  document.getElementById("entry-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const year = Number(document.getElementById("entry-year").value);
    const month = Number(document.getElementById("entry-month").value);
    const sourceId = entrySourceSelect.value;
    const income = Number(document.getElementById("entry-income").value);
    const src = sourceById(sourceId);
    const expense = src && src.type === "misc" ? Number(document.getElementById("entry-expense").value || 0) : 0;

    const existing = state.entries.find(e => e.year === year && e.month === month && e.sourceId === sourceId);
    if (existing) {
      existing.income = income;
      existing.expense = expense;
    } else {
      state.entries.push({ id: uid(), year, month, sourceId, income, expense });
    }
    saveData();
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
