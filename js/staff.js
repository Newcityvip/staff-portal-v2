(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "staff") { location.href = "admin.html"; return; }

  let state = {};
  let refreshPromise = null;
  let attendanceActionInFlight = false;
  let reconciliationRequired = false;
  let verified = false;
  let revision = 0;
  let breakStartedAt = null;
  const BREAK_RULES = {
    BREAK: { label: "Break", limit: 1, minutes: 60 },
    BIO_BREAK: { label: "Bio Break", limit: 3, minutes: 10 },
    PRAYER_BREAK: { label: "Prayer Break", limit: 3, minutes: 15 }
  };

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
    const shift = String(Portal.pick(schedule, ["shift_code"], "")).trim().toUpperCase();
    const status = String(Portal.pick(schedule, ["status"], "")).trim().toUpperCase();
    return ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(shift) || ["OFF", "AL", "UL", "SL", "HOLIDAY", "LEAVE"].includes(status);
  };
  const nonWorkingValue = (schedule) => {
    const shift = String(Portal.pick(schedule, ["shift_code"], "")).trim().toUpperCase();
    const status = String(Portal.pick(schedule, ["status"], "")).trim().toUpperCase();
    return ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(shift) ? shift : status || "OFF";
  };
  const normalizeDashboard = (data) => {
    const root = data?.data || data?.dashboard || data || {};
    const staff = root.staff || root.profile || root.user || session.raw || {};
    const schedule = root.today_schedule || root.schedule || root.shift || {};
    const attendance = root.attendance_state || root.today || root.attendance || root.current || {};
    const hasSchedule = schedule && schedule.ok !== false && Boolean(Portal.pick(schedule, ["schedule_date", "shift_code", "status", "start_time", "end_time"], ""));
    const nonWorking = hasSchedule && isNonWorkingSchedule(schedule);
    const scheduleStatus = String(schedule.status || "").trim().toUpperCase();
    const actionBlockMessage = !hasSchedule ? noScheduleMessage : nonWorking ? nonWorkingMessage(nonWorkingValue(schedule)) :
      scheduleStatus !== "WORKING" ? "This is not a working shift." : "";
    return {
      staff,
      date: root.today,
      timezone: root.timezone,
      today: { ...attendance,
        status: attendance.hasCheckOut ? "Checked out" : attendance.hasCheckIn ? "Checked in" : "Not checked in",
        breakStatus: attendance.activeBreak ? attendance.activeBreak.replaceAll("_", " ") : "Not on break",
        actionBlocked: Boolean(actionBlockMessage), actionBlockMessage },
      shift: { ...schedule, name: Portal.pick(schedule, ["shift_code", "shift", "name"], hasSchedule ? "Today shift" : "No assigned shift"),
        start: Portal.pick(schedule, ["start_time", "start", "startTime"], ""), end: Portal.pick(schedule, ["end_time", "end", "endTime"], "") },
      ip: root.ip || root.ipStatus || { allowed: true, message: "IP allowed" }
    };
  };


  const shiftProgress = (shift) => {
    const start = new Date(Portal.pick(shift, ["start", "startTime", "shiftStart"], ""));
    const end = new Date(Portal.pick(shift, ["end", "endTime", "shiftEnd"], ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return Portal.percent(Portal.pick(shift, ["progress"], 0));
    const now = Date.now();
    return Portal.percent(((now - start.getTime()) / (end.getTime() - start.getTime())) * 100);
  };

  const renderProfile = ({ staff, today, shift, ip }) => {
    const name = Portal.pick(staff, ["full_name", "name", "fullName", "staffName", "displayName"], session.name);
    Portal.setText("staffGreeting", `Welcome back, ${name}`);
    Portal.setText("staffInitials", initials(name));
    Portal.setText("staffName", name);
    Portal.setText("staffMeta", [Portal.pick(staff, ["role", "position"], "Staff"), Portal.pick(staff, ["department", "team"], "")].filter(Boolean).join(" / "));

    const ipOk = ip.allowed === true;
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
    updateActionStates(today);
  };


  const updateActionStates = (today) => {
    const unavailable = !verified || reconciliationRequired || !state.staff || state.date !== Portal.staffDate(state.timezone);
    const blocked = unavailable || Boolean(today.actionBlocked);
    const blockMessage = unavailable ? "Attendance not verified" : today.actionBlockMessage;
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
    Portal.setText("checkOutState", blocked ? "Blocked" : checkedOut ? "Completed" : onBreak ? "End break first" : checkedIn ? "Ready" : "Pending");
    Portal.setText("breakStartState", blocked ? "Blocked" : onBreak ? "Running" : selectedLimitReached ? "Limit reached" : checkedIn ? "Available" : "Check in first");
    Portal.setText("breakEndState", blocked ? "Blocked" : onBreak ? "Ready" : "Inactive");
    Portal.setText("breakLimitHint", unavailable ? "Break allowance not verified" : `${selectedRule.label}: ${selectedCount}/${selectedRule.limit} used, ${selectedRule.minutes} min limit`);
    breakStartedAt = onBreak ? Portal.pick(today, ["breakStartedAt", "breakStart", "currentBreakStart"], breakStartedAt) : null;
    document.querySelector('[data-action="checkIn"]').disabled = blocked || checkedIn;
    document.querySelector('[data-action="checkOut"]').disabled = blocked || !checkedIn || checkedOut || onBreak;
    document.querySelector('[data-action="breakStart"]').disabled = blocked || !checkedIn || onBreak || checkedOut || selectedLimitReached;
    document.querySelector('[data-action="breakEnd"]').disabled = blocked || !onBreak;
    if (attendanceActionInFlight) {
      document.querySelectorAll("[data-action]").forEach((button) => {
        button.disabled = true;
      });
    }
  };

  const tickBreak = () => {
    if (!breakStartedAt) return Portal.setText("breakTimer", verified ? "00:00:00" : "--");
    const start = new Date(breakStartedAt);
    if (Number.isNaN(start.getTime())) return;
    const diff = Math.max(0, Date.now() - start.getTime());
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    Portal.setText("breakTimer", `${h}:${m}:${s}`);
  };

  const useDashboard = (data) => {
    state = normalizeDashboard(data);
    verified = true;
    reconciliationRequired = false;
    renderProfile(state);
    Portal.dashboardReady();
  };

  const load = (silent = false) => {
    if (attendanceActionInFlight || (silent && (document.hidden || navigator.onLine === false))) return refreshPromise;
    if (refreshPromise) return refreshPromise;
    const startedAtRevision = revision;
    if (!silent && !state.staff) Portal.setStatus(null, "Loading");
    refreshPromise = (async () => {
      try {
        const data = await Portal.api.dashboard("staff", { dashboard_mode: "attendance_first" });
        if (startedAtRevision !== revision) return;
        const next = normalizeDashboard(data);
        if (next.staff.login_id !== session.loginId) throw new Error("Attendance identity changed. Sign in again.");
        if (next.date !== Portal.staffDate(next.timezone)) throw new Error("Attendance day changed. Please retry.");
        useDashboard(data);
      } catch (error) {
        if (startedAtRevision !== revision) return;
        verified = false;
        if (!state.staff) {
          Portal.setText("staffName", "Dashboard unavailable");
          Portal.setText("staffMeta", "Unable to load. Use Retry to try again.");
          Portal.setText("shiftName", "Unavailable");
          Portal.setText("lateWarning", error.message || "Unable to load dashboard. Please retry.");
        }
        markIpUnverified();
        updateActionStates(state.today || {});
        Portal.dashboardFailure(Boolean(state.staff), () => load(), error);
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const bindActions = () => {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (attendanceActionInFlight || !verified || reconciliationRequired || !state.staff ||
          state.date !== Portal.staffDate(state.timezone)) return;
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
        revision++;
        const stateLabel = button.querySelector("span");
        const previousStateLabel = stateLabel ? stateLabel.textContent : "";
        if (stateLabel) stateLabel.textContent = "Saving...";
        document.querySelectorAll("[data-action]").forEach((actionButton) => {
          actionButton.disabled = true;
        });
        button.disabled = true;
        try {
          const ip = await Portal.api.detectIp();
          const result = await Portal.api.action("attendance_action", {
            login_id: session.loginId || session.staffId,
            ip,
            user_agent: navigator.userAgent,
            ...(eventMap[action] || {})
          });
          if (result?.ok === false) {
            Portal.toast(result.message || "Action failed", "error");
          } else if (result?.ok === true && typeof result.event_id === "string" && result.event_id) {
            Portal.toast(`${button.firstChild.textContent.trim()} recorded`);
            if (result.state) {
              state.today = { ...state.today, ...result.state,
                status: result.state.hasCheckOut ? "Checked out" : result.state.hasCheckIn ? "Checked in" : "Not checked in",
                breakStatus: result.state.activeBreak ? result.state.activeBreak.replaceAll("_", " ") : "Not on break" };
              renderProfile(state);
            } else {
              reconciliationRequired = true;
            }
          } else {
            throw new Error("Missing attendance confirmation");
          }
        } catch (error) {
          reconciliationRequired = true;
          Portal.toast("Action not confirmed. Checking attendance before another submission.", "error");
          Portal.setStatus(false, "Verifying attendance");
        } finally {
          attendanceActionInFlight = false;
          if (stateLabel) stateLabel.textContent = previousStateLabel;
          updateActionStates(state.today || {});
          await refreshPromise;
          load(reconciliationRequired ? false : true);
        }
      });
    });
  };

  const loadHistory = document.getElementById("loadAttendanceHistory");
  loadHistory.addEventListener("click", async () => {
    loadHistory.disabled = true;
    const host = document.getElementById("attendanceHistory");
    const notice = (message) => {
      host.replaceChildren();
      const cell = host.insertRow().insertCell();
      cell.colSpan = 5;
      cell.textContent = message;
    };
    notice("Loading attendance history...");
    try {
      const rows = await Portal.api.staffAttendanceHistory();
      if (!rows.length) return notice("No attendance events found.");
      host.replaceChildren();
      for (const row of rows) {
        const tr = host.insertRow();
        for (const key of ["event_date", "event_time", "event_type", "break_type", "shift_code"]) tr.insertCell().textContent = row[key] || "--";
      }
    } catch (error) {
      if (Portal.isAbortLike(error)) notice("Attendance history timed out. Select Load History to retry.");
      else if (error.status === 401 || error.status === 403) notice("Attendance history access denied. Verify your network and staff sign-in.");
      else notice("Unable to load attendance history. Select Load History to retry.");
    } finally {
      loadHistory.disabled = false;
    }
  });

  const markIpUnverified = () => {
    const ip = document.getElementById("ipStatus");
    ip.textContent = "Not verified";
    ip.classList.remove("safe");
    ip.classList.add("warn");
  };
  const invalidateNetworkState = (message) => {
    revision++;
    verified = false;
    markIpUnverified();
    updateActionStates(state.today || {});
    Portal.dashboardFailure(Boolean(state.staff), () => load(), new Error(message));
  };

  bindActions();
  document.getElementById("breakTypeSelect")?.addEventListener("change", () => updateActionStates(state.today || {}));
  const handoff = Portal.takeStaffBootstrap(session);
  if (handoff) useDashboard(handoff);
  else load();
  const refreshTimer = setInterval(() => {
    if (state.staff && state.date !== Portal.staffDate(state.timezone)) updateActionStates(state.today);
    load(true);
  }, 15000);
  setInterval(tickBreak, 1000);
  document.addEventListener("visibilitychange", () => load(true));
  window.addEventListener("offline", () => invalidateNetworkState("Network disconnected"));
  window.addEventListener("online", async () => {
    if (!await Portal.api.detectIp(true, true)) localStorage.removeItem(Portal.CLIENT_IP_KEY);
    await refreshPromise;
    load(true);
  });
  window.addEventListener("storage", async (event) => {
    if (event.key === Portal.SESSION_KEY) {
      const current = Portal.getSession(false);
      if (current?.createdAt !== session.createdAt || current?.loginId !== session.loginId) location.href = "index.html";
    }
    if (event.key === Portal.CLIENT_IP_KEY && event.newValue !== state.ip?.address) {
      invalidateNetworkState("Network address changed");
      await refreshPromise;
      load(true);
    }
  });
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
