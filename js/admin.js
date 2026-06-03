(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "admin") location.href = "staff.html";

  const CACHE_KEY = "spv2_admin_dashboard_last_good";
  const SCORE_CACHE_KEY = "spv2_admin_scores_last_good";
  const readCachedDashboard = () => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (error) { return null; }
  };
  const writeCachedDashboard = (data) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (error) {}
  };
  const readCachedScores = () => {
    try { return JSON.parse(localStorage.getItem(SCORE_CACHE_KEY) || "null"); } catch (error) { return null; }
  };
  const writeCachedScores = (data) => {
    try { localStorage.setItem(SCORE_CACHE_KEY, JSON.stringify(data)); } catch (error) {}
  };

  let dashboard = {};
  let refreshTimer;
  let refreshInFlight = false;
  let lastScoreRefreshAt = 0;
  let loggedPerformanceDetails = false;

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
  const loginValue = (row) => String(Portal.pick(row || {}, ["login_id", "email"], "")).toLowerCase();
  const hasScoreValue = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0;
  };
  const hasNonZeroScores = (rows = []) => Portal.normalizeArray(rows).some((row) => {
    row = row || {};
    return [
      "attendance_score",
      "monthly_attendance_score",
      "kpi_score",
      "kpi_score_out_of_5",
      "final_score",
      "monthly_final_score",
      "quarter_score",
      "ranking_score"
    ].some((key) => hasScoreValue(row[key]));
  });
  const canonicalPerformanceRows = (root) => Portal.normalizeArray(root.performance_details || root.performanceDetails || root.performance);
  const scoreFieldKeys = [
    "attendance_score",
    "monthly_attendance_score",
    "kpi_score",
    "kpi_score_out_of_5",
    "final_score",
    "monthly_final_score",
    "quarter_score",
    "current_rank",
    "rank"
  ];
  const payloadRoot = (payload) => payload?.data || payload?.dashboard || payload || {};
  const hasScoreFields = (source = {}) => source && !Array.isArray(source) && typeof source === "object"
    && scoreFieldKeys.some((key) => Object.prototype.hasOwnProperty.call(source, key));
  const hasValidScorePayload = (payload) => {
    const root = payloadRoot(payload);
    if (canonicalPerformanceRows(root).length) return true;
    if (Portal.normalizeArray(root.leaderboard || root.rankings).length) return true;
    if (hasScoreFields(root)) return true;
    return [
      root.staff_score,
      root.score,
      root.performance_summary,
      root.own_kpi,
      root.kpi
    ].some(hasScoreFields);
  };
  const hasRealScorePayload = (payload) => {
    const root = payloadRoot(payload);
    return hasNonZeroScores(canonicalPerformanceRows(root)) ||
      hasNonZeroScores(root.leaderboard || root.rankings || root.topPerformers || root.worstPerformers) ||
      hasNonZeroScores(root.staff_list || root.staff || root.kpi_list || root.kpis) ||
      hasScoreValue(root.attendance_score) ||
      hasScoreValue(root.kpi_score) ||
      hasScoreValue(root.final_score) ||
      hasScoreValue(root.quarter_score);
  };
  const hasRealScoresInDashboard = (value = {}) =>
    hasNonZeroScores(value.performance) ||
    hasNonZeroScores(value.top) ||
    hasNonZeroScores(value.worst) ||
    hasNonZeroScores(value.kpis);
  const hasUsableCachedDashboard = () =>
    hasRealScoresInDashboard(dashboard) ||
    hasRealScoresInDashboard(readCachedScores()) ||
    hasValidScorePayload(readCachedDashboard());
  const isSoftRefreshError = (error) =>
    Portal.isAbortLike(error) ||
    /timeout|timed out|signal is aborted|aborted|cannot read properties of null/i.test(String(error?.message || error || ""));
  const applyCachedScores = (target, cached) => {
    if (!cached || !hasRealScoresInDashboard(cached)) return target;
    target.performance = cached.performance || target.performance;
    target.top = cached.top || target.top;
    target.worst = cached.worst || target.worst;
    target.kpis = cached.kpis || target.kpis;
    target.staff = cached.staff || target.staff;
    return target;
  };
  const cacheScoresFromDashboard = (value) => {
    if (!hasRealScoresInDashboard(value)) return;
    writeCachedScores({
      performance: value.performance,
      top: value.top,
      worst: value.worst,
      kpis: value.kpis,
      staff: value.staff
    });
  };
  const performanceIndex = (rows = []) => rows.reduce((map, row) => {
    const key = loginValue(row);
    if (key) map[key] = row;
    return map;
  }, {});
  const enrichStaffWithPerformance = (staffRows = [], performanceRows = []) => {
    const byLogin = performanceIndex(performanceRows);
    return staffRows.map((row) => {
      const perf = byLogin[loginValue(row)] || {};
      return { ...row, ...perf, status: Portal.pick(row, ["status", "state"], Portal.pick(perf, ["status"], "")) };
    });
  };

  const normalizeDashboard = (data) => {
    const root = data?.data || data?.dashboard || data || {};
    const summary = root.summary || root.today_summary || {};
    const staffList = Portal.normalizeArray(root.staff_list || root.staff || root.staffList || root.users || root.staff_rows);
    const scheduleList = Portal.normalizeArray(root.schedule_list || root.schedules || root.schedule || root.schedule_rows);
    const attendanceEvents = Portal.normalizeArray(root.attendance_events || root.attendanceBoard || root.attendance || root.onlineStaff);
    const kpiList = Portal.normalizeArray(root.kpi_list || root.kpis || root.kpi || root.monthlyKpi || root.kpi_rows);
    const quarterScores = Portal.normalizeArray(root.quarter_scores || root.quarterScores || root.quarter);
    const performanceDetails = canonicalPerformanceRows(root);
    if (performanceDetails.length && !loggedPerformanceDetails) {
      console.table(performanceDetails.slice(0, 10));
      loggedPerformanceDetails = true;
    }
    const nonWorkingCodes = new Set(["OFF", "AL", "UL", "SL", "NP", "LEAVE", "HOLIDAY", ""]);
    const nextShiftStaff = Portal.normalizeArray(root.next_shift_staff_all || root.nextShiftStaffAll || root.next_shift_staff || root.nextShiftStaff || root.next_shifts).filter((row) => {
      const status = String(Portal.pick(row || {}, ["status"], "")).toUpperCase();
      const shift = String(Portal.pick(row || {}, ["shift", "shift_code"], "")).toUpperCase();
      return status === "WORKING" && !nonWorkingCodes.has(shift);
    });
    const dailyScores = Portal.normalizeArray(root.daily_scores || root.dailyScores);
    const auditLogs = Portal.normalizeArray(root.audit_logs || root.auditLogs || root.audit);
    const telegramLogs = Portal.normalizeArray(root.telegram_logs || root.telegramLogs);
    const ipAllowlist = root.ip_allowlist || root.ipAllowlist || root.allowlist || [];
    const hasBreakBoard = Object.prototype.hasOwnProperty.call(root, "breakBoard") || Object.prototype.hasOwnProperty.call(root, "breaks");
    const breakRows = hasBreakBoard
      ? Portal.normalizeArray(root.breakBoard || root.breaks)
      : attendanceEvents.filter((row) => String(Portal.pick(row, ["event_type", "action", "event"], "")).toUpperCase() === "BREAK_START");
    const rankingRows = performanceDetails.length ? performanceDetails : Portal.normalizeArray(root.topPerformers || root.leaderboard || root.rankings || quarterScores || kpiList);
    const worstRows = performanceDetails.length ? performanceDetails.slice().reverse() : Portal.normalizeArray(root.worstPerformers || root.lowPerformers || root.needsCoaching);
    const sortedWorst = worstRows.length
      ? worstRows
      : rankingRows.slice().sort((a, b) => Number(Portal.pick(a, ["final_score", "kpi_score", "kpi_score_out_of_5", "score", "kpi"], 0)) - Number(Portal.pick(b, ["final_score", "kpi_score", "kpi_score_out_of_5", "score", "kpi"], 0)));
    const enrichedStaff = enrichStaffWithPerformance(staffList, performanceDetails);
    const canonicalKpis = performanceDetails.length ? performanceDetails : kpiList;
    return {
      stats: root.stats || root.counters || {
        totalStaff: root.staff_count || summary.total_staff || staffList.length,
        onlineStaff: summary.currently_working || summary.online_staff,
        checkedInToday: summary.checked_in,
        onBreak: summary.on_break,
        lateStaff: summary.late_staff,
        missingCheckout: summary.missing_checkout,
        notWorkingToday: summary.not_working_today
      },
      attendance: attendanceEvents.filter((row) => String(Portal.pick(row, ["event_type", "action", "event"], "")).toUpperCase() !== "BREAK_START"),
      breaks: breakRows,
      staff: enrichedStaff,
      schedules: scheduleList,
      nextShiftStaff,
      kpis: canonicalKpis,
      performance: performanceDetails,
      summaryDetails: root.summary_details || summary.summary_details || root.summaryDetails || {},
      top: rankingRows,
      worst: sortedWorst,
      dailyLogs: Portal.normalizeArray(root.dailyLogs || root.logs).length ? Portal.normalizeArray(root.dailyLogs || root.logs) : attendanceEvents.concat(dailyScores),
      telegramLogs,
      auditLogs,
      ipAllowlist
    };
  };

  const mergeStableDashboard = (previous, next, rawData) => {
    if (!previous || !Object.keys(previous).length) return next;
    const root = payloadRoot(rawData);
    const breaksSupplied = Object.prototype.hasOwnProperty.call(root, "breakBoard") || Object.prototype.hasOwnProperty.call(root, "breaks");
    const keepArray = (key) => (!next[key] || !next[key].length) && previous[key]?.length ? previous[key] : next[key];
    const merged = { ...next };
    ["kpis", "performance", "top", "worst", "nextShiftStaff", "dailyLogs", "telegramLogs", "auditLogs"].forEach((key) => {
      merged[key] = keepArray(key);
    });
    if ((!next.performance || !next.performance.length) && previous.performance?.length && hasNonZeroScores(previous.performance)) {
      merged.performance = previous.performance;
      merged.top = previous.top?.length ? previous.top : previous.performance;
      merged.worst = previous.worst?.length ? previous.worst : previous.performance.slice().reverse();
      merged.kpis = previous.performance;
      if (next.staff?.length) merged.staff = enrichStaffWithPerformance(next.staff, previous.performance);
    }
    if (next.performance?.length && hasNonZeroScores(next.performance)) {
      merged.staff = enrichStaffWithPerformance(next.staff || previous.staff || [], next.performance);
      merged.kpis = next.performance;
      merged.top = next.top?.length ? next.top : next.performance;
      merged.worst = next.worst?.length ? next.worst : next.performance.slice().reverse();
    }
    if ((!merged.staff || !merged.staff.length) && previous.staff?.length) merged.staff = previous.staff;
    if ((!merged.schedules || !merged.schedules.length) && previous.schedules?.length) merged.schedules = previous.schedules;
    if ((!merged.attendance || !merged.attendance.length) && previous.attendance?.length) merged.attendance = previous.attendance;
    if ((!merged.breaks || !merged.breaks.length) && previous.breaks?.length && !breaksSupplied) merged.breaks = previous.breaks;
    return merged;
  };

  dashboard = applyCachedScores(normalizeDashboard(readCachedDashboard() || {}), readCachedScores());

  const summaryColumns = [
    { label: "Staff", keys: ["full_name", "name", "staff", "staffName"] },
    { label: "Team", keys: ["team", "department"] },
    { label: "Date", keys: ["date", "schedule_date", "event_date"] },
    { label: "Shift", keys: ["shift_code", "shift"] },
    { label: "Start", render: (row) => formatShiftTime12h(Portal.pick(row, ["start_time", "start"], "")) },
    { label: "End", render: (row) => formatShiftTime12h(Portal.pick(row, ["end_time", "end"], "")) },
    { label: "Status", render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
  ];
  const bindSummaryCard = (id, title, rows) => {
    const card = document.getElementById(id)?.closest(".metric-card");
    if (!card) return;
    card.onclick = () => openTableModal(title, Portal.normalizeArray(rows), summaryColumns);
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
    Portal.setText("totalStaff", Portal.pick(stats, ["totalStaff", "staffTotal", "total"], dashboard.staff.length || "--"));
    Portal.setText("onlineStaff", Portal.pick(stats, ["onlineStaff", "online_staff", "currently_working", "online"], "--"));
    Portal.setText("checkedInToday", Portal.pick(stats, ["checkedInToday", "checked_in", "checkedIn", "present"], "--"));
    Portal.setText("onBreak", Portal.pick(stats, ["onBreak", "on_break", "breaks"], "--"));
    Portal.setText("lateStaff", Portal.pick(stats, ["lateStaff", "late_staff", "late"], "--"));
    Portal.setText("missingCheckout", Portal.pick(stats, ["missingCheckout", "missing_checkout", "missingCheckOut"], "--"));
    Portal.setText("notWorkingToday", Portal.pick(stats, ["notWorkingToday", "not_working_today", "offToday"], "--"));
    const details = dashboard.summaryDetails || {};
    bindSummaryCard("totalStaff", "Total Staff", details.total_staff || dashboard.staff);
    bindSummaryCard("onlineStaff", "Online Staff", details.online_staff);
    bindSummaryCard("checkedInToday", "Checked In Today", details.checked_in);
    bindSummaryCard("onBreak", "On Break", details.on_break);
    bindSummaryCard("lateStaff", "Late Staff", details.late_staff);
    bindSummaryCard("missingCheckout", "Missing Checkout", details.missing_checkout);
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

  const renderAttendance = (rows) => {
    const host = document.getElementById("attendanceBoard");
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No live attendance records received.", 5);
    ensureViewButton("attendanceBoard", "live attendance", () => openTableModal("Live Attendance Board", rows, [
      { label: "Staff", keys: ["name", "full_name", "staffName", "staff"] },
      { label: "Team", keys: ["department", "team"] },
      { label: "Status", render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) },
      { label: "Time", render: (row) => Portal.formatTime(Portal.pick(row, ["checkIn", "check_in", "in", "event_time", "time"], "")) },
      { label: "IP", keys: ["ip", "ipAddress"] }
    ]));
    host.innerHTML = rows.slice(0, previewLimit).map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "full_name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.pick(row, ["department", "team"], "--")}</td>
        <td>${badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], "")))}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["checkIn", "check_in", "in", "event_time", "time"], ""))}</td>
        <td>${Portal.pick(row, ["ip", "ipAddress"], "--")}</td>
      </tr>`).join("");
  };

  const renderBreaks = (rows) => {
    const host = document.getElementById("breakBoard");
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No active break records received.", 4);
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

  const renderStaff = (rows) => {
    const host = document.getElementById("staffTable");
    const query = document.getElementById("staffSearch")?.value.trim().toLowerCase() || "";
    const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)) : rows;
    if (!host) return;
    if (!filtered.length) return host.innerHTML = empty("No staff records match the current filter.", 5);
    ensureViewButton("staffTable", "staff management", () => openTableModal("Staff Management", rows, [
      { label: "Name", keys: ["name", "full_name", "fullName", "staffName"] },
      { label: "Team", keys: ["department", "team"] },
      { label: "Role", keys: ["role", "position"] },
      { label: "Attendance", keys: ["attendance_score", "monthly_attendance_score"] },
      { label: "KPI", keys: ["kpi_score", "kpi_score_out_of_5", "kpi", "kpiScore"] },
      { label: "Final", keys: ["final_score", "score"] },
      { label: "Rank", keys: ["rank", "position"] },
      { label: "Status", render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
    ]));
    host.innerHTML = filtered.slice(0, previewLimit).map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "full_name", "fullName", "staffName"], "Staff")}</td>
        <td>${Portal.pick(row, ["role", "position"], "--")}</td>
        <td>${Portal.pick(row, ["department", "team"], "--")}</td>
        <td>F ${Portal.pick(row, ["final_score", "score"], "0")} / A ${Portal.pick(row, ["attendance_score", "monthly_attendance_score"], "0")} / K ${Portal.pick(row, ["kpi_score", "kpi_score_out_of_5", "kpi", "kpiScore"], "0")}</td>
        <td>${badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], "")))}</td>
      </tr>`).join("");
  };

  const renderSchedules = (rows) => {
    const host = document.getElementById("scheduleTable");
    if (!host) return;
    const sorted = rows.slice().sort((a, b) => {
      const dateCompare = String(Portal.pick(a, ["schedule_date", "day", "date"], "")).localeCompare(String(Portal.pick(b, ["schedule_date", "day", "date"], "")));
      if (dateCompare) return dateCompare;
      return String(Portal.pick(a, ["full_name", "name", "staffName", "staff"], "")).localeCompare(String(Portal.pick(b, ["full_name", "name", "staffName", "staff"], "")));
    });
    if (!sorted.length) return host.innerHTML = empty("No schedule rows received.", 6);
    ensureViewButton("scheduleTable", "schedule management", () => openTableModal("Schedule Management", sorted, [
      { label: "Staff", keys: ["full_name", "name", "staffName", "staff"] },
      { label: "Team", keys: ["team", "department"] },
      { label: "Date", keys: ["schedule_date", "day", "date"] },
      { label: "Shift", keys: ["shift_code", "shift", "shiftName", "name"] },
      { label: "Start", render: (row) => formatShiftTime12h(Portal.pick(row, ["start_time", "start", "startTime"], "")) },
      { label: "End", render: (row) => formatShiftTime12h(Portal.pick(row, ["end_time", "end", "endTime"], "")) },
      { label: "Status", render: (row) => badge(Portal.pick(row, ["status"], "--"), statusTone(Portal.pick(row, ["status"], ""))) }
    ]));
    host.innerHTML = sorted.slice(0, previewLimit).map((row) => `
      <tr>
        <td>${Portal.pick(row, ["full_name", "name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.pick(row, ["schedule_date", "day", "date"], "--")}</td>
        <td>${Portal.pick(row, ["shift_code", "shift", "shiftName", "name"], "--")}</td>
        <td>${formatShiftTime12h(Portal.pick(row, ["start_time", "start", "startTime"], ""))}</td>
        <td>${formatShiftTime12h(Portal.pick(row, ["end_time", "end", "endTime"], ""))}</td>
        <td>${badge(Portal.pick(row, ["status"], "--"), statusTone(Portal.pick(row, ["status"], "")))}</td>
      </tr>`).join("");
  };

  const ensureNextShiftPanel = () => {
    if (document.getElementById("nextShiftStaff")) return;
    const staffPanel = document.getElementById("staffTable")?.closest(".glass-panel");
    const schedulePanel = document.getElementById("scheduleTable")?.closest(".glass-panel");
    schedulePanel?.classList.add("full-span");
    const panel = document.createElement("article");
    panel.className = "glass-panel table-panel";
    panel.innerHTML = `
      <div class="panel-title"><h2>Next Shift Staff</h2><span>Upcoming</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Staff</th><th>Team</th><th>Date</th><th>Shift</th><th>Start</th><th>End</th><th>Status</th></tr></thead>
          <tbody id="nextShiftStaff"></tbody>
        </table>
      </div>`;
    (staffPanel || schedulePanel)?.insertAdjacentElement("afterend", panel);
  };

  const renderNextShiftStaff = (rows) => {
    ensureNextShiftPanel();
    const host = document.getElementById("nextShiftStaff");
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No upcoming working shifts found.", 7);
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

  const renderKpi = (rows) => {
    const host = document.getElementById("kpiTable");
    const performanceRows = dashboard.performance || [];
    const sourceRows = performanceRows.length ? performanceRows : rows;
    Portal.setText("kpiRows", `${sourceRows.length} rows`);
    if (!host) return;
    if (!sourceRows.length) return host.innerHTML = empty("No KPI rows received.", 5);
    ensureViewButton("kpiTable", "monthly KPI management", () => openTableModal("Monthly KPI Management", sourceRows, [
      { label: "Staff", keys: ["full_name", "name", "staffName", "staff"] },
      { label: "Team", keys: ["team", "department"] },
      { label: "Month", keys: ["kpi_month", "month", "period"] },
      { label: "Attendance", keys: ["attendance_score", "monthly_attendance_score"] },
      { label: "KPI", keys: ["kpi_score", "kpi_score_out_of_5", "kpi", "kpiScore"] },
      { label: "Final", keys: ["final_score", "score"] },
      { label: "Quarter", keys: ["quarter_score", "quarterScore"] },
      { label: "Rank", keys: ["rank", "position"] }
    ]));
    host.innerHTML = sourceRows.slice(0, previewLimit).map((row) => `
      <tr>
        <td>${Portal.pick(row, ["full_name", "name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.pick(row, ["kpi_month", "month", "period"], new Date().toISOString().slice(0, 7))}</td>
        <td>${Portal.pick(row, ["kpi_score", "kpi_score_out_of_5", "kpi", "kpiScore"], "0")}</td>
        <td>${Portal.pick(row, ["final_score", "score"], "0")}</td>
        <td>${Portal.pick(row, ["rank", "position"], "--")}</td>
      </tr>`).join("");
  };

  const renderLeaders = (id, rows) => {
    const host = document.getElementById(id);
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">Ranking records are not available yet.</div>`;
      return;
    }
    ensureViewButton(id, id === "topPerformers" ? "top performers" : "needs coaching", () => openTableModal(id === "topPerformers" ? "Top Performers" : "Needs Coaching", rows, [
      { label: "Rank", keys: ["rank", "position"] },
      { label: "Staff", keys: ["full_name", "name", "staffName", "staff"] },
      { label: "Team", keys: ["department", "team"] },
      { label: "Attendance", keys: ["attendance_score", "monthly_attendance_score"] },
      { label: "KPI", keys: ["kpi_score", "kpi_score_out_of_5", "kpi", "kpiScore"] },
      { label: "Final", keys: ["final_score", "score"] },
      { label: "Quarter", keys: ["quarter_score", "quarterScore"] }
    ]));
    host.innerHTML = rows.slice(0, previewLimit).map((row, index) => `
      <div class="leader-row">
        <span class="leader-rank">${Portal.pick(row, ["rank", "position"], index + 1)}</span>
        <div><strong>${Portal.pick(row, ["full_name", "name", "staffName", "staff"], "Staff")}</strong><br><small>${Portal.pick(row, ["department", "team"], "")}</small></div>
        <strong>${Portal.pick(row, ["ranking_score", "quarter_score", "final_score", "kpi_score", "kpi_score_out_of_5", "score", "kpi", "quarterScore"], "0")}</strong>
      </div>`).join("");
  };

  const renderLogs = (id, rows, columns, options = {}) => {
    const host = document.getElementById(id);
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No log records received.", columns.length);
    if (options.modalTitle) {
      ensureViewButton(id, options.viewLabel || options.modalTitle.toLowerCase(), () => openTableModal(options.modalTitle, rows, columns));
    }
    host.innerHTML = rows.slice(0, options.limit || 80).map((row) => `
      <tr>${columns.map((column) => `<td>${column.render ? column.render(row) : Portal.pick(row, column.keys, "--")}</td>`).join("")}</tr>`).join("");
  };

  const renderIpAllowlist = (value) => {
    const textarea = document.getElementById("ipAllowlist");
    if (!textarea || textarea.dataset.touched) return;
    textarea.value = Array.isArray(value)
      ? value.map((row) => typeof row === "string" ? row : Portal.pick(row, ["ip_address", "ip", "address", "value"], "")).filter(Boolean).join("\n")
      : String(value || "");
  };

  const renderCharts = () => {
    drawBars("attendanceChart", [
      ["Online", Number(Portal.pick(dashboard.stats, ["onlineStaff", "online"], 0))],
      ["Checked In", Number(Portal.pick(dashboard.stats, ["checkedInToday", "checkedIn"], 0))],
      ["Break", Number(Portal.pick(dashboard.stats, ["onBreak", "breaks"], 0))],
      ["Late", Number(Portal.pick(dashboard.stats, ["lateStaff", "late"], 0))],
      ["Missing", Number(Portal.pick(dashboard.stats, ["missingCheckout", "missingCheckOut"], 0))]
    ], "#28dcff");

    drawKpiAnalytics("kpiChart", dashboard.performance?.length ? dashboard.performance : dashboard.kpis);
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

  const drawKpiAnalytics = (id, rows) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const { ctx, width, height } = prepareCanvas(canvas);
    const scores = rows
      .map((row) => Number(Portal.pick(row, ["kpi_score", "kpi_score_out_of_5", "kpi", "kpiScore", "score"], NaN)))
      .filter((score) => Number.isFinite(score));

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fillRect(42, 74, width - 62, height - 120);

    if (!scores.length) {
      ctx.fillStyle = "#91a8bb";
      ctx.font = "16px system-ui";
      ctx.fillText("No KPI records received", 54, 64);
      return;
    }

    const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const high = Math.max(...scores);
    const low = Math.min(...scores);
    const buckets = [0, 0, 0, 0, 0];
    scores.forEach((score) => {
      const index = Math.min(4, Math.max(0, Math.floor(score === 5 ? 4 : score)));
      buckets[index] += 1;
    });

    ctx.fillStyle = "#dff7ff";
    ctx.font = "800 15px system-ui";
    ctx.fillText(`Avg ${avg.toFixed(2)}`, 54, 38);
    ctx.fillText(`High ${high.toFixed(2)}`, 190, 38);
    ctx.fillText(`Low ${low.toFixed(2)}`, 326, 38);

    const labels = ["0-1", "1-2", "2-3", "3-4", "4-5"];
    const max = Math.max(...buckets, 1);
    const gap = 16;
    const barWidth = Math.max(34, (width - 92 - gap * (buckets.length - 1)) / buckets.length);
    buckets.forEach((count, index) => {
      const x = 42 + index * (barWidth + gap);
      const h = Math.max(4, (count / max) * (height - 146));
      const y = height - 46 - h;
      const gradient = ctx.createLinearGradient(0, y, 0, height - 46);
      gradient.addColorStop(0, "#54f5a8");
      gradient.addColorStop(1, "rgba(84,245,168,.16)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barWidth, h);
      ctx.fillStyle = "#dff7ff";
      ctx.font = "700 13px system-ui";
      ctx.fillText(String(count), x, y - 7);
      ctx.fillStyle = "#91a8bb";
      ctx.font = "12px system-ui";
      ctx.fillText(labels[index], x, height - 24);
    });
  };

  const renderAll = () => {
    renderStats(dashboard.stats);
    renderAttendance(dashboard.attendance);
    renderBreaks(dashboard.breaks);
    renderStaff(dashboard.staff);
    renderSchedules(dashboard.schedules);
    renderNextShiftStaff(dashboard.nextShiftStaff || []);
    renderKpi(dashboard.kpis);
    renderLeaders("topPerformers", dashboard.top);
    renderLeaders("worstPerformers", dashboard.worst);
    renderLogs("dailyLogs", dashboard.dailyLogs, [
      { render: (row) => Portal.formatTime(Portal.pick(row, ["created_at", "time", "timestamp", "createdAt"], "")) },
      { keys: ["full_name", "name", "staffName", "staff"] },
      { keys: ["event_type", "action", "event"] },
      { render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
    ], { limit: 5, modalTitle: "Daily Logs", viewLabel: "daily logs" });
    renderLogs("telegramLogs", dashboard.telegramLogs, [
      { render: (row) => Portal.formatTime(Portal.pick(row, ["created_at", "time", "timestamp", "createdAt"], "")) },
      { keys: ["target", "chat", "recipient", "login_id"] },
      { keys: ["message", "text", "event_type"] },
      { render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
    ], { limit: 5, modalTitle: "Telegram Logs", viewLabel: "telegram logs" });
    const auditColumns = [
      { label: "Time", render: (row) => Portal.formatTime(Portal.pick(row, ["created_at", "time", "timestamp", "createdAt"], "")) },
      { label: "User", keys: ["actor_name", "user", "name", "email"] },
      { label: "Action", keys: ["action", "event"] },
      { label: "IP", keys: ["ip", "ipAddress"] },
      { label: "Result", render: (row) => badge(Portal.pick(row, ["result", "status", "state"], "--"), statusTone(Portal.pick(row, ["result", "status", "state"], ""))) }
    ];
    renderLogs("auditLogs", dashboard.auditLogs, auditColumns, { limit: 5, modalTitle: "Audit Logs" });
    renderIpAllowlist(dashboard.ipAllowlist);
    renderCharts();
  };

  const load = async (silent = false) => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    if (!silent) Portal.setStatus(false, "Loading");
    try {
      const data = await Portal.api.dashboard("admin", { month: "" });
      const root = data?.data || data?.dashboard || data || {};
      const incomingPerformance = canonicalPerformanceRows(root);
      const hadPerformance = dashboard.performance?.length;
      const scorePayloadValid = hasValidScorePayload(data);
      const scorePayloadReal = hasRealScorePayload(data);
      const cachedRealScores = hasRealScoresInDashboard(dashboard);
      const allowScoreRefresh = !silent || !lastScoreRefreshAt || Date.now() - lastScoreRefreshAt >= 60000;
      const nextDashboard = normalizeDashboard(data);
      if ((!allowScoreRefresh || !scorePayloadValid || (cachedRealScores && !scorePayloadReal)) && cachedRealScores) {
        applyCachedScores(nextDashboard, dashboard);
        applyCachedScores(nextDashboard, readCachedScores());
        if (nextDashboard.performance?.length) {
          nextDashboard.staff = enrichStaffWithPerformance(nextDashboard.staff?.length ? nextDashboard.staff : dashboard.staff, nextDashboard.performance);
        }
      }
      dashboard = mergeStableDashboard(dashboard, nextDashboard, data);
      if (allowScoreRefresh && scorePayloadValid && (!cachedRealScores || scorePayloadReal)) {
        lastScoreRefreshAt = Date.now();
        cacheScoresFromDashboard(dashboard);
      }
      if ((scorePayloadValid && (!cachedRealScores || scorePayloadReal)) || !hadPerformance) writeCachedDashboard(data);
      renderAll();
      Portal.setStatus(true, "Live");
    } catch (error) {
      const hasCache = hasUsableCachedDashboard();
      if (!Object.keys(dashboard || {}).length) {
        dashboard = applyCachedScores(normalizeDashboard(readCachedDashboard() || {}), readCachedScores());
        renderAll();
      }
      if (isSoftRefreshError(error) || hasCache) {
        Portal.setStatus(true, "Live");
        return;
      }
      Portal.setStatus(false, "API issue");
      if (!/invalid action/i.test(String(error.message))) Portal.toast(error.message || "Unable to load admin dashboard", "error");
    } finally {
      refreshInFlight = false;
    }
  };

  const callFirstValid = async (actions, payload) => {
    let lastError;
    for (const action of actions) {
      try {
        const data = await Portal.api.action(action, payload);
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
    const map = {
      attendance: dashboard.attendance,
      breaks: dashboard.breaks,
      schedule: dashboard.schedules,
      dailyLogs: dashboard.dailyLogs,
      telegramLogs: dashboard.telegramLogs,
      auditLogs: dashboard.auditLogs
    };
    const rows = map[name] || [];
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

  document.getElementById("staffSearch")?.addEventListener("input", () => renderStaff(dashboard.staff || []));
  document.getElementById("ipAllowlist")?.addEventListener("input", (event) => event.target.dataset.touched = "1");
  document.querySelectorAll("[data-export]").forEach((btn) => btn.addEventListener("click", () => exportTable(btn.dataset.export)));
  document.querySelector("[data-refresh]")?.addEventListener("click", () => load());
  document.getElementById("clearScheduleUpload")?.addEventListener("click", () => {
    const input = document.getElementById("scheduleFile");
    const state = document.getElementById("scheduleUploadState");
    if (input) input.value = "";
    if (state) state.hidden = true;
  });
  document.getElementById("scheduleUploadForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const state = document.getElementById("scheduleUploadState");
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
      await load(true);
    } catch (error) {
      if (/abort|524|timeout/i.test(String(error.message || ""))) {
        state.textContent = "Upload may still be processing. Refreshing schedule data...";
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await load(true);
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
  document.getElementById("saveIpBtn")?.addEventListener("click", async () => {
    const state = document.getElementById("ipSaveState");
    try {
      const ips = document.getElementById("ipAllowlist").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      const ip = await Portal.api.detectIp();
      await callFirstValid(["save_ip_allowlist", "saveIpAllowlist"], {
        admin_login_id: session.loginId || session.staffId,
        ip,
        ips,
        ipAllowlist: ips
      });
      state.hidden = false;
      state.textContent = "IP allowlist saved through Worker.";
      Portal.toast("IP allowlist saved");
    } catch (error) {
      state.hidden = false;
      state.textContent = error.message || "Unable to save IP allowlist.";
    }
  });

  load();
  refreshTimer = setInterval(() => load(true), 15000);
  window.addEventListener("resize", renderCharts);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
