(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "admin") { location.href = "staff.html"; return; }

  let dashboard = {};
  let refreshPromise = null;
  let refreshRevision = 0;
  let stale = false;
  let lastGeneratedAt = -Infinity;
  let transientFailures = 0;
  let nextPollAt = 0;
  const pollInterval = 15000;
  const empty = (message, span = 8) => `<tr><td colspan="${span}" class="empty-state">${message}</td></tr>`;
  const badge = (text, tone = "") => `<span class="badge ${tone}">${text || "--"}</span>`;
  const previewLimit = 5;
  const formatShiftTime12h = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "--";
    const timePart = raw.includes("T") ? raw.split("T").pop() : raw;
    const match = timePart.match(/\b(\d{1,2})(?::(\d{1,2}))(?::\d{1,2})?\s*(AM|PM)?\b/i);
    if (!match) {
      const parsed = /GMT|T|:\d{2}/i.test(raw) ? new Date(raw) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        const hour = parsed.getHours();
        const suffix = hour >= 12 ? "PM" : "AM";
        return `${hour % 12 || 12}:${String(parsed.getMinutes()).padStart(2, "0")} ${suffix}`;
      }
      return raw;
    }
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = String(match[3] || "").toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
  };
  const normalizeDashboard = (data) => {
    const root = data?.data || data?.dashboard || data || {};
    const summary = root.summary || root.today_summary || {};
    const nonWorkingCodes = new Set(["OFF", "AL", "UL", "SL", "NP", "LEAVE", "HOLIDAY", ""]);
    const nextShiftStaff = Portal.normalizeArray(root.next_shift_staff_all || root.nextShiftStaffAll || root.next_shift_staff || root.nextShiftStaff || root.next_shifts).filter((row) => {
      const status = String(Portal.pick(row || {}, ["status"], "")).toUpperCase();
      const shift = String(Portal.pick(row || {}, ["shift", "shift_code"], "")).toUpperCase();
      return status === "WORKING" && !nonWorkingCodes.has(shift);
    });
    const absentToday = Portal.normalizeArray(summary.summary_details?.absent_today);
    return {
      stats: {
        totalStaff: summary.total_staff,
        onlineStaff: summary.currently_working ?? summary.online_staff,
        checkedInToday: summary.checked_in,
        onBreak: summary.on_break,
        lateStaff: summary.late_staff,
        missingCheckout: summary.missing_checkout,
        absentToday: summary.absent_today_count ?? absentToday.length,
        notWorkingToday: summary.not_working_today
      },
      breaks: root.breakBoard,
      nextShiftStaff,
      summaryDetails: summary.summary_details,
      absentToday
    };
  };

  const summaryColumns = [
    { label: "Staff", keys: ["full_name", "name", "staff", "staffName"] },
    { label: "Team", keys: ["team", "department"] },
    { label: "Date", keys: ["date", "schedule_date", "event_date"] },
    { label: "Shift", keys: ["shift_code", "shift"] },
    { label: "Start", render: (row) => formatShiftTime12h(Portal.pick(row, ["start_time", "start"], "")) },
    { label: "End", render: (row) => formatShiftTime12h(Portal.pick(row, ["end_time", "end"], "")) },
    { label: "Check In", render: (row) => formatShiftTime12h(Portal.pick(row, ["check_in_time", "check_in"], "")) },
    { label: "Check Out", render: (row) => formatShiftTime12h(Portal.pick(row, ["check_out_time", "check_out"], "")) },
    { label: "Break Start", render: (row) => formatShiftTime12h(Portal.pick(row, ["break_start_time", "break_start"], "")) },
    { label: "Status", render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
  ];
  const absentColumns = [
    { label: "Staff", keys: ["full_name", "name", "staff", "staffName"] },
    { label: "Team", keys: ["team", "department"] },
    { label: "Date", keys: ["date", "schedule_date", "event_date"] },
    { label: "Shift", keys: ["shift_code", "shift"] },
    { label: "Start", render: (row) => formatShiftTime12h(Portal.pick(row, ["start_time", "start"], "")) },
    { label: "End", render: (row) => formatShiftTime12h(Portal.pick(row, ["end_time", "end"], "")) },
    { label: "Status", render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
  ];
  const bindSummaryCard = (id, title, rows, columns = summaryColumns) => {
    const card = document.getElementById(id)?.closest(".metric-card");
    if (!card) return;
    card.onclick = () => openTableModal(title, Portal.normalizeArray(rows), columns);
    card.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        card.click();
      }
    };
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `View ${title}`);
  };

  const renderStats = (stats) => {
    Portal.setText("totalStaff", Portal.pick(stats, ["totalStaff", "staffTotal", "total"], "--"));
    Portal.setText("onlineStaff", Portal.pick(stats, ["onlineStaff", "online_staff", "currently_working", "online"], "--"));
    Portal.setText("checkedInToday", Portal.pick(stats, ["checkedInToday", "checked_in", "checkedIn", "present"], "--"));
    Portal.setText("onBreak", Portal.pick(stats, ["onBreak", "on_break", "breaks"], "--"));
    Portal.setText("lateStaff", Portal.pick(stats, ["lateStaff", "late_staff", "late"], "--"));
    Portal.setText("missingCheckout", Portal.pick(stats, ["missingCheckout", "missing_checkout", "missingCheckOut"], "--"));
    Portal.setText("absentToday", Portal.pick(stats, ["absentToday", "absent_today_count", "absent"], "--"));
    Portal.setText("notWorkingToday", Portal.pick(stats, ["notWorkingToday", "not_working_today", "offToday"], "--"));
    const details = dashboard.summaryDetails || {};
    bindSummaryCard("totalStaff", "Total Staff", details.total_staff);
    bindSummaryCard("onlineStaff", "Online Staff", details.online_staff);
    bindSummaryCard("checkedInToday", "Checked In Today", details.checked_in_today || details.checked_in);
    bindSummaryCard("onBreak", "On Break", details.on_break);
    bindSummaryCard("lateStaff", "Late Staff", details.late_staff);
    bindSummaryCard("missingCheckout", "Missing Checkout", details.missing_checkout);
    bindSummaryCard("absentToday", "Absent Today", details.absent_today || dashboard.absentToday, absentColumns);
    bindSummaryCard("notWorkingToday", "Not Working Today", details.not_working_today);
  };

  const ensureViewButton = (hostId, label, onClick) => {
    const host = document.getElementById(hostId);
    const panel = host?.closest(".glass-panel");
    const title = panel?.querySelector(".panel-title");
    if (!title) return;
    let button = title.querySelector(`[data-view-all="${hostId}"]`);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "mini-btn";
      button.dataset.viewAll = hostId;
      button.textContent = "View All";
      title.appendChild(button);
    }
    button.onclick = onClick;
    button.setAttribute("aria-label", `View all ${label}`);
  };

  const openTableModal = (title, rows, columns) => {
    let modal = document.getElementById("dataModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dataModal";
      modal.className = "data-modal";
      modal.innerHTML = `
        <div class="data-modal__panel">
          <div class="data-modal__head">
            <h2 id="dataModalTitle"></h2>
            <button class="mini-btn" type="button" data-modal-close>Close</button>
          </div>
          <input id="dataModalSearch" class="search-input" placeholder="Search">
          <div class="table-wrap data-modal__table"><table><thead id="dataModalHead"></thead><tbody id="dataModalBody"></tbody></table></div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener("click", (event) => {
        if (event.target === modal || event.target.closest("[data-modal-close]")) modal.classList.remove("open");
      });
    }
    const render = () => {
      const query = document.getElementById("dataModalSearch")?.value.trim().toLowerCase() || "";
      const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)) : rows;
      document.getElementById("dataModalBody").innerHTML = filtered.length
        ? filtered.map((row) => `<tr>${columns.map((column) => `<td>${column.render ? column.render(row) : Portal.pick(row, column.keys, "--")}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${columns.length}" class="empty-state">No records match this search.</td></tr>`;
    };
    document.getElementById("dataModalTitle").textContent = title;
    document.getElementById("dataModalHead").innerHTML = `<tr>${columns.map((column) => `<th>${column.label}</th>`).join("")}</tr>`;
    const search = document.getElementById("dataModalSearch");
    search.value = "";
    search.oninput = render;
    render();
    modal.classList.add("open");
    search.focus();
  };

  const statusTone = (value) => {
    const text = String(value).toLowerCase();
    if (text.includes("late") || text.includes("missing") || text.includes("fail") || text.includes("offline")) return "red";
    if (text.includes("break") || text.includes("pending")) return "amber";
    if (text.includes("online") || text.includes("in") || text.includes("ok") || text.includes("sent")) return "green";
    return "";
  };

  const renderBreaks = (rows) => {
    const host = document.getElementById("breakBoard");
    if (!host) return;
    if (!rows.length) {
      document.querySelector('[data-view-all="breakBoard"]')?.remove();
      return host.innerHTML = empty("No active break records received.", 4);
    }
    ensureViewButton("breakBoard", "live break", () => openTableModal("Live Break Board", rows, [
      { label: "Staff", keys: ["name", "full_name", "staffName", "staff"] },
      { label: "Start", render: (row) => Portal.formatTime(Portal.pick(row, ["breakStart", "start", "startedAt", "event_time", "time"], "")) },
      { label: "Duration", keys: ["duration", "breakDuration"] },
      { label: "Status", render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
    ]));
    host.innerHTML = rows.slice(0, previewLimit).map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "full_name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["breakStart", "start", "startedAt", "event_time", "time"], ""))}</td>
        <td>${Portal.pick(row, ["duration", "breakDuration"], "--")}</td>
        <td>${badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], "")))}</td>
      </tr>`).join("");
  };

  const renderNextShiftStaff = (rows) => {
    const host = document.getElementById("nextShiftStaff");
    if (!host) return;
    if (!rows.length) {
      document.querySelector('[data-view-all="nextShiftStaff"]')?.remove();
      return host.innerHTML = empty("No upcoming working shifts found.", 7);
    }
    const columns = [
      { label: "Staff", keys: ["staff", "full_name", "name", "staffName"] },
      { label: "Team", keys: ["team", "department"] },
      { label: "Date", keys: ["date", "schedule_date"] },
      { label: "Shift", keys: ["shift", "shift_code"] },
      { label: "Start", render: (row) => formatShiftTime12h(Portal.pick(row, ["start", "start_time"], "")) },
      { label: "End", render: (row) => formatShiftTime12h(Portal.pick(row, ["end", "end_time"], "")) },
      { label: "Status", render: (row) => badge(Portal.pick(row, ["status"], "--"), statusTone(Portal.pick(row, ["status"], ""))) }
    ];
    ensureViewButton("nextShiftStaff", "next shift staff", () => openTableModal("Next Shift Staff", rows, columns));
    host.innerHTML = rows.slice(0, 5).map((row) => `
      <tr>
        <td>${Portal.pick(row, ["staff", "full_name", "name", "staffName"], "Staff")}</td>
        <td>${Portal.pick(row, ["team", "department"], "--")}</td>
        <td>${Portal.pick(row, ["date", "schedule_date"], "--")}</td>
        <td>${Portal.pick(row, ["shift", "shift_code"], "--")}</td>
        <td>${formatShiftTime12h(Portal.pick(row, ["start", "start_time"], ""))}</td>
        <td>${formatShiftTime12h(Portal.pick(row, ["end", "end_time"], ""))}</td>
        <td>${badge(Portal.pick(row, ["status"], "--"), statusTone(Portal.pick(row, ["status"], "")))}</td>
      </tr>`).join("");
  };

  const renderCharts = () => {
    drawBars("attendanceChart", [
      ["Online", Number(Portal.pick(dashboard.stats, ["onlineStaff", "online"], 0))],
      ["Checked In", Number(Portal.pick(dashboard.stats, ["checkedInToday", "checkedIn"], 0))],
      ["Break", Number(Portal.pick(dashboard.stats, ["onBreak", "breaks"], 0))],
      ["Late", Number(Portal.pick(dashboard.stats, ["lateStaff", "late"], 0))],
      ["Missing", Number(Portal.pick(dashboard.stats, ["missingCheckout", "missingCheckOut"], 0))]
    ], "#28dcff");


  };

  const prepareCanvas = (canvas, fallbackHeight = 240) => {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.floor(rect.width || canvas.clientWidth || 520));
    const height = Math.max(190, Math.floor(rect.height || fallbackHeight));
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width, height };
  };

  const drawBars = (id, rows, color) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const { ctx, width, height } = prepareCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fillRect(42, 20, width - 62, height - 66);
    if (!rows.length || rows.every((row) => !row[1])) {
      ctx.fillStyle = "#91a8bb";
      ctx.font = "16px system-ui";
      ctx.fillText("No analytics records received", 54, 64);
      return;
    }
    const max = Math.max(...rows.map((row) => row[1]), 1);
    const gap = 12;
    const barWidth = Math.max(24, (width - 82 - gap * (rows.length - 1)) / rows.length);
    rows.forEach((row, index) => {
      const x = 42 + index * (barWidth + gap);
      const h = Math.max(4, (row[1] / max) * (height - 98));
      const y = height - 46 - h;
      const gradient = ctx.createLinearGradient(0, y, 0, height - 46);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, "rgba(40,220,255,.18)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barWidth, h);
      ctx.fillStyle = "#dff7ff";
      ctx.font = "700 13px system-ui";
      ctx.fillText(String(row[1]), x, y - 7);
      ctx.fillStyle = "#91a8bb";
      ctx.font = "12px system-ui";
      ctx.fillText(String(row[0]).slice(0, 10), x, height - 24);
    });
  };

  const filterStaff = (rows) => {
    const query = document.getElementById("staffSearch").value.trim().toLowerCase();
    return query ? rows.filter((row) => [row.full_name, row.login_id, row.staff_id, row.team, row.staffName].some((value) => String(value || "").toLowerCase().includes(query))) : rows;
  };
  const renderAll = () => {
    renderStats(dashboard.stats);
    renderBreaks(filterStaff(dashboard.breaks));
    renderNextShiftStaff(filterStaff(dashboard.nextShiftStaff));
    renderCharts();
  };

  const showReconnect = () => {
    const hasStaleData = stale && Boolean(dashboard.stats);
    Portal.setStatus(hasStaleData ? false : null, hasStaleData ? "Stale data - Reconnecting" : "Reconnecting");
  };

  const load = (silent = false, afterWrite = false) => {
    if (afterWrite && refreshPromise) {
      refreshRevision++;
      return refreshPromise.then(() => load(silent));
    }
    if (refreshPromise) return refreshPromise;
    if (silent && (document.hidden || navigator.onLine === false || performance.now() < nextPollAt)) return;
    if ((stale && dashboard.stats) || transientFailures) showReconnect();
    else Portal.setStatus(null, dashboard.stats ? "Refreshing" : "Loading");
    const revision = refreshRevision;
    refreshPromise = (async () => {
      try {
        const data = await Portal.api.dashboard("admin", { dashboard_mode: "attendance_first" }, {
          canRetry: () => revision === refreshRevision && !document.hidden && navigator.onLine !== false,
          onRetry: showReconnect
        });
        if (revision !== refreshRevision) return;
        const root = data.data || data.dashboard || data;
        const generatedAt = Date.parse(root.generated_at);
        if (generatedAt <= lastGeneratedAt) throw new Error("Dashboard response did not contain newer data.");
        dashboard = normalizeDashboard(data);
        renderAll();
        lastGeneratedAt = generatedAt;
        stale = false;
        transientFailures = 0;
        nextPollAt = 0;
        Portal.setText("lastDashboardUpdate", "Updated " + new Date(generatedAt).toLocaleTimeString());
        Portal.dashboardReady();
      } catch (error) {
        if (revision !== refreshRevision) return;
        stale = true;
        if (Portal.isRetryableReadError(error)) {
          transientFailures = Math.min(transientFailures + 1, 3);
          nextPollAt = performance.now() + pollInterval * 2 ** (transientFailures - 1);
        } else {
          transientFailures = 0;
          nextPollAt = 0;
        }
        Portal.dashboardFailure(Boolean(dashboard.stats), () => load(), error);
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const callFirstValid = async (actions, payload) => {
    let lastError;
    for (const action of actions) {
      try {
        const data = await Portal.api.action(action, payload, { updateStatus: false });
        if (/invalid action/i.test(String(data?.message || data?.error || ""))) {
          lastError = new Error(data.message || data.error);
          continue;
        }
        if (data?.ok === false || data?.success === false) {
          throw new Error(data.message || data.error || `${action} failed`);
        }
        return data;
      } catch (error) {
        if (/invalid action/i.test(String(error.message))) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error("Action is not available");
  };

  const callScheduleUpload = async (payload) => {
    const response = await fetch(Portal.api.base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ action: "upload_schedule_csv", ...payload }),
      cache: "no-store",
      credentials: "omit"
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      data = { ok: response.ok, message: text };
    }
    if (!response.ok || data?.ok === false || data?.success === false) {
      throw new Error(data.message || data.error || `Schedule upload failed (${response.status})`);
    }
    return data;
  };

  const NON_WORKING_SHIFT_CODES = new Set(["OFF", "AL", "UL", "SL", "NP"]);

  const parseCsvRows = (text) => {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"' && quoted && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  };

  const csvDateToKey = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
    const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slash) {
      const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
      return `${year}-${String(slash[1]).padStart(2, "0")}-${String(slash[2]).padStart(2, "0")}`;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  };

  const monthFromDate = (dateKey) => String(dateKey || "").slice(0, 7);

  const normalizeCsvTime = (value) => {
    const raw = String(value || "").trim().replace(/\s+/g, " ").replace(".", ":").replace(/(\d)(AM|PM)$/i, "$1 $2");
    if (!raw) return "";
    const match = raw.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(AM|PM)?$/i);
    if (!match) return raw;
    const hourText = match[1].padStart(2, "0");
    const minute = (match[2] || "00").padStart(2, "0");
    const second = (match[3] || "00").padStart(2, "0");
    const meridiem = String(match[4] || "").toUpperCase();
    const amMap = { "12": "00", "01": "01", "02": "02", "03": "03", "04": "04", "05": "05", "06": "06", "07": "07", "08": "08", "09": "09", "10": "10", "11": "11" };
    const pmMap = { "12": "12", "01": "13", "02": "14", "03": "15", "04": "16", "05": "17", "06": "18", "07": "19", "08": "20", "09": "21", "10": "22", "11": "23" };
    const hour = meridiem === "AM" ? (amMap[hourText] || hourText) : meridiem === "PM" ? (pmMap[hourText] || hourText) : hourText;
    return `${hour}:${minute}:${second}`;
  };

  const scheduleTimeString = (value) => normalizeCsvTime(value);

  const cleanShiftRangeText = (value) => String(value || "")
    .replace(/,+$/g, "")
    .replace(/,+/g, ",")
    .replace(/\s+/g, " ")
    .trim();

  const parseShiftWindow = (value) => {
    const text = cleanShiftRangeText(value).replace(/[\u2013\u2014]/g, "-").replace(/(\d)(AM|PM)/gi, "$1 $2");
    const match = text.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*-\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
    if (match) {
      return { start_time: normalizeCsvTime(match[1]), end_time: normalizeCsvTime(match[2]) };
    }
    const parts = text.split(/\s*-\s*/).map((item) => cleanShiftRangeText(item)).filter(Boolean);
    return { start_time: normalizeCsvTime(parts[0]), end_time: normalizeCsvTime(parts[1]) };
  };

  const csvRowsToObjects = (rows) => {
    if (!rows.length) return [];
    const headers = rows.shift().map((item) => item.trim());
    return rows.map((items) => headers.reduce((record, header, index) => {
      record[header] = items[index] || "";
      return record;
    }, {}));
  };

  const isRosterHeader = (row) => String(row?.[0] || "").replace(/^\uFEFF/, "").trim().toLowerCase() === "agent | date";

  const isSummaryRow = (value) => {
    const first = String(value || "").trim();
    if (!first) return true;
    if (/^\d{1,2}[-/ ]?[a-z]{3,}$/i.test(first)) return true;
    if (/^[a-z]{3,}[-/ ]?\d{1,2}$/i.test(first)) return true;
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(first)) return true;
    return false;
  };

  const parseRosterMatrix = (rows) => {
    const headerIndexes = rows.reduce((indexes, row, index) => {
      if (isRosterHeader(row)) indexes.push(index);
      return indexes;
    }, []);
    if (!headerIndexes.length) return null;

    const errors = [];
    let skipped = 0;
    const shiftMap = {};
    rows.slice(0, headerIndexes[0]).forEach((row) => {
      const code = String(row[0] || "").trim().toUpperCase();
      if (!code || isRosterHeader(row) || NON_WORKING_SHIFT_CODES.has(code)) return;
      const window = parseShiftWindow(row.slice(1).join(","));
      if (window.start_time || window.end_time) {
        shiftMap[code] = {
          start_time: scheduleTimeString(window.start_time),
          end_time: scheduleTimeString(window.end_time)
        };
      }
    });
    console.table(Object.entries(shiftMap).map(([code, value]) => ({
      code,
      start_time: value.start_time,
      end_time: value.end_time
    })));

    const output = [];

    headerIndexes.forEach((headerIndex, blockIndex) => {
      skipped += 2;
      const headers = rows[headerIndex];
      const dateColumns = headers
        .map((header, index) => ({ index, date: index === 0 ? "" : csvDateToKey(header) }))
        .filter((column) => column.date);
      skipped += Math.max(0, headers.length - 1 - dateColumns.length);
      const blockEnd = headerIndexes[blockIndex + 1] || rows.length;

      for (let rowIndex = headerIndex + 2; rowIndex < blockEnd; rowIndex += 1) {
        const row = rows[rowIndex] || [];
        const fullName = String(row[0] || "").trim();
        if (isRosterHeader(row)) break;
        if (isSummaryRow(fullName)) {
          skipped += 1;
          continue;
        }

        dateColumns.forEach((column) => {
          const shiftCode = String(row[column.index] || "").trim().toUpperCase();
          if (!shiftCode) {
            skipped += 1;
            return;
          }
          if (NON_WORKING_SHIFT_CODES.has(shiftCode)) {
            output.push({
              schedule_id: "",
              schedule_month: monthFromDate(column.date),
              schedule_date: column.date,
              staff_id: "",
              login_id: "",
              full_name: fullName,
              team: "",
              shift_code: shiftCode,
              start_time: "",
              end_time: "",
              status: shiftCode,
              uploaded_by: session.loginId || session.staffId || "Admin",
              uploaded_at: new Date().toISOString(),
              notes: "Roster matrix import"
            });
            return;
          }
          const window = shiftMap[shiftCode];
          if (!window) {
            errors.push({ row: rowIndex + 1, message: `Unknown shift code: ${shiftCode} for ${fullName} on ${column.date}` });
            return;
          }
          output.push({
            schedule_id: "",
            schedule_month: monthFromDate(column.date),
            schedule_date: column.date,
            staff_id: "",
            login_id: "",
            full_name: fullName,
            team: "",
            shift_code: shiftCode,
            start_time: scheduleTimeString(window.start_time),
            end_time: scheduleTimeString(window.end_time),
            status: "WORKING",
            uploaded_by: session.loginId || session.staffId || "Admin",
            uploaded_at: new Date().toISOString(),
            notes: "Roster matrix import"
          });
        });
      }
    });

    return { mode: "matrix", rows: output, errors, skipped };
  };

  const parseScheduleCsv = (text) => {
    const rows = parseCsvRows(text);
    const matrix = parseRosterMatrix(rows);
    if (matrix) return matrix;
    return { mode: "flat", rows: csvRowsToObjects(rows), errors: [], skipped: 0 };
  };

  const validateRosterTimesBeforeUpload = (rows) => {
    const timePattern = /^\d{2}:\d{2}:\d{2}$/;
    rows.forEach((row) => {
      if (row.status !== "WORKING") return;
      if (!timePattern.test(String(row.start_time || "")) || !timePattern.test(String(row.end_time || ""))) {
        throw new Error(`Roster time parse failed for ${row.shift_code}. Invalid time ${row.start_time || "blank"} - ${row.end_time || "blank"}.`);
      }
    });
  };

  const exportTable = (name) => {
    const rows = name === "breaks" ? filterStaff(dashboard.breaks || []) : [];
    if (!rows.length) return Portal.toast("No rows available to export");
    const keys = Array.from(rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set()));
    const csv = [keys.join(","), ...rows.map((row) => keys.map((key) => `"${String(row[key] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById("staffSearch").addEventListener("input", () => { if (dashboard.stats) renderAll(); });
  document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => exportTable(button.dataset.export)));
  const scheduleLeaveAcknowledged = document.getElementById("scheduleLeaveAcknowledged");
  const clearLeaveAcknowledgment = () => { if (scheduleLeaveAcknowledged) scheduleLeaveAcknowledged.checked = false; };
  document.getElementById("scheduleFile")?.addEventListener("change", clearLeaveAcknowledgment);
  document.getElementById("clearScheduleUpload")?.addEventListener("click", () => {
    clearLeaveAcknowledgment();
    const input = document.getElementById("scheduleFile");
    const state = document.getElementById("scheduleUploadState");
    if (input) input.value = "";
    if (state) state.hidden = true;
  });
  document.getElementById("scheduleUploadForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const state = document.getElementById("scheduleUploadState");
    if (!scheduleLeaveAcknowledged?.checked) {
      state.hidden = false;
      state.textContent = "Acknowledge the future-leave reminder before submitting the roster.";
      return;
    }
    clearLeaveAcknowledgment();
    const file = document.getElementById("scheduleFile")?.files?.[0];
    if (!file) {
      state.hidden = false;
      state.textContent = "Select a CSV schedule file first.";
      return;
    }
    try {
      state.hidden = false;
      state.textContent = "Uploading roster... please wait.";
      const csv = await file.text();
      const parsed = parseScheduleCsv(csv);
      const rows = parsed.rows;
      if (!rows.length) throw new Error("No schedule rows found in CSV.");
      validateRosterTimesBeforeUpload(rows);
      const frontendFirstRows = rows.slice(0, 10).map((row) => ({
        shift_code: row.shift_code,
        start_time: row.start_time,
        end_time: row.end_time,
        status: row.status
      }));
      console.table(frontendFirstRows);
      const ip = await Portal.api.detectIp();
      const result = await callScheduleUpload({
        admin_login_id: session.loginId || session.staffId,
        ip,
        fileName: file.name,
        csv,
        upload_format: parsed.mode,
        parse_errors: parsed.errors,
        skipped: parsed.skipped || 0,
        frontend_first_10_rows: frontendFirstRows,
        rows,
        schedules: rows
      });
      console.table(result.frontend_first_10_rows || frontendFirstRows);
      console.table(result.backend_first_10_received_rows || []);
      console.table(result.backend_first_10_written_rows || result.written_debug_rows || []);
      const inserted = Number(Portal.pick(result, ["inserted"], 0));
      const updated = Number(Portal.pick(result, ["updated"], 0));
      const failed = Number(Portal.pick(result, ["failed"], 0)) + parsed.errors.length;
      const skipped = Number(Portal.pick(result, ["skipped"], parsed.skipped || 0));
      state.textContent = `Schedule uploaded. Inserted: ${inserted}. Updated: ${updated}. Failed: ${failed}. Skipped: ${skipped}.`;
      Portal.toast("Schedule uploaded");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await load(false, true);
    } catch (error) {
      if (/abort|524|timeout/i.test(String(error.message || ""))) {
        state.textContent = "Upload may still be processing. Refreshing schedule data...";
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await load(false, true);
        return;
      }
      state.textContent = error.message || "Unable to upload schedule.";
    }
  });
  document.getElementById("kpiInputForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const state = document.getElementById("kpiInputState");
    const payload = {
      staffId: document.getElementById("kpiStaffId").value.trim(),
      login_id: document.getElementById("kpiStaffId").value.trim(),
      email: document.getElementById("kpiStaffId").value.trim(),
      month: document.getElementById("kpiMonth").value,
      leadership: Number(document.getElementById("kpiLeadership").value || 0),
      effectiveness: Number(document.getElementById("kpiEffectiveness").value || 0),
      problemSolving: Number(document.getElementById("kpiProblemSolving").value || 0),
      communication: Number(document.getElementById("kpiCommunication").value || 0),
      productivity: Number(document.getElementById("kpiProductivity").value || 0),
      initiative: Number(document.getElementById("kpiInitiative").value || 0),
      penalty: Number(document.getElementById("kpiPenalty").value || 0)
    };
    payload.kpiScore = Math.max(0, (
      payload.leadership +
      payload.effectiveness +
      payload.problemSolving +
      payload.communication +
      payload.productivity +
      payload.initiative -
      payload.penalty
    ) / 6);
    try {
      state.hidden = false;
      state.textContent = "Saving KPI...";
      const ip = await Portal.api.detectIp();
      await callFirstValid(["save_monthly_kpi"], {
        admin_login_id: session.loginId || session.staffId,
        login_id: payload.staffId,
        staff_id: payload.staffId,
        kpi_month: payload.month,
        ip,
        L_Leadership: payload.leadership,
        E_Effectiveness: payload.effectiveness,
        P_ProblemSolving: payload.problemSolving,
        C_Communication: payload.communication,
        PR_Productivity: payload.productivity,
        I_Initiative: payload.initiative,
        Penalty: payload.penalty
      });
      state.textContent = `KPI saved for ${payload.staffId}.`;
      Portal.toast("KPI saved");
      await load(true);
    } catch (error) {
      state.textContent = /invalid action/i.test(String(error.message))
        ? "KPI save action is not enabled in the Worker yet."
        : (error.message || "Unable to save KPI.");
    }
  });
  load();
  const refreshTimer = setInterval(() => load(true), pollInterval);
  document.addEventListener("visibilitychange", () => load(true));
  window.addEventListener("online", async () => {
    await refreshPromise;
    nextPollAt = 0;
    load(true);
  });
  window.addEventListener("offline", () => {
    refreshRevision++;
    stale = true;
    Portal.dashboardFailure(Boolean(dashboard.stats), () => load(), new Error("Network disconnected"));
  });
  window.addEventListener("resize", renderCharts);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
