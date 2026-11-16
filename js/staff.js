(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "staff") location.href = "admin.html";

  const CACHE_KEY = `spv2_staff_operations_last_good_${session.loginId || session.staffId || "staff"}`;
  const readCachedDashboard = () => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (error) { return null; }
  };
  const writeCachedDashboard = (data) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (error) {}
  };
  let state = {};
  let refreshTimer;
  let refreshInFlight = false;
  let refreshPromise = null;
  let attendanceActionInFlight = false;
  let bootstrapPromise = null;
  let pollingStarted = false;
  let breakStartedAt = null;
  let scheduleMonthTouched = false;
  const BREAK_RULES = {
    BREAK: { label: "Break", limit: 1, minutes: 60 },
    BIO_BREAK: { label: "Bio Break", limit: 3, minutes: 10 },
    PRAYER_BREAK: { label: "Prayer Break", limit: 3, minutes: 15 }
  };

  const empty = (message) => `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
  const badge = (text, tone = "") => `<span class="badge ${tone}">${text || "--"}</span>`;
  const previewLimit = 5;
  const initials = (name) => String(name || "SP").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const noScheduleMessage = "No schedule found for this day. Please contact admin.";
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
  const nonWorkingMessage = (value) => `Today is your ${String(value || "OFF").toUpperCase()} day.`;
  const isNonWorkingSchedule = (schedule) => {
    const shift = String(Portal.pick(schedule, ["shift_code"], "")).toUpperCase();
    const status = String(Portal.pick(schedule, ["status"], "")).toUpperCase();
    return ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(shift) || ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(status);
  };
  const nonWorkingValue = (schedule) => {
    const shift = String(Portal.pick(schedule, ["shift_code"], "")).toUpperCase();
    const status = String(Portal.pick(schedule, ["status"], "")).toUpperCase();
    return ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(shift) ? shift : status || "OFF";
  };
  const normalizeDashboard = (data) => {
    const root = data?.data || data?.dashboard || data || {};
    const staff = root.staff || root.profile || root.user || session.raw || {};
    const schedule = root.today_schedule || root.schedule || root.shift || {};
    const attendance = root.attendance_state || root.today || root.attendance || root.current || {};
    const hasSchedule = schedule && schedule.ok !== false && Boolean(Portal.pick(schedule, ["schedule_date", "shift_code", "status", "start_time", "end_time"], ""));
    const nonWorking = hasSchedule && isNonWorkingSchedule(schedule);
    const actionBlockMessage = !hasSchedule ? noScheduleMessage : nonWorking ? nonWorkingMessage(nonWorkingValue(schedule)) : "";
    const upcoming = Portal.normalizeArray(root.upcoming_schedule || root.upcomingSchedule || root.nextSchedule);
    const nextSchedule = Portal.normalizeArray(root.next_7_schedule || root.next7Schedule);
    const selectedMonth = document.getElementById("scheduleMonth")?.value || root.selected_month || new Date().toISOString().slice(0, 7);
    const scheduleList = upcoming.length ? upcoming : selectedMonth === new Date().toISOString().slice(0, 7) && nextSchedule.length ? nextSchedule : Portal.normalizeArray(root.monthly_schedule);
    return {
      staff,
      today: { ...attendance,
        status: attendance.hasCheckOut ? "Checked out" : attendance.hasCheckIn ? "Checked in" : "Not checked in",
        breakStatus: attendance.activeBreak ? attendance.activeBreak.replaceAll("_", " ") : "Not on break",
        ipAllowed: true, actionBlocked: Boolean(actionBlockMessage), actionBlockMessage },
      shift: { ...schedule, name: Portal.pick(schedule, ["shift_code", "shift", "name"], "Today shift"),
        start: Portal.pick(schedule, ["start_time", "start", "startTime"], ""), end: Portal.pick(schedule, ["end_time", "end", "endTime"], "") },
      scheduleList,
      tomorrowSchedule: root.tomorrow_schedule || {},
      ip: root.ip || root.ipStatus || { allowed: true, message: "IP allowed" }
    };
  };

  const cachedDashboard = readCachedDashboard();
  state = Portal.validDashboard("staff", cachedDashboard) ? normalizeDashboard(cachedDashboard) : {};

  const ensureStaffViewButton = (hostId, label, disabled, onClick) => {
    const host = document.getElementById(hostId);
    const panelTitle = host?.closest(".glass-panel")?.querySelector(".panel-title");
    if (!panelTitle) return;
    let button = panelTitle.querySelector(`[data-staff-view-all="${hostId}"]`);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "mini-btn";
      button.dataset.staffViewAll = hostId;
      button.textContent = label;
      panelTitle.appendChild(button);
    }
    button.disabled = Boolean(disabled);
    button.onclick = onClick;
  };

  const openStaffTableModal = (title, rows, columns) => {
    let modal = document.getElementById("staffDataModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "staffDataModal";
      modal.className = "data-modal";
      modal.innerHTML = `
        <div class="data-modal__panel">
          <div class="data-modal__head">
            <h2 id="staffDataModalTitle">Records</h2>
            <button class="mini-btn" type="button" data-modal-close>Close</button>
          </div>
          <input id="staffDataModalSearch" class="search-input" placeholder="Search records">
          <div class="table-wrap data-modal__table">
            <table>
              <thead id="staffDataModalHead"></thead>
              <tbody id="staffDataModalBody"></tbody>
            </table>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener("click", (event) => {
        if (event.target === modal || event.target.closest("[data-modal-close]")) modal.classList.remove("open");
      });
    }
    document.getElementById("staffDataModalTitle").textContent = title;
    document.getElementById("staffDataModalHead").innerHTML = `<tr>${columns.map((column) => `<th>${column.label}</th>`).join("")}</tr>`;
    const render = () => {
      const query = document.getElementById("staffDataModalSearch")?.value.trim().toLowerCase() || "";
      const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)) : rows;
      document.getElementById("staffDataModalBody").innerHTML = filtered.length ? filtered.map((row) => `
        <tr>${columns.map((column) => `<td>${column.render ? column.render(row) : Portal.pick(row, column.keys, "--")}</td>`).join("")}</tr>
      `).join("") : `<tr><td colspan="${columns.length}" class="empty-state">No records match this search.</td></tr>`;
    };
    const search = document.getElementById("staffDataModalSearch");
    search.value = "";
    search.oninput = render;
    render();
    modal.classList.add("open");
    search.focus();
  };

  const shiftProgress = (shift) => {
    const start = new Date(Portal.pick(shift, ["start", "startTime", "shiftStart"], ""));
    const end = new Date(Portal.pick(shift, ["end", "endTime", "shiftEnd"], ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return Portal.percent(Portal.pick(shift, ["progress"], 0));
    const now = Date.now();
    return Portal.percent(((now - start.getTime()) / (end.getTime() - start.getTime())) * 100);
  };

  const renderProfile = ({ staff, today, shift, scheduleList, tomorrowSchedule, ip }) => {
    const name = Portal.pick(staff, ["full_name", "name", "fullName", "staffName", "displayName"], session.name);
    Portal.setText("staffGreeting", `Welcome back, ${name}`);
    Portal.setText("staffInitials", initials(name));
    Portal.setText("staffName", name);
    Portal.setText("staffMeta", [Portal.pick(staff, ["role", "position"], "Staff"), Portal.pick(staff, ["department", "team"], "")].filter(Boolean).join(" / "));

    const ipOk = Boolean(Portal.pick(ip, ["allowed", "isAllowed", "ok"], false) || Portal.pick(today, ["ipAllowed"], false));
    const ipEl = document.getElementById("ipStatus");
    if (ipEl) {
      ipEl.textContent = ipOk ? "IP allowed" : Portal.pick(ip, ["message", "status"], "IP pending");
      ipEl.classList.toggle("safe", ipOk);
      ipEl.classList.toggle("warn", !ipOk);
    }

    Portal.setText("shiftName", Portal.pick(shift, ["name", "shift", "title"], "Assigned shift"));
    const start = Portal.pick(shift, ["start", "startTime", "shiftStart"], Portal.pick(today, ["shiftStart"], ""));
    const end = Portal.pick(shift, ["end", "endTime", "shiftEnd"], Portal.pick(today, ["shiftEnd"], ""));
    Portal.setText("shiftWindow", `${formatShiftTime12h(start)} - ${formatShiftTime12h(end)}`);
    document.getElementById("shiftProgress").style.width = `${shiftProgress(shift)}%`;
    Portal.setText("lateWarning", Portal.pick(today, ["actionBlockMessage"], "") || Portal.pick(today, ["lateWarning", "lateMessage"], Portal.pick(today, ["isLate"], false) ? "Late warning active" : "On-time status monitored"));

    const attendanceStatus = Portal.pick(today, ["status", "attendanceStatus", "state"], "Not checked in");
    const breakStatus = Portal.pick(today, ["breakStatus", "currentBreakStatus"], "Not on break");
    Portal.setText("attendanceStatus", attendanceStatus);
    Portal.setText("breakStatus", breakStatus);
    renderUpcomingSchedule(scheduleList, tomorrowSchedule);
    updateActionStates(today);
  };

  const renderUpcomingSchedule = (rows, tomorrow) => {
    const host = document.getElementById("upcomingSchedule");
    if (!host) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let list = rows.filter((row) => {
      const date = new Date(`${Portal.pick(row, ["date", "schedule_date"], "")}T00:00:00`);
      return !Number.isNaN(date.getTime()) && date >= today;
    });
    if (tomorrow?.ok && !list.some((row) => Portal.pick(row, ["date", "schedule_date"], "") === Portal.pick(tomorrow, ["schedule_date", "date"], ""))) {
      list.push({
        date: Portal.pick(tomorrow, ["schedule_date", "date"], ""),
        shift_code: Portal.pick(tomorrow, ["shift_code"], ""),
        start_time: Portal.pick(tomorrow, ["start_time"], ""),
        end_time: Portal.pick(tomorrow, ["end_time"], ""),
        status: Portal.pick(tomorrow, ["status"], "")
      });
    }
    list.sort((a, b) => String(Portal.pick(a, ["date", "schedule_date"], "")).localeCompare(String(Portal.pick(b, ["date", "schedule_date"], ""))));
    const columns = [
      { label: "Date", render: (row) => Portal.formatDate(Portal.pick(row, ["date", "schedule_date"], "")) },
      { label: "Shift", keys: ["shift_code", "shift"] },
      { label: "Start", render: (row) => formatShiftTime12h(Portal.pick(row, ["start_time", "start"], "")) },
      { label: "End", render: (row) => formatShiftTime12h(Portal.pick(row, ["end_time", "end"], "")) },
      { label: "Status", render: (row) => badge(Portal.pick(row, ["status"], "--"), statusTone(Portal.pick(row, ["status"], ""))) }
    ];
    ensureStaffViewButton("upcomingSchedule", "View All", !list.length, () => openStaffTableModal("Upcoming Schedule", list, columns));
    const output = list.slice(0, 7);
    if (!output.length) {
      host.innerHTML = empty("No upcoming schedule found for selected month.");
      return;
    }
    host.innerHTML = output.map((row) => `
      <tr>
        <td>${Portal.formatDate(Portal.pick(row, ["date", "schedule_date"], ""))}</td>
        <td>${Portal.pick(row, ["shift_code", "shift"], "--")}</td>
        <td>${formatShiftTime12h(Portal.pick(row, ["start_time", "start"], ""))}</td>
        <td>${formatShiftTime12h(Portal.pick(row, ["end_time", "end"], ""))}</td>
        <td>${badge(Portal.pick(row, ["status"], "--"), statusTone(Portal.pick(row, ["status"], "")))}</td>
      </tr>`).join("");
  };

  const statusTone = (value) => {
    const text = String(value).toLowerCase();
    if (text.includes("late") || text.includes("missing") || text.includes("absent")) return "red";
    if (text.includes("break") || text.includes("pending")) return "amber";
    if (text.includes("in") || text.includes("present") || text.includes("ok")) return "green";
    return "";
  };

  const updateActionStates = (today) => {
    const blocked = !state.staff || Boolean(today.actionBlocked);
    const blockMessage = Portal.pick(today, ["actionBlockMessage"], noScheduleMessage);
    const checkedIn = today.hasCheckIn === true;
    const checkedOut = today.hasCheckOut === true;
    const activeBreak = Portal.pick(today, ["activeBreak"], "");
    const onBreak = Boolean(activeBreak);
    const selectedBreak = document.getElementById("breakTypeSelect")?.value || "BREAK";
    const counts = today.counts || {};
    const selectedCount = Number(counts[selectedBreak] || 0);
    const selectedRule = BREAK_RULES[selectedBreak] || BREAK_RULES.BREAK;
    const selectedLimitReached = selectedCount >= selectedRule.limit;
    Portal.setText("checkInState", blocked ? blockMessage : checkedIn ? "Completed" : "Ready");
    Portal.setText("checkOutState", blocked ? "Blocked" : checkedOut ? "Completed" : checkedIn ? "Ready" : "Pending");
    Portal.setText("breakStartState", blocked ? "Blocked" : onBreak ? "Running" : selectedLimitReached ? "Limit reached" : checkedIn ? "Available" : "Check in first");
    Portal.setText("breakEndState", blocked ? "Blocked" : onBreak ? "Ready" : "Inactive");
    Portal.setText("breakLimitHint", `${selectedRule.label}: ${selectedCount}/${selectedRule.limit} used, ${selectedRule.minutes} min limit`);
    breakStartedAt = onBreak ? Portal.pick(today, ["breakStartedAt", "breakStart", "currentBreakStart"], breakStartedAt) : null;
    document.querySelector('[data-action="checkIn"]').disabled = blocked || checkedIn;
    document.querySelector('[data-action="checkOut"]').disabled = blocked || !checkedIn || checkedOut;
    document.querySelector('[data-action="breakStart"]').disabled = blocked || !checkedIn || onBreak || checkedOut || selectedLimitReached;
    document.querySelector('[data-action="breakEnd"]').disabled = blocked || !onBreak;
    if (attendanceActionInFlight) {
      document.querySelectorAll("[data-action]").forEach((button) => {
        button.disabled = true;
      });
    }
  };

  const tickBreak = () => {
    if (!breakStartedAt) return Portal.setText("breakTimer", "00:00:00");
    const start = new Date(breakStartedAt);
    if (Number.isNaN(start.getTime())) return;
    const diff = Math.max(0, Date.now() - start.getTime());
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    Portal.setText("breakTimer", `${h}:${m}:${s}`);
  };

  const load = async (silent = false) => {
    if (refreshInFlight) return refreshPromise;
    refreshInFlight = true;
    refreshPromise = (async () => {
      if (!silent) Portal.setStatus(null, "Loading");
      try {
        const monthInput = document.getElementById("scheduleMonth");
        const month = scheduleMonthTouched ? monthInput?.value || "" : "";
        const data = await Portal.api.dashboard("staff", { month, dashboard_mode: "operations" });
        const root = data?.data || data?.dashboard || data || {};
        const selectedMonth = root.selected_month || root.score_debug?.selected_month || "";
        if (monthInput && !scheduleMonthTouched && selectedMonth) monthInput.value = selectedMonth;
        state = normalizeDashboard(data);
        writeCachedDashboard(data);
        renderProfile(state);
        Portal.dashboardReady();
      } catch (error) {
        if (state.staff) renderProfile(state);
        else {
          Portal.setText("staffName", "Dashboard unavailable");
          Portal.setText("staffMeta", "Unable to load. Use Retry to try again.");
          Portal.setText("shiftName", "Unavailable");
          Portal.setText("lateWarning", error.message || "Unable to load dashboard. Please retry.");
          Portal.setText("ipStatus", "Not verified");
          updateActionStates({});
        }
        Portal.dashboardFailure(Boolean(state.staff), () => load(false), error);
      } finally {
        refreshInFlight = false;
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const bindActions = () => {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (attendanceActionInFlight) return;
        const action = button.dataset.action;
        if (state.today?.actionBlocked) {
          Portal.toast(state.today.actionBlockMessage || noScheduleMessage, "error");
          return;
        }
        const eventMap = {
          checkIn: { event_type: "CHECK_IN" },
          checkOut: { event_type: "CHECK_OUT" },
          breakStart: { event_type: "BREAK_START", break_type: document.getElementById("breakTypeSelect")?.value || "BREAK" },
          breakEnd: { event_type: "BREAK_END", break_type: state.today?.activeBreak || "BREAK" }
        };
        attendanceActionInFlight = true;
        const stateLabel = button.querySelector("span");
        const previousStateLabel = stateLabel ? stateLabel.textContent : "";
        if (stateLabel) stateLabel.textContent = "Saving...";
        document.querySelectorAll("[data-action]").forEach((actionButton) => {
          actionButton.disabled = true;
        });
        button.disabled = true;
        let succeeded = false;
        try {
          const ip = await Portal.api.detectIp();
          const result = await Portal.api.action("attendance_action", {
            login_id: session.loginId || session.staffId,
            ip,
            user_agent: navigator.userAgent,
            ...(eventMap[action] || {})
          });
          if (result?.ok === false) throw new Error(result.message || "Action failed");
          Portal.toast(`${button.firstChild.textContent.trim()} recorded`);
          if (result?.state) state.today = { ...(state.today || {}), ...result.state };
          succeeded = true;
          if (result?.state) {
            renderProfile(state);
            load(true).catch(() => {});
          } else {
            await load(true);
          }
        } catch (error) {
          if (!Portal.isAbortLike(error)) Portal.toast(error.message || "Action failed", "error");
        } finally {
          attendanceActionInFlight = false;
          if (!succeeded && stateLabel) stateLabel.textContent = previousStateLabel;
          updateActionStates(state.today || {});
        }
      });
    });
  };

  const applyDisplayOnlyLabels = () => {
    const bioBreakOption = document.querySelector('#breakTypeSelect option[value="BIO_BREAK"]');
    if (bioBreakOption) bioBreakOption.textContent = "Bio Break - 10 min, 3 times";
  };

  const startPolling = () => {
    if (pollingStarted) return;
    pollingStarted = true;
    refreshTimer = setInterval(() => load(true), 15000);
  };

  const bootstrap = () => {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = Promise.allSettled([
      load()
    ]).finally(startPolling);
    return bootstrapPromise;
  };

  applyDisplayOnlyLabels();
  bindActions();
  const scheduleMonth = document.getElementById("scheduleMonth");
  if (scheduleMonth) {
    scheduleMonth.addEventListener("change", () => {
      scheduleMonthTouched = true;
      load();
    });
  }
  document.getElementById("breakTypeSelect")?.addEventListener("change", () => updateActionStates(state.today || {}));
  updateActionStates(state.today || {});
  bootstrap();
  setInterval(tickBreak, 1000);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
