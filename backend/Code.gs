/***** STAFF PERFORMANCE PORTAL V2 - SINGLE FILE BACKEND *****/

const TZ = "Asia/Colombo";

const SHEETS = {
  SETTINGS: "01_Settings",
  STAFF: "02_Staff_Master",
  SHIFT: "03_Shift_Rules",
  SCHEDULE: "04_Schedule_Master",
  EVENTS: "05_Attendance_Events",
  DAILY: "06_Daily_Attendance_Score",
  KPI: "07_Monthly_KPI",
  QUARTER: "08_Quarterly_Final_Score",
  ADMIN: "09_Admin_Users",
  IP: "10_IP_Allowlist",
  AUDIT: "11_Audit_Log",
  TG: "12_Telegram_Log"
};

const CACHE_SECONDS = 30;
const TG_QUEUE_PROPERTY = "TG_ATTENDANCE_QUEUE_V2";
const TG_TRIGGER_HANDLER = "processTelegramQueue";

let REQUEST_CACHE = { values: {}, settings: null };

function doGet(e) {
  return jsonOut({ ok: true, app: "Staff Performance Portal V2 API", time: nowDateTime() });
}

function doPost(e) {
  resetRequestCache();

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = clean(body.action);

    if (!action) return jsonOut({ ok: false, message: "Missing action" });

    let result;

    switch (action) {
      case "staff_login":
        result = staffLogin(body);
        break;
      case "admin_login":
        result = adminLogin(body);
        break;
      case "get_staff_dashboard":
        result = getStaffDashboard(body);
        break;
      case "attendance_action":
        result = attendanceAction(body);
        break;
      case "get_admin_dashboard":
      case "get_admin_dashboard_full":
        result = getAdminDashboardFull(body);
        break;
      case "get_staff_list":
        result = getStaffList(body);
        break;
      case "get_schedule_list":
        result = getScheduleList(body);
        break;
      case "upload_schedule_csv":
        result = uploadScheduleCsv(body);
        break;
      case "update_single_staff_schedule":
        result = updateSingleStaffSchedule(body);
        break;
      case "get_attendance_logs":
        result = getAttendanceLogs(body);
        break;
      case "get_audit_logs":
        result = getAuditLogs(body);
        break;
      case "get_telegram_logs":
        result = getTelegramLogs(body);
        break;
      case "get_ip_allowlist":
        result = getIpAllowlist(body);
        break;
      case "save_ip_allowlist":
        result = saveIpAllowlist(body);
        break;
      case "get_kpi_list":
        result = getKpiList(body);
        break;
      case "get_quarter_scores":
        result = getQuarterScores(body);
        break;
      case "get_daily_scores":
        result = getDailyScores(body);
        break;
      case "save_monthly_kpi":
        result = saveMonthlyKPI(body);
        break;
      case "calculate_daily_score":
        result = calculateDailyScore(body);
        break;
      case "calculate_quarter_score":
        result = calculateQuarterScore(body);
        break;
      default:
        result = { ok: false, message: "Invalid action: " + action };
    }

    return jsonOut(result);
  } catch (err) {
    logInternalError("doPost", err);
    return jsonOut({ ok: false, message: "Server error. Please try again." });
  }
}

/***** BASIC HELPERS *****/

function resetRequestCache() {
  REQUEST_CACHE = { values: {}, settings: null };
}

function ss() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sh(name) {
  const sheet = ss().getSheetByName(name);
  if (!sheet) throw new Error("Missing sheet: " + name);
  return sheet;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function nowDateTime() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
}

function todayDate() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function nowTime() {
  return Utilities.formatDate(new Date(), TZ, "HH:mm:ss");
}

function monthNow() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM");
}

function resolveScoreMonth(month) {
  const settings = getSettings();
  const requestedMonth = normalizeMonthKey(month);
  if (requestedMonth) return requestedMonth;

  const defaultMonth = normalizeMonthKey(settings.DEFAULT_MONTH);
  return defaultMonth || monthNow();
}

function normalizeMonthKey(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, TZ, "yyyy-MM");
  }
  if (isSheetSerialDate(v)) return Utilities.formatDate(sheetSerialDate(v), TZ, "yyyy-MM");

  const s = clean(v);
  if (!s) return "";
  if (/^\d+(\.\d+)?$/.test(s) && isSheetSerialDate(Number(s))) return Utilities.formatDate(sheetSerialDate(Number(s)), TZ, "yyyy-MM");

  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{1}$/.test(s)) return s.substring(0, 5) + "0" + s.substring(5);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 7);

  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdy) return mdy[3] + "-" + pad2(Number(mdy[1]));

  const named = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const month = monthNameToNumber(named[1]);
    if (month) return named[2] + "-" + month;
  }

  const dayNamed = s.match(/^(?:[A-Za-z]{3,9}\s+)?([A-Za-z]{3,9})\s+\d{1,2}\s+(\d{4})(?:\s|$)/);
  if (dayNamed) {
    const dayNamedMonth = monthNameToNumber(dayNamed[1]);
    if (dayNamedMonth) return dayNamed[2] + "-" + dayNamedMonth;
  }

  const longDate = new Date(s);
  if (!isNaN(longDate.getTime()) && /[A-Za-z]/.test(s)) {
    return Utilities.formatDate(longDate, TZ, "yyyy-MM");
  }

  if (s.indexOf("GMT") > -1 || s.indexOf("T") > -1) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "yyyy-MM");
  }

  return s.substring(0, 7);
}

function monthNameToNumber(name) {
  const months = {
    january: "01", jan: "01", february: "02", feb: "02", march: "03", mar: "03",
    april: "04", apr: "04", may: "05", june: "06", jun: "06", july: "07", jul: "07",
    august: "08", aug: "08", september: "09", sep: "09", sept: "09", october: "10", oct: "10",
    november: "11", nov: "11", december: "12", dec: "12"
  };
  return months[clean(name).toLowerCase()] || "";
}

function normalizeMonth(v) {
  return normalizeMonthKey(v);
}

function normalizeHeaderKey(v) {
  return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function buildHeaderMap(headers) {
  const map = {};
  for (let i = 0; i < headers.length; i++) {
    const key = normalizeHeaderKey(headers[i]);
    if (key && map[key] == null) map[key] = i;
  }
  return map;
}

function valueByHeader(row, headerMap, keys, fallbackIndex) {
  for (let i = 0; i < keys.length; i++) {
    const key = normalizeHeaderKey(keys[i]);
    if (headerMap[key] != null) return row[headerMap[key]];
  }
  if (fallbackIndex != null && fallbackIndex >= 0) return row[fallbackIndex];
  return "";
}

function getSheetHeaders(sheetName) {
  const values = getValues(sheetName);
  return values.length ? values[0] : [];
}

function makeId(prefix) {
  return prefix + "-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000);
}

function getValues(sheetName) {
  return getCachedValues(sheetName);
}

function getCachedValues(sheetName) {
  if (REQUEST_CACHE.values[sheetName]) return REQUEST_CACHE.values[sheetName];

  const cache = CacheService.getScriptCache();
  const cacheKey = "SHEET_VALUES_V2_" + sheetName;
  const cached = cache.get(cacheKey);

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      REQUEST_CACHE.values[sheetName] = parsed;
      return parsed;
    } catch (err) {
      logInternalError("getCachedValues.parse." + sheetName, err);
    }
  }

  const values = sh(sheetName).getDataRange().getValues();
  REQUEST_CACHE.values[sheetName] = values;

  try {
    cache.put(cacheKey, JSON.stringify(values), CACHE_SECONDS);
  } catch (err) {
    logInternalError("getCachedValues.cache." + sheetName, err);
  }

  return values;
}

function clearSheetCache(sheetName) {
  if (sheetName) {
    delete REQUEST_CACHE.values[sheetName];
    CacheService.getScriptCache().remove("SHEET_VALUES_V2_" + sheetName);
    if (sheetName === SHEETS.SETTINGS) REQUEST_CACHE.settings = null;
    return;
  }

  resetRequestCache();
  const keys = Object.keys(SHEETS).map(function (k) {
    return "SHEET_VALUES_V2_" + SHEETS[k];
  });
  CacheService.getScriptCache().removeAll(keys);
}

function getSettings() {
  if (REQUEST_CACHE.settings) return REQUEST_CACHE.settings;

  const values = getValues(SHEETS.SETTINGS);
  const obj = {};
  for (let i = 1; i < values.length; i++) obj[clean(values[i][0])] = values[i][1];
  REQUEST_CACHE.settings = obj;
  return obj;
}

function appendAudit(actorType, actorId, actorName, action, module, targetId, oldValue, newValue, ip, notes) {
  sh(SHEETS.AUDIT).appendRow([
    makeId("AUD"),
    nowDateTime(),
    actorType || "",
    actorId || "",
    actorName || "",
    action || "",
    module || "",
    targetId || "",
    oldValue || "",
    newValue || "",
    ip || "",
    notes || ""
  ]);
  clearSheetCache(SHEETS.AUDIT);
}

function clean(v) {
  return String(v == null ? "" : v).replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function normalizeIdentityValue(v) {
  return normalizeIdentity(v);
}

function normalizeIdentity(v) {
  return String(v == null ? "" : v)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

function safeUpper(v) {
  return clean(v).toUpperCase();
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? Number(fallback || 0) : n;
}

function isSheetSerialDate(v) {
  return typeof v === "number" && isFinite(v) && v > 20000;
}

function sheetSerialDate(v) {
  return new Date(Math.round((Number(v) - 25569) * 86400000));
}

function normalizeDateKey(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  if (isSheetSerialDate(v)) return Utilities.formatDate(sheetSerialDate(v), TZ, "yyyy-MM-dd");
  const s = clean(v);
  if (!s) return "";
  if (/^\d+(\.\d+)?$/.test(s) && isSheetSerialDate(Number(s))) return Utilities.formatDate(sheetSerialDate(Number(s)), TZ, "yyyy-MM-dd");
  if (s.indexOf("GMT") > -1 || s.indexOf("T") > -1) {
    try {
      return Utilities.formatDate(new Date(s), TZ, "yyyy-MM-dd");
    } catch (err) {
      logInternalError("normalizeDateKey", err);
    }
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && /[A-Za-z]/.test(s)) return Utilities.formatDate(parsed, TZ, "yyyy-MM-dd");
  return s.substring(0, 10);
}

function getTeamTimezone(team) {
  const value = safeUpper(team);
  if (value === "CSP") return "Asia/Manila";
  if (value === "AFFILIATE") return "Asia/Colombo";
  return "Asia/Colombo";
}

function todayDateForTimezone(timezone) {
  return Utilities.formatDate(new Date(), timezone || TZ, "yyyy-MM-dd");
}

function nowTimeForTimezone(timezone) {
  return Utilities.formatDate(new Date(), timezone || TZ, "HH:mm:ss");
}

function normalizeSheetTime(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, TZ, "HH:mm:ss");
  const s = clean(v).replace(/^'/, "").replace(/\s+/g, " ").replace(/(\d)(AM|PM)$/i, "$1 $2");
  if (!s) return "";
  if (s.indexOf("T") > -1 || s.indexOf("GMT") > -1) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "HH:mm:ss");
  }
  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2]);
    const sec = Number(ampm[3] || 0);
    const meridiem = ampm[4].toUpperCase();
    if (meridiem === "PM" && h < 12) h += 12;
    if (meridiem === "AM" && h === 12) h = 0;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(sec);
  }
  const parts = s.split(":");
  if (parts.length >= 2) return pad2(Number(parts[0] || 0)) + ":" + pad2(Number(parts[1] || 0)) + ":" + pad2(Number(parts[2] || 0));
  return s;
}

function normalizeScheduleTimeForSheet(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return forcePlainTimeText(Utilities.formatDate(value, "GMT", "HH:mm:ss"));
  }

  const raw = clean(value).replace(/^'/, "").replace(/\s+/g, " ").replace(".", ":").replace(/(\d)(AM|PM)$/i, "$1 $2");
  if (!raw) return "";

  const strict = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (strict) {
    return forcePlainTimeText(pad2(Number(strict[1])) + ":" + pad2(Number(strict[2])) + ":" + pad2(Number(strict[3])));
  }

  const short = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (short) {
    return forcePlainTimeText(pad2(Number(short[1])) + ":" + pad2(Number(short[2])) + ":00");
  }

  const ampm = raw.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(AM|PM)$/i);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = Number(ampm[2] || 0);
    const second = Number(ampm[3] || 0);
    const meridiem = ampm[4].toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return forcePlainTimeText(pad2(hour) + ":" + pad2(minute) + ":" + pad2(second));
  }

  return forcePlainTimeText(normalizeSheetTime(raw));
}

function forcePlainTimeText(v) {
  if (!v) return "";
  let s = String(v).trim().replace(/^'/, "");
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return s;
  return "'" + String(m[1]).padStart(2, "0") + ":" + m[2] + ":" + (m[3] || "00");
}

function parseScheduleTimeRange(value) {
  const text = clean(value).replace(/[\u2013\u2014]/g, "-");
  if (!text || text.indexOf("-") === -1) return { start_time: "", end_time: "" };
  const parts = text.split(/\s*-\s*/).map(function (part) {
    return clean(part);
  }).filter(Boolean);
  return {
    start_time: normalizeSheetTime(parts[0] || ""),
    end_time: normalizeSheetTime(parts[1] || "")
  };
}

function formatShiftTime(v) {
  const normalized = normalizeSheetTime(v);
  if (!normalized) return "";
  const parts = normalized.split(":");
  let hour = Number(parts[0] || 0);
  const minute = Number(parts[1] || 0);
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return hour + ":" + pad2(minute) + " " + ampm;
}

function parseTimeToMinutesSafe(t) {
  const normalized = normalizeSheetTime(t);
  if (!normalized) return 0;
  const parts = normalized.split(":");
  return safeNumber(parts[0], 0) * 60 + safeNumber(parts[1], 0);
}

function pad2(n) {
  n = safeNumber(n, 0);
  return n < 10 ? "0" + n : String(n);
}

function logInternalError(context, err) {
  try {
    Logger.log(context + ": " + String(err && err.stack ? err.stack : err));
  } catch (e) {}
}

function requireAllowedIp(ip) {
  if (!isAllowedIP(ip)) return { ok: false, message: "IP not allowed", ip: clean(ip) };
  return null;
}

/***** IP SECURITY *****/

function isAllowedIP(ip) {
  const settings = getSettings();
  if (safeUpper(settings.IP_SECURITY_ENABLED || "YES") !== "YES") return true;

  ip = clean(ip);
  if (!ip) return false;

  const values = getValues(SHEETS.IP);
  for (let i = 1; i < values.length; i++) {
    const rowIp = clean(values[i][1]);
    const status = safeUpper(values[i][3]);
    if (rowIp === ip && status === "ACTIVE") return true;
  }
  return false;
}

/***** AUTH *****/

function staffLogin(data) {
  const loginId = clean(data.login_id);
  const ip = clean(data.ip);
  if (!loginId) return { ok: false, message: "Missing login ID" };
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const staff = getStaffByLogin(loginId);
  if (!staff.ok) return staff;

  appendAudit("STAFF", staff.staff_id, staff.full_name, "LOGIN", "STAFF_AUTH", staff.staff_id, "", "", ip, "");
  return { ok: true, message: "Login success", staff: staff };
}

function adminLogin(data) {
  const loginId = clean(data.login_id);
  const password = clean(data.password);
  const ip = clean(data.ip);
  if (!loginId || !password) return { ok: false, message: "Missing admin login or password" };
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const values = getValues(SHEETS.ADMIN);
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[2]) === loginId && clean(row[3]) === password && safeUpper(row[4]) === "ACTIVE") {
      appendAudit("ADMIN", row[0], row[1], "LOGIN", "ADMIN_AUTH", row[0], "", "", ip, "");
      return {
        ok: true,
        message: "Admin login success",
        admin: {
          admin_id: row[0],
          admin_name: row[1],
          login_id: row[2],
          role: row[5],
          email: row[6]
        }
      };
    }
  }
  return { ok: false, message: "Invalid admin login" };
}

function getAdminByLogin(loginId) {
  const values = getValues(SHEETS.ADMIN);
  const headerMap = buildHeaderMap(values[0] || []);
  const target = clean(loginId).toLowerCase();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const adminId = valueByHeader(row, headerMap, ["admin_id"], 0);
    const adminName = valueByHeader(row, headerMap, ["admin_name", "name", "full_name"], 1);
    const adminLoginId = valueByHeader(row, headerMap, ["login_id", "admin_login_id"], 2);
    const role = valueByHeader(row, headerMap, ["role", "admin_role", "account_role"], 5);
    const email = valueByHeader(row, headerMap, ["email"], 6);
    if (clean(adminLoginId).toLowerCase() === target || clean(email).toLowerCase() === target || clean(adminId).toLowerCase() === target) {
      return {
        ok: true,
        admin_id: adminId,
        admin_name: adminName,
        login_id: adminLoginId,
        role: role,
        email: email
      };
    }
  }
  return { ok: false, role: "" };
}

function getAdminAccess(data) {
  const loginId = clean(data.admin_login_id || data.login_id || data.admin_id);
  const admin = getAdminByLogin(loginId);
  const role = safeUpper(admin.role || data.admin_role || data.account_role || "");
  const access = {
    admin_login_id: loginId,
    role: role || "SUPER_ADMIN",
    allowed_team: role === "CSP_ADMIN" ? "CSP" : ""
  };
  if (access.allowed_team) {
    Logger.log("CSP_ADMIN filtering: admin_login_id=" + access.admin_login_id + ", role=" + access.role + ", allowed_team=" + access.allowed_team);
  }
  return access;
}

function getStaffByLogin(loginId) {
  return getStaffByIdentifier(loginId);
}

function getStaffByIdentifier(identifier) {
  const target = normalizeIdentity(identifier);
  const targetEmail = clean(identifier).toLowerCase();
  const staffRows = listStaffRows();
  const match = staffRows.filter(function (row) {
    return normalizeIdentity(row.login_id) === target ||
      normalizeIdentity(row.staff_id) === target ||
      normalizeIdentity(row.full_name) === target ||
      clean(row.email).toLowerCase() === targetEmail;
  })[0];
  if (match) {
    if (safeUpper(match.status) !== "ACTIVE") return { ok: false, message: "Staff inactive" };
    return Object.assign({ ok: true }, match);
  }
  return { ok: false, message: "Staff not found" };
}

/***** SCHEDULE *****/

function getScheduleForDate(identity, dateStr) {
  const key = normalizeDateKey(dateStr);
  const staffIdentity = typeof identity === "object" && identity ? identity : { login_id: identity };
  const row = listScheduleRows("", key).filter(function (scheduleRow) {
    return rowMatchesStaffIdentity(scheduleRow, staffIdentity);
  })[0];
  return row || { ok: false, message: "No schedule found" };
}

function getMonthlySchedule(identity, month) {
  const staffIdentity = typeof identity === "object" && identity ? identity : { login_id: identity };
  const targetMonth = normalizeMonthKey(month);
  return listScheduleRows(targetMonth, "").filter(function (row) {
    return rowMatchesStaffIdentity(row, staffIdentity);
  }).map(function (mapped) {
    return {
      date: mapped.schedule_date,
      schedule_date: mapped.schedule_date,
      shift_code: mapped.shift_code,
      start_time: mapped.start_time,
      end_time: mapped.end_time,
      status: mapped.status
    };
  });
}

function getShiftRule(shiftCode) {
  const values = getValues(SHEETS.SHIFT);
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[0]) === clean(shiftCode)) {
      return {
        ok: true,
        shift_code: row[0],
        start_time: row[1],
        end_time: row[2],
        grace_minutes: safeNumber(row[3], 5),
        late_after_minutes: safeNumber(row[4], 5),
        break_limit_min: safeNumber(row[5], 60),
        prayer_break_limit_min: safeNumber(row[6], 15),
        bio_break_limit_min: safeNumber(row[7], 11),
        break_count_limit: safeNumber(row[8], 1),
        prayer_break_count_limit: safeNumber(row[9], 3),
        bio_break_count_limit: safeNumber(row[10], 3),
        active: row[11],
        notes: row[12]
      };
    }
  }
  return { ok: false, message: "Shift rule not found" };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
}

/***** ATTENDANCE *****/

function attendanceAction(data) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (err) {
    logInternalError("attendanceAction.lock", err);
    return { ok: false, message: "Attendance system is busy. Please try again." };
  }

  try {
    return attendanceActionLocked(data);
  } catch (err) {
    logInternalError("attendanceAction", err);
    return { ok: false, message: "Attendance action failed. Please try again." };
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {
      logInternalError("attendanceAction.releaseLock", err);
    }
  }
}

function attendanceActionLocked(data) {
  clearSheetCache(SHEETS.EVENTS);

  const loginId = clean(data.login_id);
  const eventType = safeUpper(data.event_type);
  const breakType = safeUpper(data.break_type);
  const ip = clean(data.ip);
  const userAgent = clean(data.user_agent);

  if (!loginId) return { ok: false, message: "Missing login ID" };
  if (!eventType) return { ok: false, message: "Missing event type" };
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const allowedEvents = ["CHECK_IN", "CHECK_OUT", "BREAK_START", "BREAK_END"];
  if (allowedEvents.indexOf(eventType) === -1) return { ok: false, message: "Invalid event type" };
  if ((eventType === "BREAK_START" || eventType === "BREAK_END") && !breakType) return { ok: false, message: "Missing break type" };

  const staff = getStaffByLogin(loginId);
  if (!staff.ok) return staff;

  const staffTimezone = getTeamTimezone(staff.team);
  const requestedDate = clean(data.date || todayDateForTimezone(staffTimezone));
  const resolved = resolveAttendanceSchedule(staff, eventType, requestedDate);
  const today = resolved.date;
  const schedule = resolved.schedule;
  if (!schedule.ok) {
    Logger.log("Attendance blocked: login_id=" + staff.login_id + ", team=" + staff.team + ", action=" + eventType + ", result=NO_SCHEDULE");
    return { ok: false, code: "NO_SCHEDULE", message: "No schedule found for this day. Please contact admin." };
  }

  const shiftCode = safeUpper(schedule.shift_code);
  const scheduleStatus = safeUpper(schedule.status);
  if (isNonWorkingDay(shiftCode, scheduleStatus)) return { ok: false, code: "NON_WORKING_DAY", message: dayOffMessage(shiftCode, scheduleStatus) };
  if (scheduleStatus !== "WORKING") return { ok: false, message: "Today is not a working day: " + scheduleStatus };

  const state = getAttendanceState(staff.login_id, today);
  if (eventType === "CHECK_IN" && state.hasCheckIn) return { ok: false, message: "Already checked in today" };
  if (eventType === "CHECK_OUT") {
    if (!state.hasCheckIn) return { ok: false, message: "Check-in required first" };
    if (state.hasCheckOut) return { ok: false, message: "Already checked out today" };
    if (state.activeBreak) return { ok: false, message: "End current break before checkout" };
  }
  if (eventType === "BREAK_START") {
    if (!state.hasCheckIn) return { ok: false, message: "Check-in required before break" };
    if (state.hasCheckOut) return { ok: false, message: "Already checked out" };
    if (state.activeBreak) return { ok: false, message: "End current break before starting another" };
    if (breakType === "BREAK" && state.counts.BREAK >= 1) return { ok: false, message: "Normal break already used" };
    if (breakType === "PRAYER_BREAK" && state.counts.PRAYER_BREAK >= 3) return { ok: false, message: "Prayer break limit reached" };
    if (breakType === "BIO_BREAK" && state.counts.BIO_BREAK >= 3) return { ok: false, message: "Bio break limit reached" };
  }
  if (eventType === "BREAK_END") {
    if (!state.hasCheckIn) return { ok: false, message: "Check-in required first" };
    if (!state.activeBreak) return { ok: false, message: "No active break found" };
    if (state.activeBreak !== breakType) return { ok: false, message: "You must end current break: " + state.activeBreak };
  }

  const eventId = makeId("EVT");
  sh(SHEETS.EVENTS).appendRow([
    eventId,
    today,
    nowTimeForTimezone(staffTimezone),
    staff.staff_id,
    staff.login_id,
    staff.full_name,
    eventType,
    breakType,
    schedule.shift_code,
    ip,
    userAgent,
    "PORTAL",
    nowDateTime(),
    ""
  ]);

  clearSheetCache(SHEETS.EVENTS);
  appendAudit("STAFF", staff.staff_id, staff.full_name, eventType, "ATTENDANCE", eventId, "", "", ip, "");
  queueTelegramAttendance(staff, schedule, eventType, breakType, ip);

  let daily_score = null;
  if (eventType === "CHECK_OUT") {
    try {
      daily_score = calculateDailyScore({ login_id: staff.login_id, date: today });
    } catch (err) {
      logInternalError("attendanceActionLocked.dailyScore", err);
    }
  }

  return {
    ok: true,
    message: eventType + " saved successfully",
    event_id: eventId,
    staff: staff,
    schedule: schedule,
    state: getAttendanceState(staff.login_id, today),
    daily_score: daily_score
  };
}

function resolveAttendanceSchedule(staff, eventType, requestedDate) {
  const dateKey = normalizeDateKey(requestedDate);
  const schedule = getScheduleForDate(staff, dateKey);
  if (schedule.ok) return { date: dateKey, schedule: schedule };

  if (eventType === "CHECK_OUT" || eventType === "BREAK_START" || eventType === "BREAK_END") {
    const previousDate = addDays(dateKey, -1);
    const previousSchedule = getScheduleForDate(staff, previousDate);
    if (previousSchedule.ok) {
      const state = getAttendanceState(staff, previousDate);
      if (state.hasCheckIn && !state.hasCheckOut) return { date: previousDate, schedule: previousSchedule };
    }
  }

  return { date: dateKey, schedule: schedule };
}

function getAttendanceState(identity, dateStr) {
  const targetDate = normalizeDateKey(dateStr);
  const staffIdentity = typeof identity === "object" && identity ? identity : { login_id: identity };

  let hasCheckIn = false;
  let hasCheckOut = false;
  let activeBreak = "";
  let counts = { BREAK: 0, PRAYER_BREAK: 0, BIO_BREAK: 0 };
  let firstCheckIn = "";
  let lastCheckOut = "";

  const rows = listAttendanceRows(targetDate, 0).filter(function (row) {
    return rowMatchesStaffIdentity(row, staffIdentity);
  }).slice().reverse();

  rows.forEach(function (row) {
    const eventType = safeUpper(row.event_type);
    const breakType = safeUpper(row.break_type);
    const eventTime = normalizeSheetTime(row.event_time) || clean(row.event_time);

    if (eventType === "CHECK_IN") {
      hasCheckIn = true;
      if (!firstCheckIn) firstCheckIn = eventTime;
    }
    if (eventType === "CHECK_OUT") {
      hasCheckOut = true;
      lastCheckOut = eventTime;
    }
    if (eventType === "BREAK_START") {
      activeBreak = breakType;
      if (counts[breakType] != null) counts[breakType]++;
    }
    if (eventType === "BREAK_END" && activeBreak === breakType) activeBreak = "";
  });

  return { hasCheckIn, hasCheckOut, activeBreak, counts, firstCheckIn, lastCheckOut };
}

/***** STAFF DASHBOARD *****/

function getStaffDashboard(data) {
  const loginId = clean(data.login_id);
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const staff = getStaffByLogin(loginId);
  if (!staff.ok) return staff;

  const today = todayDateForTimezone(getTeamTimezone(staff.team));
  const month = resolveScoreMonth(data.month);
  const canonicalScores = getCanonicalScores(month, staff.team);
  const performanceDetails = canonicalScores.rows;
  const leaderboard = performanceDetails.map(function (row) {
    return {
      login_id: row.login_id,
      full_name: row.full_name,
      team: row.team,
      attendance_score: row.attendance_score,
      kpi_score_out_of_5: row.kpi_score_out_of_5,
      kpi_score: row.kpi_score,
      final_score: row.final_score,
      monthly_final_score: row.monthly_final_score,
      quarter_score: row.quarter_score,
      ranking_score: row.ranking_score,
      rank: row.rank,
      current_rank: row.current_rank || row.rank,
      grade: row.grade,
      kpi_status: row.kpi_status
    };
  });
  const ownKpi = getOwnKPI(staff.login_id, month);
  const attendanceEvents = listAttendanceRows("", 300).filter(function (row) {
    return rowMatchesStaffIdentity(row, staff);
  });
  const dailyScores = listDailyScoreRows(month, 300).filter(function (row) {
    return rowMatchesStaffIdentity(row, staff);
  });
  const deductionTrace = getStaffDeductionDetailsFromDailyScore(staff);
  const deductionDetails = deductionTrace.rows;
  const quarterScores = listQuarterScoreRows(300).filter(function (row) {
    return rowMatchesStaffIdentity(row, staff);
  });
  const ownPerformance = performanceDetails.filter(function (row) {
    return rowMatchesStaffIdentity(row, staff);
  })[0] || {};
  const monthlyAttendanceScore = clean(ownPerformance.attendance_score) !== "" ? ownPerformance.attendance_score : 0;
  const kpiScore = clean(ownPerformance.kpi_score_out_of_5) !== "" ? ownPerformance.kpi_score_out_of_5 : 0;
  const finalScore = clean(ownPerformance.final_score) !== "" ? ownPerformance.final_score : calculateFinalScore(monthlyAttendanceScore, kpiScore);
  const quarterScoreValue = clean(ownPerformance.quarter_score) !== "" ? ownPerformance.quarter_score : 0;
  const scoreDebug = canonicalScores.debug;
  const quarterLabel = getQuarterLabelForMonth(month);
  const selectedQuarterScore = quarterScores.filter(function (row) {
    const fromMonth = normalizeMonth(row.from_month);
    const toMonth = normalizeMonth(row.to_month);
    return clean(row.quarter).toLowerCase() === clean(quarterLabel).toLowerCase() ||
      (fromMonth && toMonth && month >= fromMonth && month <= toMonth);
  })[0];
  const fallbackQuarter = {
    quarter: quarterLabel,
    login_id: staff.login_id,
    full_name: staff.full_name,
    attendance_avg: monthlyAttendanceScore,
    kpi_avg: kpiScore,
    final_score: quarterScoreValue,
    final_grade: getGrade(quarterScoreValue),
    rank: ownPerformance.rank || "",
    calculated: true
  };

  return {
    ok: true,
    selected_month: month,
    staff: staff,
    today: today,
    today_schedule: getScheduleForDate(staff, today),
    tomorrow_schedule: getScheduleForDate(staff, addDays(today, 1)),
    attendance_state: getAttendanceState(staff, today),
    monthly_schedule: getMonthlySchedule(staff, month),
    next_7_schedule: getNextSchedule(staff, today, 7),
    upcoming_schedule: getNextSchedule(staff, today, 0),
    attendance_events: attendanceEvents,
    daily_scores: dailyScores,
    deduction_details: deductionDetails,
    deduction_debug: deductionTrace.debug,
    quarter_scores: quarterScores,
    quarter_score: selectedQuarterScore || fallbackQuarter,
    quarter_score_value: quarterScoreValue,
    current_rank: ownPerformance.rank || "",
    rank: ownPerformance.rank || "",
    monthly_attendance_score: monthlyAttendanceScore,
    attendance_score: monthlyAttendanceScore,
    kpi_score: kpiScore,
    kpi_status: ownPerformance.kpi_status || (ownKpi ? "Scored" : "Not scored yet"),
    final_score: finalScore,
    staff_score: ownPerformance,
    score: ownPerformance,
    performance_summary: ownPerformance,
    performance_details: performanceDetails,
    leaderboard: leaderboard,
    topPerformers: leaderboard.slice(0, 10),
    worstPerformers: leaderboard.slice().reverse().slice(0, 10),
    own_kpi: ownKpi,
    score_debug: scoreDebug
  };
}

function parseScoreNotesJson(value) {
  try {
    return clean(value) ? JSON.parse(clean(value)) : {};
  } catch (err) {
    return {};
  }
}

function normalizeDeductionIdentity(value) {
  return clean(value).toUpperCase();
}

function dailyScoreDeductionRowMatchesStaff(row, staff) {
  const rowLogin = normalizeDeductionIdentity(row.login_id);
  const staffLogin = normalizeDeductionIdentity(staff && staff.login_id);
  const rowStaffId = normalizeDeductionIdentity(row.staff_id);
  const staffId = normalizeDeductionIdentity(staff && staff.staff_id);
  if (rowLogin && staffLogin && rowLogin === staffLogin) return true;
  if (rowStaffId && staffId && rowStaffId === staffId) return true;
  if (rowLogin || staffLogin || rowStaffId || staffId) return false;

  const rowName = normalizeDeductionIdentity(row.full_name);
  const staffName = normalizeDeductionIdentity(staff && staff.full_name);
  return Boolean(rowName && staffName && rowName === staffName);
}

function flagYes(value) {
  const flag = safeUpper(value);
  return flag === "YES" || flag === "TRUE" || flag === "Y" || flag === "1";
}

function getDeductionType(row) {
  const status = safeUpper(row.attendance_status);
  if (status.indexOf("BREAK_OVERUSE") > -1 || flagYes(row.break_overuse)) return "BREAK_OVERUSE";
  if (safeNumber(row.late_minutes, 0) > 0 || status.indexOf("LATE") > -1) return "LATE";
  if (flagYes(row.early_checkout) || status.indexOf("EARLY") > -1) return "EARLY_CHECKOUT";
  if (flagYes(row.missing_checkin) || status.indexOf("MISSING_CHECK_IN") > -1 || status.indexOf("MISSING_CHECKIN") > -1) return "MISSING_CHECKIN";
  if (flagYes(row.missing_checkout) || status.indexOf("MISSING_CHECK_OUT") > -1 || status.indexOf("MISSING_CHECKOUT") > -1) return "MISSING_CHECKOUT";
  if (status && status !== "PRESENT") return status;
  return safeNumber(row.total_penalty, 0) > 0 ? "PENALTY" : "";
}

function isDeductionDailyScoreRawRow(row) {
  const status = safeUpper(row.attendance_status);
  return safeNumber(row.total_penalty, 0) > 0 ||
    (status && status !== "PRESENT") ||
    flagYes(row.break_overuse) ||
    safeNumber(row.late_minutes, 0) > 0 ||
    flagYes(row.early_checkout) ||
    flagYes(row.missing_checkin) ||
    flagYes(row.missing_checkout);
}

function deductionReason(row, type, notes) {
  if (type && type !== "PENALTY") return type;
  if (clean(row.attendance_status)) return clean(row.attendance_status);
  if (notes && clean(notes.status)) return clean(notes.status);
  return clean(row.notes) || "Penalty";
}

function isDeductionBreakOveruseValue(value) {
  const text = safeUpper(value);
  return Boolean(text && text !== "NO" && text !== "FALSE" && text !== "0");
}

function getStaffDeductionDetailsFromDailyScore(staff) {
  const rows = [];
  const values = getValues(SHEETS.DAILY);
  const headerMap = buildHeaderMap(values[0] || []);
  let matchedRows = 0;
  const matchedLoginId = normalizeDeductionIdentity(staff && staff.login_id);
  const matchedStaffId = normalizeDeductionIdentity(staff && staff.staff_id);

  for (let i = 1; i < values.length; i++) {
    const valuesRow = values[i];
    const scoreDate = normalizeDateKey(valueByHeader(valuesRow, headerMap, ["score_date", "date"], null));
    const row = {
      score_date: scoreDate,
      staff_id: valueByHeader(valuesRow, headerMap, ["staff_id"], null),
      login_id: valueByHeader(valuesRow, headerMap, ["login_id"], null),
      full_name: valueByHeader(valuesRow, headerMap, ["full_name", "name"], null),
      scheduled_start: valueByHeader(valuesRow, headerMap, ["scheduled_start", "start_time"], null),
      scheduled_end: valueByHeader(valuesRow, headerMap, ["scheduled_end", "end_time"], null),
      first_check_in: valueByHeader(valuesRow, headerMap, ["first_check_in", "check_in"], null),
      last_check_out: valueByHeader(valuesRow, headerMap, ["last_check_out", "check_out"], null),
      total_break_min: valueByHeader(valuesRow, headerMap, ["total_break_min"], null),
      attendance_status: valueByHeader(valuesRow, headerMap, ["attendance_status", "status"], null),
      total_penalty: valueByHeader(valuesRow, headerMap, ["total_penalty", "penalty"], null),
      final_attendance: valueByHeader(valuesRow, headerMap, ["final_attendance_score", "final_attendance", "attendance_score"], null),
      late_minutes: valueByHeader(valuesRow, headerMap, ["late_minutes"], null),
      early_checkout: valueByHeader(valuesRow, headerMap, ["early_checkout", "early_checkout_flag"], null),
      missing_checkin: valueByHeader(valuesRow, headerMap, ["missing_checkin", "missing_check_in"], null),
      missing_checkout: valueByHeader(valuesRow, headerMap, ["missing_checkout", "missing_check_out"], null),
      break_overuse: valueByHeader(valuesRow, headerMap, ["break_overuse", "break_overuse_flag"], null),
      notes: valueByHeader(valuesRow, headerMap, ["notes"], null)
    };
    if (!dailyScoreDeductionRowMatchesStaff(row, staff)) continue;
    matchedRows++;

    const status = safeUpper(row.attendance_status);
    const hasDeduction = safeNumber(row.total_penalty, 0) > 0 ||
      Boolean(status && status !== "PRESENT") ||
      isDeductionBreakOveruseValue(row.break_overuse);
    if (!hasDeduction) continue;

    const type = getDeductionType(row);
    const notes = parseScoreNotesJson(row.notes);
    const breakDetails = Array.isArray(notes.break_overuse_details) && notes.break_overuse_details.length ? notes.break_overuse_details[0] : {};
    const start = clean(breakDetails.start_time) || clean(row.first_check_in) || clean(row.scheduled_start) || "--";
    const end = clean(breakDetails.end_time) || clean(row.last_check_out) || clean(row.scheduled_end) || "--";
    const used = clean(breakDetails.used_minutes) || clean(row.total_break_min) || "--";
    const reason = clean(row.attendance_status) || clean(row.break_overuse) || clean(row.notes) || "Penalty applied";
    rows.push({
      date: row.score_date,
      score_date: row.score_date,
      type: clean(row.attendance_status) || clean(row.break_overuse) || type || "DEDUCTION",
      start: start,
      start_time: start,
      end: end,
      end_time: end,
      used: used,
      used_minutes: used === "--" ? "" : used,
      allowed: clean(breakDetails.allowed_minutes) || "--",
      allowed_minutes: clean(breakDetails.allowed_minutes),
      reason: reason,
      penalty: row.total_penalty,
      final_attendance: row.final_attendance,
      login_id: row.login_id,
      staff_id: row.staff_id
    });
  }

  rows.sort(function (a, b) {
    return normalizeDateKey(b.date).localeCompare(normalizeDateKey(a.date));
  });
  return {
    rows: rows,
    debug: {
      matched_login_id: matchedLoginId,
      matched_staff_id: matchedStaffId,
      score_rows_scanned: Math.max(values.length - 1, 0),
      matched_score_rows: matchedRows,
      deduction_details_count: rows.length
    }
  };
}

function getNextSchedule(identity, fromDate, days) {
  const staffIdentity = typeof identity === "object" && identity ? identity : { login_id: identity };
  const from = normalizeDateKey(fromDate);
  const rows = listScheduleRows("", "").filter(function (row) {
    return rowMatchesStaffIdentity(row, staffIdentity) && normalizeDateKey(row.schedule_date) >= from;
  });
  rows.sort(function (a, b) {
    const dateCompare = normalizeDateKey(a.schedule_date).localeCompare(normalizeDateKey(b.schedule_date));
    if (dateCompare) return dateCompare;
    return parseTimeToMinutesSafe(a.start_time) - parseTimeToMinutesSafe(b.start_time);
  });
  const limit = safeNumber(days, 7);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

function getNextShiftStaffRows(access, staffIndex) {
  const today = todayDate();
  const nowMinutes = parseTimeToMinutesSafe(nowTime());
  const nonWorkingCodes = ["", "OFF", "AL", "UL", "SL", "NP", "LEAVE", "HOLIDAY"];
  const teamKey = clean(access && access.allowed_team).toLowerCase();
  const rows = listScheduleRows("", "").filter(function (row) {
    if (teamKey && !rowMatchesAllowedTeam(row, teamKey, staffIndex)) return false;
    const status = safeUpper(row.status);
    const shift = safeUpper(row.shift_code);
    if (status !== "WORKING") return false;
    if (nonWorkingCodes.indexOf(status) > -1 || nonWorkingCodes.indexOf(shift) > -1) return false;
    if (isNonWorkingDay(row.shift_code, row.status)) return false;
    const dateKey = normalizeDateKey(row.schedule_date);
    if (dateKey !== today) return false;
    if (parseTimeToMinutesSafe(row.start_time) <= nowMinutes) return false;
    return true;
  });

  rows.sort(function (a, b) {
    const dateCompare = normalizeDateKey(a.schedule_date).localeCompare(normalizeDateKey(b.schedule_date));
    if (dateCompare) return dateCompare;
    const timeCompare = parseTimeToMinutesSafe(a.start_time) - parseTimeToMinutesSafe(b.start_time);
    if (timeCompare) return timeCompare;
    return clean(a.full_name).localeCompare(clean(b.full_name));
  });

  return rows.map(function (row) {
    return {
      staff: row.full_name,
      full_name: row.full_name,
      staff_id: row.staff_id,
      login_id: row.login_id,
      team: row.team,
      date: normalizeDateKey(row.schedule_date),
      schedule_date: normalizeDateKey(row.schedule_date),
      shift: row.shift_code,
      shift_code: row.shift_code,
      start: row.start_time,
      start_time: row.start_time,
      end: row.end_time,
      end_time: row.end_time,
      status: row.status
    };
  });
}

function getActiveBreakRows(dateStr, access, staffIndex) {
  const targetDate = normalizeDateKey(dateStr || todayDate());
  const rows = filterRowsForAdmin(listAttendanceRows(targetDate, 0), access, staffIndex);
  const closed = {};
  const active = {};

  rows.forEach(function (row) {
    const key = scheduleIdentityKey(row);
    if (!key || active[key]) return;
    const eventType = safeUpper(row.event_type);
    if (eventType === "BREAK_END") {
      closed[key] = true;
      return;
    }
    if (eventType !== "BREAK_START" || closed[key]) return;
    const staff = staffIndex.byLogin[normalizeIdentity(row.login_id)] || staffIndex.byStaffId[normalizeIdentity(row.staff_id)] || staffIndex.byName[normalizeIdentity(row.full_name)] || {};
    active[key] = {
      staff_id: row.staff_id || staff.staff_id,
      login_id: row.login_id || staff.login_id,
      full_name: row.full_name || staff.full_name,
      name: row.full_name || staff.full_name,
      team: row.team || staff.team || "",
      event_date: row.event_date,
      event_time: row.event_time,
      break_type: row.break_type || "BREAK",
      breakStart: row.event_time,
      start: row.event_time,
      status: "ON_BREAK",
      ip: row.ip
    };
  });

  return Object.keys(active).map(function (key) { return active[key]; }).sort(function (a, b) {
    return (normalizeDateKey(b.event_date) + " " + normalizeSheetTime(b.event_time)).localeCompare(normalizeDateKey(a.event_date) + " " + normalizeSheetTime(a.event_time));
  });
}

function averageRows(rows, key) {
  let total = 0;
  let count = 0;
  rows.forEach(function (row) {
    const n = Number(row[key]);
    if (!isNaN(n)) {
      total += n;
      count++;
    }
  });
  return count ? Number((total / count).toFixed(2)) : "";
}

function averageScoreRows(rows, key) {
  let total = 0;
  let count = 0;
  rows.forEach(function (row) {
    const raw = row && row[key];
    if (clean(raw) === "") return;
    total += clampScore(raw);
    count++;
  });
  return count ? round2(total / count) : 0;
}

function scoreRowMonth(row) {
  return normalizeMonth(row && row.score_date) ||
    normalizeMonth(row && row.score_month) ||
    normalizeMonth(row && row.kpi_month);
}

function latestScoreRowsForStaff(rows) {
  rows = rows || [];
  if (!rows.length) return [];
  const latestMonth = scoreRowMonth(rows[0]);
  if (!latestMonth) return rows;
  return rows.filter(function (row) {
    return scoreRowMonth(row) === latestMonth;
  });
}

function getQuarterScoreForMonth(loginId, month, fallbackScore) {
  const staff = getStaffByIdentifier(loginId);
  const identity = staff.ok ? staff : { login_id: loginId };
  return getQuarterScoreForStaff(identity, month, fallbackScore);
}

function getQuarterRowsForStaff(staff, month) {
  const targetMonth = normalizeMonth(month);
  const targetQuarter = getQuarterLabelForMonth(targetMonth);
  return listQuarterScoreRows(0).filter(function (row) {
    if (!rowMatchesStaffIdentity(row, staff)) return false;
    const fromMonth = normalizeMonth(row.from_month);
    const toMonth = normalizeMonth(row.to_month);
    if (targetQuarter && clean(row.quarter).toLowerCase() === clean(targetQuarter).toLowerCase()) return true;
    return fromMonth && toMonth && targetMonth >= fromMonth && targetMonth <= toMonth;
  });
}

function getQuarterScoreForStaff(staff, month, fallbackScore) {
  const rows = getQuarterRowsForStaff(staff, month);
  if (!rows.length) return round2(fallbackScore);
  const row = rows[0];
  const score = clean(row.quarter_score) !== "" ? row.quarter_score : row.final_score;
  return clean(score) !== "" ? round2(score) : round2(fallbackScore);
}

function buildScoreDebug(month, dailyRows, kpiRows, performanceRows, extra) {
  extra = extra || {};
  return {
    month: normalizeMonth(month),
    resolved_month: normalizeMonth(month),
    selected_month: normalizeMonth(month),
    selected_quarter: getQuarterLabelForMonth(month),
    staff_count: (performanceRows || []).length,
    matched_staff_count: extra.matched_staff_count || 0,
    score_debug_missing: extra.score_debug_missing || [],
    daily_rows_found: (dailyRows || []).length,
    kpi_rows_found: (kpiRows || []).length,
    canonical_rows_built: (performanceRows || []).length,
    performance_rows_built: (performanceRows || []).length,
    first_10_unmatched_daily_rows: extra.first_10_unmatched_daily_rows || [],
    first_5_scores: (performanceRows || []).slice(0, 5).map(function (row) {
      return {
        login_id: row.login_id,
        full_name: row.full_name,
        attendance_score: row.attendance_score,
        kpi_score: row.kpi_score,
        final_score: row.final_score,
        quarter_score: row.quarter_score,
        rank: row.rank
      };
    }),
    quarter_rows_found: listQuarterScoreRows(0).length,
    sample_daily_headers: getSheetHeaders(SHEETS.DAILY).slice(0, 30),
    sample_kpi_headers: getSheetHeaders(SHEETS.KPI).slice(0, 30),
    sample_quarter_headers: getSheetHeaders(SHEETS.QUARTER).slice(0, 30),
    sample_score_rows: (performanceRows || []).slice(0, 5).map(function (row) {
      return {
        login_id: row.login_id,
        full_name: row.full_name,
        attendance_score: row.attendance_score,
        kpi_score: row.kpi_score,
        final_score: row.final_score,
        quarter_score: row.quarter_score,
        rank: row.rank
      };
    })
  };
}

function buildPerformanceDetails(month, teamFilter) {
  return buildCanonicalPerformanceDetails(resolveScoreMonth(month), teamFilter);
}

function normalizeScoreName(value) {
  return normalizeIdentityValue(value);
}

function identityKeys(row) {
  const keys = [];
  const login = normalizeIdentityValue(row && row.login_id);
  const staffId = normalizeIdentityValue(row && row.staff_id);
  const fullName = normalizeScoreName(row && row.full_name);
  if (login) keys.push("login:" + login);
  if (staffId) keys.push("staff:" + staffId);
  if (fullName) keys.push("name:" + fullName);
  return keys;
}

function lookupKeysForStaff(staff) {
  const login = normalizeIdentityValue(staff && staff.login_id);
  const staffId = normalizeIdentityValue(staff && staff.staff_id);
  const fullName = normalizeScoreName(staff && staff.full_name);
  const keys = [];
  if (login) keys.push("login:" + login);
  if (staffId) keys.push("staff:" + staffId);
  if (fullName) keys.push("name:" + fullName);
  return keys;
}

function ensureScoreMapBuckets(map) {
  if (!map.__login) map.__login = {};
  if (!map.__staff) map.__staff = {};
  if (!map.__name) map.__name = {};
}

function pushScoreBucket(bucket, key, row) {
  if (!key) return;
  if (!bucket[key]) bucket[key] = [];
  bucket[key].push(row);
}

function addScoreRowToMap(map, row) {
  ensureScoreMapBuckets(map);
  pushScoreBucket(map.__login, normalizeIdentityValue(row && row.login_id), row);
  pushScoreBucket(map.__staff, normalizeIdentityValue(row && row.staff_id), row);
  pushScoreBucket(map.__name, normalizeScoreName(row && row.full_name), row);
  identityKeys(row).forEach(function (key) {
    if (!map[key]) map[key] = [];
    map[key].push(row);
  });
}

function uniqueScoreRows(rows) {
  const seen = {};
  const unique = [];
  (rows || []).forEach(function (row) {
    const rowKey = clean(row.daily_score_id || row.kpi_id || row.quarter_id) ||
      [clean(row.score_date), clean(row.kpi_month || row.score_month), identityKeys(row).join("|")].join("|") ||
      JSON.stringify(row);
    if (seen[rowKey]) return;
    seen[rowKey] = true;
    unique.push(row);
  });
  return unique;
}

function getScoreRowsForStaff(map, staff) {
  ensureScoreMapBuckets(map);
  const login = normalizeIdentityValue(staff && staff.login_id);
  const staffId = normalizeIdentityValue(staff && staff.staff_id);
  const fullName = normalizeScoreName(staff && staff.full_name);
  if (login && map.__login[login] && map.__login[login].length) return uniqueScoreRows(map.__login[login]);
  if (staffId && map.__staff[staffId] && map.__staff[staffId].length) return uniqueScoreRows(map.__staff[staffId]);
  if (fullName && map.__name[fullName] && map.__name[fullName].length) return uniqueScoreRows(map.__name[fullName]);

  const keys = lookupKeysForStaff(staff);
  for (let i = 0; i < keys.length; i++) {
    const bucket = map[keys[i]] || [];
    if (!bucket.length) continue;
    return uniqueScoreRows(bucket);
  }
  return [];
}

function setLatestScoreRow(map, row) {
  ensureScoreMapBuckets(map);
  const login = normalizeIdentityValue(row && row.login_id);
  const staffId = normalizeIdentityValue(row && row.staff_id);
  const fullName = normalizeScoreName(row && row.full_name);
  if (login) map.__login[login] = row;
  if (staffId) map.__staff[staffId] = row;
  if (fullName) map.__name[fullName] = row;
  identityKeys(row).forEach(function (key) {
    map[key] = row;
  });
}

function getLatestScoreRowForStaff(map, staff) {
  ensureScoreMapBuckets(map);
  const login = normalizeIdentityValue(staff && staff.login_id);
  const staffId = normalizeIdentityValue(staff && staff.staff_id);
  const fullName = normalizeScoreName(staff && staff.full_name);
  if (login && map.__login[login]) return map.__login[login];
  if (staffId && map.__staff[staffId]) return map.__staff[staffId];
  if (fullName && map.__name[fullName]) return map.__name[fullName];

  const keys = lookupKeysForStaff(staff);
  for (let i = 0; i < keys.length; i++) {
    if (map[keys[i]]) return map[keys[i]];
  }
  return null;
}

function rowMatchesStaffIdentity(row, staff) {
  return getScoreRowsForStaff((function () {
    const map = {};
    addScoreRowToMap(map, row);
    return map;
  })(), staff).length > 0;
}

function scoreDebugRowKey(row) {
  return [
    clean(row && row.daily_score_id),
    clean(row && row.score_date),
    clean(row && row.staff_id),
    clean(row && row.login_id),
    normalizeScoreName(row && row.full_name),
    clean(row && row.final_attendance_score)
  ].join("|");
}

function getPerformanceDetails(month, teamFilter) {
  return getCanonicalScores(month, teamFilter).rows;
}

function getCanonicalScores(month, teamFilter) {
  month = resolveScoreMonth(month);
  const teamKey = clean(teamFilter).toLowerCase();
  const staffRows = listStaffRows();
  const staffIndex = buildStaffAccessIndex(staffRows);
  const activeStaff = staffRows.filter(function (staff) {
    if (safeUpper(staff.status) !== "ACTIVE" || isAdminStaff(staff)) return false;
    return !teamKey || clean(staff.team).toLowerCase() === teamKey;
  });
  const access = teamKey ? { allowed_team: teamKey } : null;
  const dailyRows = filterRowsForAdmin(listDailyScoreRows(month, 0), access, staffIndex);
  const allDailyRows = filterRowsForAdmin(listDailyScoreRows("", 0), access, staffIndex);
  const kpiRows = filterRowsForAdmin(listKpiRows(month), access, staffIndex);
  const dailyMap = {};
  const allDailyMap = {};
  const kpiMap = {};

  dailyRows.forEach(function (row) {
    addScoreRowToMap(dailyMap, row);
  });

  allDailyRows.forEach(function (row) {
    addScoreRowToMap(allDailyMap, row);
  });

  kpiRows.forEach(function (row) {
    setLatestScoreRow(kpiMap, row);
  });

  const matchedDailyKeys = {};
  const scoreDebugMissing = [];
  const rows = activeStaff.map(function (staff) {
    let staffDaily = getScoreRowsForStaff(dailyMap, staff);
    let scoreMonthUsed = month;
    if (!staffDaily.length) {
      const fallbackDaily = latestScoreRowsForStaff(getScoreRowsForStaff(allDailyMap, staff));
      if (fallbackDaily.length) {
        staffDaily = fallbackDaily;
        scoreMonthUsed = scoreRowMonth(fallbackDaily[0]) || month;
      }
    }
    staffDaily.forEach(function (row) {
      matchedDailyKeys[scoreDebugRowKey(row)] = true;
    });
    const kpi = getLatestScoreRowForStaff(kpiMap, staff);
    const attendanceScore = averageScoreRows(staffDaily, "final_attendance_score");
    const kpiScore = kpi ? safeNumber(kpi.kpi_score_out_of_5, 0) : 0;
    const monthlyFinalScore = calculateFinalScore(attendanceScore, kpiScore);
    const quarterRows = getQuarterRowsForStaff(staff, month);
    const quarterScore = getQuarterScoreForStaff(staff, month, monthlyFinalScore);
    Logger.log("Score pipeline: " + JSON.stringify({
      selected_month: month,
      score_month_used: scoreMonthUsed,
      selected_quarter: getQuarterLabelForMonth(month),
      login_id: staff.login_id,
      staff_id: staff.staff_id,
      matched_daily_rows: staffDaily.length,
      matched_kpi_rows: kpi ? 1 : 0,
      matched_quarter_rows: quarterRows.length,
      attendance_score: attendanceScore,
      kpi_score: kpiScore,
      monthly_final_score: monthlyFinalScore,
      quarter_score: quarterScore
    }));
    if (clean(staff.login_id) && !staffDaily.length) {
      scoreDebugMissing.push({
        login_id: staff.login_id,
        staff_id: staff.staff_id,
        full_name: staff.full_name
      });
    }

    return {
      staff_id: staff.staff_id,
      login_id: staff.login_id,
      full_name: staff.full_name,
      team: staff.team,
      role: staff.role,
      status: staff.status,
      month: month,
      score_month_used: scoreMonthUsed,
      kpi_month: month,
      attendance_score: attendanceScore,
      monthly_attendance_score: attendanceScore,
      kpi_score_out_of_5: kpiScore,
      kpi_score: kpiScore,
      kpi_status: kpi ? "Scored" : "Not scored yet",
      quarter_score: quarterScore,
      quarter: getQuarterLabelForMonth(month),
      final_score: monthlyFinalScore,
      monthly_final_score: monthlyFinalScore,
      ranking_score: quarterScore,
      grade: getGrade(monthlyFinalScore),
      daily_score_count: staffDaily.length,
      has_kpi: Boolean(kpi),
      has_quarter_score: quarterRows.length > 0
    };
  });

  rows.sort(function (a, b) {
    return safeNumber(b.ranking_score, 0) - safeNumber(a.ranking_score, 0) ||
      safeNumber(b.final_score, 0) - safeNumber(a.final_score, 0) ||
      safeNumber(b.attendance_score, 0) - safeNumber(a.attendance_score, 0) ||
      safeNumber(b.kpi_score, 0) - safeNumber(a.kpi_score, 0) ||
      clean(a.full_name).localeCompare(clean(b.full_name));
  });
  rows.forEach(function (row, index) {
    row.rank = index + 1;
    row.current_rank = row.rank;
  });
  const unmatchedDailyRows = dailyRows.filter(function (row) {
    return !matchedDailyKeys[scoreDebugRowKey(row)];
  }).slice(0, 10).map(function (row) {
    return {
      score_date: row.score_date,
      staff_id: row.staff_id,
      login_id: row.login_id,
      full_name: row.full_name,
      final_attendance_score: row.final_attendance_score
    };
  });
  const matchedStaffCount = rows.filter(function (row) {
    return safeNumber(row.daily_score_count, 0) > 0 || row.has_kpi || row.has_quarter_score;
  }).length;
  Logger.log("score_debug_missing: " + JSON.stringify(scoreDebugMissing));
  return {
    month: month,
    rows: rows,
    dailyRows: dailyRows,
    kpiRows: kpiRows,
    quarterRows: listQuarterScoreRows(0),
    debug: buildScoreDebug(month, dailyRows, kpiRows, rows, {
      matched_staff_count: matchedStaffCount,
      score_debug_missing: scoreDebugMissing,
      first_10_unmatched_daily_rows: unmatchedDailyRows
    })
  };
}

function buildCanonicalPerformanceDetails(month, teamFilter) {
  return getCanonicalScores(month, teamFilter).rows;
}

function mergePerformanceIntoStaffRows(staffRows, performanceRows) {
  return (staffRows || []).map(function (staff) {
    const score = (performanceRows || []).filter(function (row) {
      return rowMatchesStaffIdentity(row, staff);
    })[0];
    return score ? Object.assign({}, staff, {
      attendance_score: score.attendance_score,
      monthly_attendance_score: score.monthly_attendance_score,
      kpi_score: score.kpi_score,
      kpi_score_out_of_5: score.kpi_score_out_of_5,
      final_score: score.final_score,
      monthly_final_score: score.monthly_final_score,
      quarter_score: score.quarter_score,
      rank: score.rank,
      current_rank: score.current_rank || score.rank,
      kpi_status: score.kpi_status
    }) : staff;
  });
}

function isAdminStaff(staff) {
  const role = safeUpper(staff && staff.role);
  const team = safeUpper(staff && staff.team);
  return role === "ADMIN" || team === "ADMIN" || role.indexOf("ADMIN") > -1 || team.indexOf("ADMIN") > -1;
}

function isNonWorkingDay(shiftCode, status) {
  const shift = safeUpper(shiftCode);
  const state = safeUpper(status);
  return ["OFF", "AL", "UL", "SL", "HOLIDAY"].indexOf(shift) !== -1 ||
    ["OFF", "AL", "UL", "SL", "HOLIDAY", "LEAVE"].indexOf(state) !== -1;
}

function dayOffMessage(shiftCode, status) {
  const shift = safeUpper(shiftCode);
  const state = safeUpper(status);
  const value = ["OFF", "AL", "UL", "SL", "HOLIDAY"].indexOf(shift) !== -1 ? shift : state;
  if (["OFF", "AL", "UL", "SL", "HOLIDAY"].indexOf(value) !== -1) return "Today is your " + value + " day.";
  return "Today is not a working day";
}

function buildStaffAccessIndex(staffRows) {
  const index = { byLogin: {}, byStaffId: {}, byEmail: {}, byName: {} };
  (staffRows || listStaffRows()).forEach(function (staff) {
    const login = normalizeIdentityValue(staff.login_id);
    const staffId = normalizeIdentityValue(staff.staff_id);
    const email = clean(staff.email).toLowerCase();
    const name = normalizeIdentityValue(staff.full_name);
    if (login) index.byLogin[login] = staff;
    if (staffId) index.byStaffId[staffId] = staff;
    if (email) index.byEmail[email] = staff;
    if (name) index.byName[name] = staff;
  });
  return index;
}

function rowMatchesAllowedTeam(row, allowedTeam, staffIndex) {
  const teamKey = clean(allowedTeam).toLowerCase();
  if (!teamKey) return true;
  staffIndex = staffIndex || buildStaffAccessIndex();
  if (clean(row.team || row.department).toLowerCase() === teamKey) return true;

  const candidates = [
    staffIndex.byLogin[normalizeIdentityValue(row.login_id)],
    staffIndex.byLogin[normalizeIdentityValue(row.staff_login_id)],
    staffIndex.byLogin[normalizeIdentityValue(row.admin_login_id)],
    staffIndex.byLogin[normalizeIdentityValue(row.updated_by)],
    staffIndex.byLogin[normalizeIdentityValue(row.submitted_by)],
    staffIndex.byStaffId[normalizeIdentityValue(row.staff_id)],
    staffIndex.byStaffId[normalizeIdentityValue(row.actor_id)],
    staffIndex.byStaffId[normalizeIdentityValue(row.target_id)],
    staffIndex.byEmail[clean(row.email).toLowerCase()],
    staffIndex.byEmail[clean(row.admin_email).toLowerCase()],
    staffIndex.byName[normalizeIdentityValue(row.full_name)],
    staffIndex.byName[normalizeIdentityValue(row.staff_name)],
    staffIndex.byName[normalizeIdentityValue(row.actor_name)],
    staffIndex.byName[normalizeIdentityValue(row.target_name)]
  ].filter(Boolean);

  return candidates.some(function (staff) {
    return clean(staff.team).toLowerCase() === teamKey;
  });
}

function filterRowsForAdmin(rows, access, staffIndex) {
  if (!access || !access.allowed_team) return rows;
  return rows.filter(function (row) {
    return rowMatchesAllowedTeam(row, access.allowed_team, staffIndex);
  });
}

/***** ADMIN DASHBOARD + LIST ACTIONS *****/

function getAdminDashboardFull(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const access = getAdminAccess(data);
  const month = resolveScoreMonth(data.month);
  const today = todayDate();
  const allStaff = listStaffRows();
  const staffIndex = buildStaffAccessIndex(allStaff);
  const staffList = filterRowsForAdmin(allStaff, access, staffIndex);
  let scheduleList = listScheduleRows(month, clean(data.date));
  if (!scheduleList.length && !clean(data.date)) {
    scheduleList = listScheduleRows("", "").filter(function (row) {
      return normalizeMonthKey(row.schedule_month) === month || normalizeDateKey(row.schedule_date) >= today;
    }).slice(0, 500);
  }
  scheduleList = filterRowsForAdmin(scheduleList, access, staffIndex);
  const attendanceEvents = filterRowsForAdmin(listAttendanceRows(clean(data.date) || today, safeNumber(data.limit, 250)), access, staffIndex);
  const breakBoard = getActiveBreakRows(clean(data.date) || today, access, staffIndex);
  const canonicalScores = getCanonicalScores(month, access.allowed_team);
  const performanceDetails = canonicalScores.rows;
  const allDailyScoresForMonth = filterRowsForAdmin(canonicalScores.dailyRows, access, staffIndex);
  const dailyScores = allDailyScoresForMonth.slice(0, safeNumber(data.limit, 250));
  const kpiList = filterRowsForAdmin(canonicalScores.kpiRows, access, staffIndex);
  const quarterScores = filterRowsForAdmin(listQuarterScoreRows(safeNumber(data.limit, 250)), access, staffIndex);
  const auditLogs = filterRowsForAdmin(listAuditRows(safeNumber(data.limit, 100)), access, staffIndex);
  const telegramLogs = filterRowsForAdmin(listTelegramRows(safeNumber(data.limit, 100)), access, staffIndex);
  const ipAllowlist = listIpRows();
  const summary = getTodaySummary(today, access.allowed_team);
  const scoredStaffList = mergePerformanceIntoStaffRows(staffList, performanceDetails);
  const nextShiftStaff = getNextShiftStaffRows(access, staffIndex);
  const scoreDebug = canonicalScores.debug;
  const leaderboard = performanceDetails.map(function (row) {
    return {
      login_id: row.login_id,
      full_name: row.full_name,
      team: row.team,
      attendance_score: row.attendance_score,
      kpi_score_out_of_5: row.kpi_score_out_of_5,
      kpi_score: row.kpi_score,
      final_score: row.final_score,
      monthly_final_score: row.monthly_final_score,
      quarter_score: row.quarter_score,
      ranking_score: row.ranking_score,
      rank: row.rank,
      current_rank: row.current_rank || row.rank,
      grade: row.grade,
      kpi_status: row.kpi_status
    };
  });

  summary.total_staff = staffList.filter(function (row) { return safeUpper(row.status) === "ACTIVE"; }).length;
  summary.online_staff = summary.currently_working;

  return {
    ok: true,
    selected_month: month,
    today: today,
    summary: summary,
    today_summary: summary,
    staff_count: summary.total_staff,
    staff_list: scoredStaffList,
    schedule_list: scheduleList,
    next_shift_staff: nextShiftStaff.slice(0, 5),
    next_shift_staff_all: nextShiftStaff,
    nextShiftStaffAll: nextShiftStaff,
    attendance_events: attendanceEvents,
    breakBoard: breakBoard,
    breaks: breakBoard,
    absent_today: summary.summary_details.absent_today || [],
    absent_today_count: summary.absent_today_count || 0,
    daily_scores: dailyScores,
    kpi_list: leaderboard,
    quarter_scores: quarterScores,
    audit_logs: auditLogs,
    telegram_logs: telegramLogs,
    ip_allowlist: ipAllowlist,
    leaderboard: leaderboard,
    topPerformers: leaderboard.slice(0, 10),
    worstPerformers: leaderboard.slice().reverse().slice(0, 10),
    performance_details: performanceDetails,
    score_debug: scoreDebug
  };
}

function getStaffList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffRows = listStaffRows();
  return { ok: true, staff_list: filterRowsForAdmin(staffRows, access, buildStaffAccessIndex(staffRows)) };
}

function getScheduleList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, schedule_list: filterRowsForAdmin(listScheduleRows(normalizeMonthKey(data.month), clean(data.date)), access, staffIndex) };
}

function getAttendanceLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, attendance_events: filterRowsForAdmin(listAttendanceRows(clean(data.date), safeNumber(data.limit, 250)), access, staffIndex) };
}

function getAuditLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, audit_logs: filterRowsForAdmin(listAuditRows(safeNumber(data.limit, 100)), access, staffIndex) };
}

function getTelegramLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, telegram_logs: filterRowsForAdmin(listTelegramRows(safeNumber(data.limit, 100)), access, staffIndex) };
}

function getIpAllowlist(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, ip_allowlist: listIpRows() };
}

function getKpiList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, selected_month: resolveScoreMonth(data.month), kpi_list: filterRowsForAdmin(listKpiRows(resolveScoreMonth(data.month)), access, staffIndex) };
}

function getQuarterScores(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, quarter_scores: filterRowsForAdmin(listQuarterScoreRows(safeNumber(data.limit, 250)), access, staffIndex) };
}

function getDailyScores(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, selected_month: resolveScoreMonth(data.month), daily_scores: filterRowsForAdmin(listDailyScoreRows(resolveScoreMonth(data.month), safeNumber(data.limit, 250)), access, staffIndex) };
}

function uploadScheduleCsv(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const adminLoginId = clean(data.admin_login_id || data.login_id || "Admin");
  const access = getAdminAccess({ admin_login_id: adminLoginId });
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const skipped = safeNumber(data.skipped, 0);
  if (!rows.length) return { ok: false, message: "No schedule rows found in CSV", inserted: 0, updated: 0, failed: 0, skipped: skipped };

  const staffByLogin = {};
  const staffByName = {};
  const staffRows = listStaffRows();
  staffRows.forEach(function (staff) {
    staffByLogin[clean(staff.login_id).toLowerCase()] = staff;
    staffByLogin[clean(staff.email).toLowerCase()] = staff;
    staffByName[normalizePersonName(staff.full_name)] = staff;
  });

  const sheet = sh(SHEETS.SCHEDULE);
  sheet.getRange("I:J").setNumberFormat("@");
  sheet.getRange(2, 9, sheet.getMaxRows(), 2).setNumberFormat("@");
  const existing = sheet.getDataRange().getValues();
  const existingMap = {};
  for (let i = 1; i < existing.length; i++) {
    existingMap[normalizeDateKey(existing[i][2]) + "|" + clean(existing[i][4]).toLowerCase()] = i + 1;
  }

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const errors = [];
  const insertRecords = [];
  const updateRecords = [];
  const frontendDebugRows = Array.isArray(data.frontend_first_10_rows) ? data.frontend_first_10_rows.slice(0, 10) : [];
  const backendReceivedDebugRows = [];
  const backendWrittenDebugRows = [];
  const pendingInsertIndex = {};

  rows.forEach(function (raw, index) {
    const row = normalizeScheduleImportRow(raw);
    if (backendReceivedDebugRows.length < 10) {
      backendReceivedDebugRows.push({
        shift_code: row.shift_code,
        start_time: row.start_time,
        end_time: row.end_time,
        status: row.status
      });
    }

    if (!row.schedule_date) {
      failed++;
      errors.push({ row: index + 2, message: "Missing schedule_date" });
      return;
    }

    const staff = staffByLogin[clean(row.login_id).toLowerCase()] || staffByName[normalizePersonName(row.full_name)];
    if (!staff || !staff.login_id) {
      failed++;
      errors.push({ row: index + 2, message: "Staff not found: " + (row.full_name || row.login_id || "blank") });
      return;
    }
    if (access.allowed_team && clean(staff.team).toLowerCase() !== clean(access.allowed_team).toLowerCase()) {
      failed++;
      errors.push({ row: index + 2, message: "Staff outside allowed team: " + clean(staff.full_name) });
      return;
    }

    const scheduleDate = normalizeDateKey(row.schedule_date);
    if (!scheduleDate) {
      failed++;
      errors.push({ row: index + 2, message: "Invalid schedule_date" });
      return;
    }

    const range = parseScheduleTimeRange(row.time_range || row.shift_time || row.working_hours || "");
    const status = safeUpper(row.status || "WORKING");
    const isWorking = status === "WORKING";
    const scheduleMonth = clean(row.schedule_month) || scheduleDate.substring(0, 7);
    const record = [
      clean(row.schedule_id) || makeId("SCH"),
      scheduleMonth,
      scheduleDate,
      clean(row.staff_id) || clean(staff.staff_id),
      clean(staff.login_id),
      clean(row.full_name) || clean(staff.full_name),
      clean(row.team) || clean(staff.team),
      safeUpper(row.shift_code || "GENERAL"),
      isWorking ? normalizeScheduleTimeForSheet(row.start_time || range.start_time || "09:00:00") : "",
      isWorking ? normalizeScheduleTimeForSheet(row.end_time || range.end_time || "18:00:00") : "",
      status,
      adminLoginId,
      nowDateTime(),
      clean(row.notes)
    ];

    record[8] = forcePlainTimeText(record[8]);
    record[9] = forcePlainTimeText(record[9]);

    if (backendWrittenDebugRows.length < 10) {
      backendWrittenDebugRows.push({
        shift_code: record[7],
        start_time: record[8],
        end_time: record[9],
        status: record[10]
      });
    }

    const key = record[2] + "|" + clean(record[4]).toLowerCase();
    if (existingMap[key] && existingMap[key] > 0) {
      updateRecords.push({ rowIndex: existingMap[key], values: record });
      updated++;
    } else if (pendingInsertIndex[key] != null) {
      insertRecords[pendingInsertIndex[key]] = record;
      updated++;
    } else {
      pendingInsertIndex[key] = insertRecords.length;
      insertRecords.push(record);
      inserted++;
    }
  });

  if (insertRecords.length) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 9, insertRecords.length, 2).setNumberFormat("@");
    sheet.getRange(startRow, 1, insertRecords.length, insertRecords[0].length).setValues(insertRecords);
  }
  writeScheduleUpdateRecords(sheet, updateRecords);

  clearSheetCache(SHEETS.SCHEDULE);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "UPLOAD_SCHEDULE_CSV", "SCHEDULE", "", "", JSON.stringify({ inserted, updated, failed, skipped }), ip, clean(data.fileName));
  return {
    ok: true,
    message: "Schedule CSV processed",
    inserted: inserted,
    updated: updated,
    failed: failed,
    skipped: skipped,
    errors: errors,
    frontend_first_10_rows: frontendDebugRows,
    backend_first_10_received_rows: backendReceivedDebugRows,
    backend_first_10_written_rows: backendWrittenDebugRows,
    written_debug_rows: backendWrittenDebugRows
  };
}

function updateSingleStaffSchedule(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const loginId = clean(data.login_id);
  const scheduleDate = normalizeDateKey(data.schedule_date);
  const shiftCode = safeUpper(data.shift_code);
  if (!loginId) return { ok: false, message: "login_id is required" };
  if (!scheduleDate) return { ok: false, message: "schedule_date is required" };
  if (!shiftCode) return { ok: false, message: "shift_code is required" };

  const nonWorkingCodes = ["OFF", "AL", "SL", "UL"];
  const isNonWorking = nonWorkingCodes.indexOf(shiftCode) !== -1;
  const shiftRule = isNonWorking ? { ok: false } : getShiftRule(shiftCode);
  if (!isNonWorking && !shiftRule.ok) return { ok: false, message: "Invalid shift_code: " + shiftCode };

  const sheet = sh(SHEETS.SCHEDULE);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  const requiredHeaders = ["login_id", "schedule_date", "shift_code", "start_time", "end_time", "status", "uploaded_by", "uploaded_at", "notes"];
  for (let i = 0; i < requiredHeaders.length; i++) {
    if (headerMap[requiredHeaders[i]] == null) return { ok: false, message: "Missing schedule header: " + requiredHeaders[i] };
  }

  let targetRow = -1;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowLoginId = clean(valueByHeader(row, headerMap, ["login_id"], null)).toLowerCase();
    const rowDate = normalizeDateKey(valueByHeader(row, headerMap, ["schedule_date"], null));
    if (rowLoginId === loginId.toLowerCase() && rowDate === scheduleDate) {
      targetRow = i + 1;
      break;
    }
  }
  if (targetRow === -1) return { ok: false, message: "Matching schedule row not found" };

  const startTime = isNonWorking ? "" : normalizeScheduleTimeForSheet(shiftRule.start_time);
  const endTime = isNonWorking ? "" : normalizeScheduleTimeForSheet(shiftRule.end_time);
  const status = isNonWorking ? shiftCode : "WORKING";
  const updates = {
    shift_code: shiftCode,
    start_time: startTime,
    end_time: endTime,
    status: status,
    uploaded_by: "Admin",
    uploaded_at: nowDateTime(),
    notes: "Schedule updated from admin panel"
  };

  Object.keys(updates).forEach(function (key) {
    const column = headerMap[key] + 1;
    if (key === "start_time" || key === "end_time") sheet.getRange(targetRow, column).setNumberFormat("@");
    sheet.getRange(targetRow, column).setValue(updates[key]);
  });

  clearSheetCache(SHEETS.SCHEDULE);
  appendAudit("ADMIN", "Admin", "Admin", "UPDATE_SINGLE_SCHEDULE", "SCHEDULE", loginId, "", JSON.stringify({
    login_id: loginId,
    schedule_date: scheduleDate,
    shift_code: shiftCode,
    status: status
  }), ip, "Schedule updated from admin panel");

  return {
    ok: true,
    updated: true,
    login_id: loginId,
    schedule_date: scheduleDate,
    shift_code: shiftCode,
    start_time: startTime,
    end_time: endTime,
    status: status
  };
}

function normalizePersonName(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function writeScheduleUpdateRecords(sheet, records) {
  if (!records.length) return;
  records.sort(function (a, b) {
    return a.rowIndex - b.rowIndex;
  });

  let batchStart = records[0].rowIndex;
  let batchRows = [records[0].values];
  let previous = records[0].rowIndex;

  for (let i = 1; i < records.length; i++) {
    const item = records[i];
    if (item.rowIndex === previous + 1) {
      batchRows.push(item.values);
    } else {
      sheet.getRange(batchStart, 9, batchRows.length, 2).setNumberFormat("@");
      sheet.getRange(batchStart, 1, batchRows.length, batchRows[0].length).setValues(batchRows);
      batchStart = item.rowIndex;
      batchRows = [item.values];
    }
    previous = item.rowIndex;
  }

  if (batchRows.length) {
    sheet.getRange(batchStart, 9, batchRows.length, 2).setNumberFormat("@");
    sheet.getRange(batchStart, 1, batchRows.length, batchRows[0].length).setValues(batchRows);
  }
}

function saveIpAllowlist(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const adminLoginId = clean(data.admin_login_id || data.login_id || "Admin");
  const ips = Array.isArray(data.ips) ? data.ips.map(clean).filter(Boolean) : [];
  if (!ips.length) return { ok: false, message: "No IP addresses provided" };

  const sheet = sh(SHEETS.IP);
  const existing = sheet.getDataRange().getValues();
  const existingMap = {};
  for (let i = 1; i < existing.length; i++) existingMap[clean(existing[i][1])] = i + 1;

  ips.forEach(function (allowedIp) {
    const row = [makeId("IP"), allowedIp, "Admin added", "ACTIVE", adminLoginId, nowDateTime(), ""];
    if (existingMap[allowedIp]) sheet.getRange(existingMap[allowedIp], 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
  });

  clearSheetCache(SHEETS.IP);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "SAVE_IP_ALLOWLIST", "SECURITY", "", "", ips.join(","), ip, "");
  return { ok: true, message: "IP allowlist saved", count: ips.length, ip_allowlist: listIpRows() };
}

function getActiveStaffCount() {
  return listStaffRows().filter(function (row) { return safeUpper(row.status) === "ACTIVE"; }).length;
}

function getTodaySummary(dateStr, teamFilter) {
  const targetDate = normalizeDateKey(dateStr);
  const teamKey = clean(teamFilter).toLowerCase();
  const access = teamKey ? { allowed_team: teamKey } : null;
  const staffIndex = buildStaffAccessIndex();
  const staffRows = filterRowsForAdmin(listStaffRows(), access, staffIndex);
  const scheduleRows = listScheduleRows("", targetDate).filter(function (row) {
    return !teamKey || clean(row.team).toLowerCase() === teamKey;
  });
  const eventRows = listAttendanceRows(targetDate, 0).slice().reverse().filter(function (row) {
    return !teamKey || rowMatchesAllowedTeam(row, teamKey, staffIndex);
  });
  const nowMinutes = parseTimeToMinutesSafe(nowTime());
  const nonWorkingCodes = ["OFF", "AL", "SL", "UL", "NP"];
  const staffByIdentity = {};
  const putStaffKey = function (value, staff) {
    const key = normalizeIdentityValue(value);
    if (key) staffByIdentity[key] = staff;
  };
  const absentIdentityKey = function (row) {
    const login = normalizeIdentityValue(row && row.login_id);
    if (login) return "login:" + login;
    const staffId = normalizeIdentityValue(row && row.staff_id);
    return staffId ? "staff:" + staffId : "";
  };
  staffRows.forEach(function (staff) {
    putStaffKey(staff.login_id, staff);
    putStaffKey(staff.staff_id, staff);
    putStaffKey(normalizeScoreName(staff.full_name), staff);
  });
  const detailFor = function (row, extra) {
    const identity = scheduleIdentityKey(row);
    const staff = staffByIdentity[identity] || {};
    const scheduleDate = normalizeDateKey(row.schedule_date || row.event_date || targetDate);
    return Object.assign({
      staff_id: row.staff_id || staff.staff_id || "",
      login_id: row.login_id || staff.login_id || "",
      full_name: row.full_name || staff.full_name || "",
      team: row.team || staff.team || "",
      role: staff.role || "",
      schedule_date: scheduleDate || targetDate,
      date: scheduleDate || targetDate,
      shift_code: row.shift_code || "",
      start_time: row.start_time || "",
      end_time: row.end_time || "",
      status: row.status || "",
      check_in_time: "",
      check_out_time: "",
      break_start_time: ""
    }, extra || {});
  };

  let working = 0;
  const workingScheduleByIdentity = {};
  const absentScheduleByIdentity = {};
  let checkedIn = {};
  const absentCheckedIn = {};
  let checkedOut = {};
  let checkOutTime = {};
  let activeBreak = {};
  let firstIn = {};
  const details = {
    total_staff: [],
    online_staff: [],
    checked_in_today: [],
    checked_in: [],
    on_break: [],
    late_staff: [],
    missing_checkout: [],
    absent_today: [],
    not_working_today: []
  };

  details.total_staff = staffRows.filter(function (row) {
    return safeUpper(row.status) === "ACTIVE";
  }).map(function (row) {
    return detailFor(row, { status: row.status });
  });

  scheduleRows.forEach(function (row) {
    const status = safeUpper(row.status);
    const shift = safeUpper(row.shift_code);
    if (nonWorkingCodes.indexOf(status) > -1 || nonWorkingCodes.indexOf(shift) > -1) {
      details.not_working_today.push(detailFor(row, { status: status || shift }));
      return;
    }
    if (status !== "WORKING" || isNonWorkingDay(row.shift_code, row.status)) return;
    const identity = scheduleIdentityKey(row);
    if (!identity) return;
    working++;
    if (!workingScheduleByIdentity[identity]) workingScheduleByIdentity[identity] = row;
    const absentKey = absentIdentityKey(row);
    if (absentKey && !absentScheduleByIdentity[absentKey]) absentScheduleByIdentity[absentKey] = row;
  });

  eventRows.forEach(function (row) {
    const identity = scheduleIdentityKey(row);
    if (!identity) return;
    const eventType = safeUpper(row.event_type);
    const breakType = safeUpper(row.break_type);
    if (eventType === "CHECK_IN") {
      checkedIn[identity] = true;
      const absentKey = absentIdentityKey(row);
      if (absentKey) absentCheckedIn[absentKey] = true;
      if (!firstIn[identity]) firstIn[identity] = normalizeSheetTime(row.event_time);
      if (!details.checked_in_today.some(function (item) { return scheduleIdentityKey(item) === identity; })) {
        details.checked_in_today.push(detailFor(row, { check_in_time: row.event_time, check_in: row.event_time, status: "CHECKED_IN" }));
      }
    }
    if (eventType === "CHECK_OUT") {
      checkedOut[identity] = true;
      checkOutTime[identity] = row.event_time;
    }
    if (eventType === "BREAK_START") {
      activeBreak[identity] = breakType;
      details.on_break = details.on_break.filter(function (item) { return scheduleIdentityKey(item) !== identity; });
      details.on_break.push(detailFor(row, { break_type: breakType, break_start_time: row.event_time, break_start: row.event_time, status: "ON_BREAK" }));
    }
    if (eventType === "BREAK_END") {
      delete activeBreak[identity];
      details.on_break = details.on_break.filter(function (item) { return scheduleIdentityKey(item) !== identity; });
    }
  });

  let currentlyWorking = 0;
  Object.keys(checkedIn).forEach(function (identity) {
    const schedule = workingScheduleByIdentity[identity];
    if (!schedule || checkedOut[identity]) return;
    const window = getScheduleWindowMinutes(schedule);
    const alignedNow = window.overnight && nowMinutes < window.start_minutes ? nowMinutes + 1440 : nowMinutes;
    if (alignedNow >= window.start_minutes && alignedNow <= window.end_minutes) {
      currentlyWorking++;
      details.online_staff.push(detailFor(schedule, { check_in_time: firstIn[identity], check_in: firstIn[identity], check_out_time: checkOutTime[identity] || "", status: "ONLINE" }));
    }
    if (alignedNow > window.end_minutes) {
      details.missing_checkout.push(detailFor(schedule, { check_in_time: firstIn[identity], check_in: firstIn[identity], check_out_time: checkOutTime[identity] || "", status: "MISSING_CHECKOUT" }));
    }
  });

  Object.keys(firstIn).forEach(function (identity) {
    const schedule = workingScheduleByIdentity[identity];
    if (!schedule) return;
    const window = getScheduleWindowMinutes(schedule);
    if (alignEventMinutesToSchedule(firstIn[identity], window) > window.start_minutes) {
      details.late_staff.push(detailFor(schedule, { check_in_time: firstIn[identity], check_in: firstIn[identity], check_out_time: checkOutTime[identity] || "", status: "LATE" }));
    }
  });

  Object.keys(absentScheduleByIdentity).forEach(function (identity) {
    if (absentCheckedIn[identity]) return;
    const schedule = absentScheduleByIdentity[identity];
    const window = getScheduleWindowMinutes(schedule);
    const alignedNow = window.overnight && nowMinutes < window.start_minutes ? nowMinutes + 1440 : nowMinutes;
    if (alignedNow < window.start_minutes + 20) return;
    const absentRow = detailFor(schedule, { status: "ABSENT" });
    details.absent_today.push(absentRow);
    sendTelegramAbsenceAlert(absentRow);
  });

  details.checked_in = details.checked_in_today;

  return {
    total_staff: details.total_staff.length,
    working_staff: working,
    checked_in: details.checked_in_today.length,
    checked_out: Object.keys(checkedOut).length,
    currently_working: details.online_staff.length,
    online_staff: details.online_staff.length,
    on_break: details.on_break.length,
    late_staff: details.late_staff.length,
    missing_checkout: details.missing_checkout.length,
    absent_today_count: details.absent_today.length,
    not_checked_in: Math.max(working - Object.keys(checkedIn).length, 0),
    not_working_today: details.not_working_today.length,
    summary_details: details
  };
}

function countLateStaff(dateStr, firstIn, teamFilter) {
  const staffIndex = buildStaffAccessIndex();
  const schedules = filterRowsForAdmin(listScheduleRows("", dateStr), { allowed_team: clean(teamFilter) }, staffIndex);
  let count = 0;
  schedules.forEach(function (row) {
    const inTime = firstIn[row.login_id];
    if (!inTime) return;
    const grace = 5;
    const scheduleWindow = getScheduleWindowMinutes(row);
    if (alignEventMinutesToSchedule(inTime, scheduleWindow) - scheduleWindow.start_minutes > grace) count++;
  });
  return count;
}

function scheduleIdentityKey(row) {
  return normalizeIdentityValue(row && row.login_id) ||
    normalizeIdentityValue(row && row.staff_id) ||
    normalizeScoreName(row && row.full_name);
}

/***** LIST MAPPERS *****/

function listStaffRows() {
  const values = getValues(SHEETS.STAFF);
  const headerMap = buildHeaderMap(values[0] || []);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    rows.push({
      staff_id: valueByHeader(row, headerMap, ["staff_id"], null),
      full_name: valueByHeader(row, headerMap, ["full_name", "staff_name", "name"], null),
      login_id: valueByHeader(row, headerMap, ["login_id"], null),
      email: valueByHeader(row, headerMap, ["email"], null),
      team: valueByHeader(row, headerMap, ["team", "department"], null),
      role: valueByHeader(row, headerMap, ["role", "position"], null),
      status: valueByHeader(row, headerMap, ["status"], null),
      joining_date: normalizeDateKey(valueByHeader(row, headerMap, ["joining_date", "join_date"], null)),
      manager: valueByHeader(row, headerMap, ["manager", "reporting_manager"], null),
      phone: valueByHeader(row, headerMap, ["phone", "mobile"], null),
      telegram_user_id: valueByHeader(row, headerMap, ["telegram_user_id", "telegram_id"], null),
      notes: valueByHeader(row, headerMap, ["notes"], null)
    });
  }
  return rows;
}

function listScheduleRows(month, dateStr) {
  const targetMonth = normalizeMonthKey(month);
  const values = getValues(SHEETS.SCHEDULE);
  const headerMap = buildHeaderMap(values[0] || []);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = mapScheduleRow(values[i], headerMap);
    if (targetMonth && normalizeMonthKey(row.schedule_month) !== targetMonth) continue;
    if (dateStr && normalizeDateKey(row.schedule_date) !== normalizeDateKey(dateStr)) continue;
    rows.push(row);
  }
  return rows;
}

function mapScheduleRow(row, headerMap) {
  const read = function (keys) {
    return valueByHeader(row, headerMap || {}, keys, null);
  };
  return {
    ok: true,
    schedule_id: read(["schedule_id"]),
    schedule_month: read(["schedule_month"]),
    schedule_date: normalizeDateKey(read(["schedule_date", "date"])),
    staff_id: read(["staff_id"]),
    login_id: read(["login_id"]),
    full_name: read(["full_name", "staff_name", "name"]),
    team: read(["team", "department"]),
    shift_code: read(["shift_code", "shift"]),
    start_time: normalizeSheetTime(read(["start_time", "scheduled_start"])),
    end_time: normalizeSheetTime(read(["end_time", "scheduled_end"])),
    status: read(["status"]),
    uploaded_by: read(["uploaded_by"]) || "",
    uploaded_at: read(["uploaded_at"]) || "",
    notes: read(["notes"]) || ""
  };
}

function listAttendanceRows(dateStr, limit) {
  const values = getValues(SHEETS.EVENTS);
  const headerMap = buildHeaderMap(values[0] || []);
  const rows = [];
  const targetDate = normalizeDateKey(dateStr);
  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    const eventDate = valueByHeader(row, headerMap, ["event_date", "date"], null);
    if (targetDate && normalizeDateKey(eventDate) !== targetDate) continue;
    rows.push({
      event_id: valueByHeader(row, headerMap, ["event_id"], null),
      event_date: normalizeDateKey(eventDate),
      event_time: normalizeSheetTime(valueByHeader(row, headerMap, ["event_time", "time"], null)),
      created_at: normalizeDateKey(eventDate) + " " + normalizeSheetTime(valueByHeader(row, headerMap, ["event_time", "time"], null)),
      staff_id: valueByHeader(row, headerMap, ["staff_id"], null),
      login_id: valueByHeader(row, headerMap, ["login_id"], null),
      full_name: valueByHeader(row, headerMap, ["full_name", "staff_name", "name"], null),
      event_type: valueByHeader(row, headerMap, ["event_type", "action"], null),
      break_type: valueByHeader(row, headerMap, ["break_type"], null),
      shift_code: valueByHeader(row, headerMap, ["shift_code", "shift"], null),
      ip: valueByHeader(row, headerMap, ["ip", "ip_address"], null),
      user_agent: valueByHeader(row, headerMap, ["user_agent"], null),
      source: valueByHeader(row, headerMap, ["source"], null),
      server_time: valueByHeader(row, headerMap, ["server_time"], null),
      notes: valueByHeader(row, headerMap, ["notes"], null),
      status: valueByHeader(row, headerMap, ["event_type", "action"], null)
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listDailyScoreRows(month, limit) {
  const targetMonth = normalizeMonth(month);
  const values = getValues(SHEETS.DAILY);
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const rowValues = values[i];
    const scoreDate = valueByHeader(rowValues, headerMap, ["score_date"], null);
    const scoreMonth = valueByHeader(rowValues, headerMap, ["score_month", "schedule_month", "month"], null);
    const rowMonth = normalizeMonth(scoreDate) || normalizeMonth(scoreMonth);
    if (targetMonth && rowMonth !== targetMonth) continue;
    rows.push({
      daily_score_id: valueByHeader(rowValues, headerMap, ["score_id", "daily_score_id"], null),
      score_date: normalizeDateKey(scoreDate),
      score_month: rowMonth || scoreMonth,
      staff_id: valueByHeader(rowValues, headerMap, ["staff_id"], null),
      login_id: valueByHeader(rowValues, headerMap, ["login_id"], null),
      full_name: valueByHeader(rowValues, headerMap, ["full_name", "name"], null),
      shift_code: valueByHeader(rowValues, headerMap, ["shift_code"], null),
      start_time: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["scheduled_start", "start_time"], null)),
      end_time: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["scheduled_end", "end_time"], null)),
      check_in: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["first_check_in", "check_in"], null)),
      check_out: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["last_check_out", "check_out"], null)),
      status: valueByHeader(rowValues, headerMap, ["attendance_status", "status"], null),
      base_score: valueByHeader(rowValues, headerMap, ["base_score"], null),
      penalty: valueByHeader(rowValues, headerMap, ["total_penalty", "penalty"], null),
      final_attendance_score: valueByHeader(rowValues, headerMap, ["final_attendance_score", "final_attendance", "attendance_score"], null),
      created_at: valueByHeader(rowValues, headerMap, ["calculated_at", "created_at"], null),
      notes: valueByHeader(rowValues, headerMap, ["notes"], null)
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listKpiRows(month) {
  const targetMonth = normalizeMonth(month);
  const values = getValues(SHEETS.KPI);
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const rowValues = values[i];
    const kpiMonth = valueByHeader(rowValues, headerMap, ["kpi_month", "month"], null);
    const rowMonth = normalizeMonth(kpiMonth);
    if (targetMonth && rowMonth !== targetMonth) continue;
    rows.push({
      kpi_id: valueByHeader(rowValues, headerMap, ["kpi_id"], null),
      kpi_month: rowMonth || kpiMonth,
      staff_id: valueByHeader(rowValues, headerMap, ["staff_id"], null),
      login_id: valueByHeader(rowValues, headerMap, ["login_id"], null),
      full_name: valueByHeader(rowValues, headerMap, ["full_name", "name"], null),
      team: valueByHeader(rowValues, headerMap, ["team"], null),
      L_Leadership: valueByHeader(rowValues, headerMap, ["L_Leadership", "Leadership"], null),
      E_Effectiveness: valueByHeader(rowValues, headerMap, ["E_Effectiveness", "Effectiveness"], null),
      P_ProblemSolving: valueByHeader(rowValues, headerMap, ["P_ProblemSolving", "ProblemSolving", "Problem_Solving"], null),
      C_Communication: valueByHeader(rowValues, headerMap, ["C_Communication", "Communication"], null),
      PR_Productivity: valueByHeader(rowValues, headerMap, ["PR_Productivity", "Productivity"], null),
      I_Initiative: valueByHeader(rowValues, headerMap, ["I_Initiative", "Initiative"], null),
      Penalty: valueByHeader(rowValues, headerMap, ["Penalty"], null),
      raw_score: valueByHeader(rowValues, headerMap, ["kpi_total_raw", "raw_score"], null),
      kpi_score_out_of_5: valueByHeader(rowValues, headerMap, ["kpi_score_out_of_5", "kpi_score"], null),
      updated_by: valueByHeader(rowValues, headerMap, ["submitted_by", "updated_by"], null),
      created_at: valueByHeader(rowValues, headerMap, ["submitted_at", "created_at"], null),
      updated_at: valueByHeader(rowValues, headerMap, ["updated_at"], null),
      notes: valueByHeader(rowValues, headerMap, ["notes"], null)
    });
  }
  rows.forEach(function (row, index) { row.rank = index + 1; });
  return rows;
}

function listQuarterScoreRows(limit) {
  const values = getValues(SHEETS.QUARTER);
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const rowValues = values[i];
    rows.push({
      quarter_score_id: valueByHeader(rowValues, headerMap, ["quarter_id", "quarter_score_id"], null),
      quarter: valueByHeader(rowValues, headerMap, ["quarter_label", "quarter"], null),
      from_month: valueByHeader(rowValues, headerMap, ["quarter_start_month", "quarter_start_mo", "from_month"], null),
      to_month: valueByHeader(rowValues, headerMap, ["quarter_end_month", "quarter_end_mo", "to_month"], null),
      staff_id: valueByHeader(rowValues, headerMap, ["staff_id"], null),
      login_id: valueByHeader(rowValues, headerMap, ["login_id"], null),
      full_name: valueByHeader(rowValues, headerMap, ["full_name", "name"], null),
      team: valueByHeader(rowValues, headerMap, ["team"], null),
      attendance_avg: valueByHeader(rowValues, headerMap, ["attendance_avg"], null),
      kpi_avg: valueByHeader(rowValues, headerMap, ["kpi_avg"], null),
      attendance_weight: valueByHeader(rowValues, headerMap, ["attendance_weight"], null),
      kpi_weight: valueByHeader(rowValues, headerMap, ["kpi_weight"], null),
      quarter_score: valueByHeader(rowValues, headerMap, ["quarter_score"], null),
      final_score: valueByHeader(rowValues, headerMap, ["final_score"], null),
      final_grade: valueByHeader(rowValues, headerMap, ["final_grade"], null),
      rank: valueByHeader(rowValues, headerMap, ["rank"], null),
      created_at: valueByHeader(rowValues, headerMap, ["calculated_at", "created_at"], null),
      notes: valueByHeader(rowValues, headerMap, ["notes"], null)
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listAuditRows(limit) {
  const values = getValues(SHEETS.AUDIT);
  const headerMap = buildHeaderMap(values[0] || []);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    rows.push({
      audit_id: valueByHeader(row, headerMap, ["audit_id"], 0),
      created_at: valueByHeader(row, headerMap, ["created_at", "timestamp"], 1),
      actor_type: valueByHeader(row, headerMap, ["actor_type"], 2),
      actor_id: valueByHeader(row, headerMap, ["actor_id"], 3),
      actor_name: valueByHeader(row, headerMap, ["actor_name"], 4),
      action: valueByHeader(row, headerMap, ["action"], 5),
      module: valueByHeader(row, headerMap, ["module"], 6),
      target_id: valueByHeader(row, headerMap, ["target_id"], 7),
      old_value: valueByHeader(row, headerMap, ["old_value"], 8),
      new_value: valueByHeader(row, headerMap, ["new_value"], 9),
      ip: valueByHeader(row, headerMap, ["ip", "ip_address"], 10),
      result: valueByHeader(row, headerMap, ["result", "notes"], 11) || "OK"
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listTelegramRows(limit) {
  const values = getValues(SHEETS.TG);
  const headerMap = buildHeaderMap(values[0] || []);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    rows.push({
      telegram_log_id: valueByHeader(row, headerMap, ["telegram_log_id", "tg_id"], 0),
      created_at: valueByHeader(row, headerMap, ["created_at", "timestamp"], 1),
      type: valueByHeader(row, headerMap, ["type"], 2),
      staff_id: valueByHeader(row, headerMap, ["staff_id"], 3),
      login_id: valueByHeader(row, headerMap, ["login_id"], 4),
      full_name: valueByHeader(row, headerMap, ["full_name", "name"], 5),
      event_type: valueByHeader(row, headerMap, ["event_type", "action"], 6),
      message: valueByHeader(row, headerMap, ["message"], 7),
      status: valueByHeader(row, headerMap, ["status"], 8),
      response: valueByHeader(row, headerMap, ["response"], 9),
      notes: valueByHeader(row, headerMap, ["notes"], 10)
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listIpRows() {
  const values = getValues(SHEETS.IP);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (!clean(values[i][1])) continue;
    rows.push({
      ip_id: values[i][0],
      ip_address: values[i][1],
      label: values[i][2],
      status: values[i][3],
      added_by: values[i][4],
      added_at: values[i][5],
      notes: values[i][6]
    });
  }
  return rows;
}

function normalizeScheduleImportRow(input) {
  const out = {};
  Object.keys(input || {}).forEach(function (key) {
    const normalizedKey = clean(key).toLowerCase().replace(/\s+/g, "_");
    out[normalizedKey] = clean(input[key]);
  });
  return {
    schedule_id: out.schedule_id || out.id,
    schedule_month: out.schedule_month || out.month,
    schedule_date: out.schedule_date || out.date || out.day,
    staff_id: out.staff_id,
    login_id: out.login_id || out.loginid || out.staff_login_id || out.email,
    full_name: out.full_name || out.name || out.staff_name,
    team: out.team || out.department,
    shift_code: out.shift_code || out.shift || out.shift_name,
    start_time: out.start_time || out.start || out.shift_start,
    end_time: out.end_time || out.end || out.shift_end,
    time_range: out.time_range || out.shift_time || out.working_hours || out.hours,
    status: out.status || out.day_status,
    uploaded_by: out.uploaded_by,
    uploaded_at: out.uploaded_at,
    notes: out.notes
  };
}

/***** KPI *****/

function saveMonthlyKPI(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const adminLoginId = clean(data.admin_login_id);
  const staffIdentifier = clean(data.login_id || data.staff_id || data.staffId || data.email);
  const month = normalizeMonthKey(data.kpi_month || data.month);
  if (!adminLoginId || !staffIdentifier || !month) return { ok: false, message: "Missing admin, staff, or month" };

  const staff = getStaffByIdentifier(staffIdentifier);
  if (!staff.ok) return staff;
  const access = getAdminAccess({ admin_login_id: adminLoginId });
  if (access.allowed_team && clean(staff.team).toLowerCase() !== clean(access.allowed_team).toLowerCase()) {
    return { ok: false, message: "This admin can only update CSP team KPI records" };
  }

  const L = safeNumber(data.L_Leadership, 0);
  const E = safeNumber(data.E_Effectiveness, 0);
  const P = safeNumber(data.P_ProblemSolving, 0);
  const C = safeNumber(data.C_Communication, 0);
  const PR = safeNumber(data.PR_Productivity, 0);
  const I = safeNumber(data.I_Initiative, 0);
  const Penalty = safeNumber(data.Penalty, 0);
  const raw = L + E + P + C + PR + I - Penalty;
  const score = Math.max(0, Math.min(5, raw / 6));

  const sheet = sh(SHEETS.KPI);
  const values = sheet.getDataRange().getValues();
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  for (let i = 1; i < values.length; i++) {
    const rowStaffId = valueByHeader(values[i], headerMap, ["staff_id"], 2);
    const rowLoginId = valueByHeader(values[i], headerMap, ["login_id"], 3);
    if (normalizeMonthKey(values[i][1]) === month &&
      (clean(rowLoginId).toLowerCase() === clean(staff.login_id).toLowerCase() || clean(rowStaffId).toLowerCase() === clean(staff.staff_id).toLowerCase())) {
      sheet.getRange(i + 1, 7, 1, 13).setValues([[L, E, P, C, PR, I, Penalty, raw, score, adminLoginId, nowDateTime(), nowDateTime(), clean(data.notes)]]);
      clearSheetCache(SHEETS.KPI);
      appendAudit("ADMIN", adminLoginId, adminLoginId, "UPDATE_KPI", "KPI", staff.login_id, "", JSON.stringify(data), ip, "");
      return { ok: true, message: "KPI updated", kpi_score_out_of_5: score };
    }
  }

  sheet.appendRow([makeId("KPI"), month, staff.staff_id, staff.login_id, staff.full_name, staff.team, L, E, P, C, PR, I, Penalty, raw, score, adminLoginId, nowDateTime(), nowDateTime(), clean(data.notes)]);
  clearSheetCache(SHEETS.KPI);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "SAVE_KPI", "KPI", staff.login_id, "", JSON.stringify(data), ip, "");
  return { ok: true, message: "KPI saved", kpi_score_out_of_5: score };
}

function getOwnKPI(loginId, month) {
  const targetMonth = normalizeMonth(month);
  const staff = getStaffByIdentifier(loginId);
  const identity = staff.ok ? staff : { login_id: loginId };
  const rows = listKpiRows(targetMonth).filter(function (row) {
    return rowMatchesStaffIdentity(row, identity);
  });
  return rows.length ? rows[rows.length - 1] : null;
}

/***** DAILY + QUARTER SCORE *****/

function round2(value) {
  return Number(safeNumber(value, 0).toFixed(2));
}

function clampScore(value) {
  return Math.max(0, Math.min(5, round2(value)));
}

function buildDailyScoreRow(existingRow, headerMap, record) {
  const row = existingRow.slice();
  const set = function (keys, value) {
    for (let i = 0; i < keys.length; i++) {
      const key = normalizeHeaderKey(keys[i]);
      if (headerMap[key] != null) {
        row[headerMap[key]] = value;
        return;
      }
    }
  };

  set(["daily_score_id", "score_id"], record.daily_score_id);
  set(["score_date", "date"], record.score_date);
  set(["score_month", "schedule_month", "month"], record.score_month);
  set(["staff_id"], record.staff_id);
  set(["login_id"], record.login_id);
  set(["full_name", "name"], record.full_name);
  set(["shift_code"], record.shift_code);
  set(["scheduled_start", "start_time"], record.scheduled_start);
  set(["scheduled_end", "end_time"], record.scheduled_end);
  set(["first_check_in", "check_in"], record.first_check_in);
  set(["last_check_out", "check_out"], record.last_check_out);
  set(["total_break_min"], record.total_break_min);
  set(["total_bio_break"], record.total_bio_break);
  set(["total_prayer_break"], record.total_prayer_break);
  set(["break_overuse", "break_overuse_minutes"], record.break_overuse);
  set(["missing_checkin", "missing_check_in"], record.missing_checkin);
  set(["missing_checkout", "missing_check_out"], record.missing_checkout);
  set(["late_minutes"], record.late_minutes);
  set(["attendance_status", "status"], record.attendance_status);
  set(["base_score"], record.base_score);
  set(["total_penalty", "penalty"], record.total_penalty);
  set(["final_attendance_score", "final_attendance", "attendance_score"], record.final_attendance_score);
  set(["calculated_at", "created_at"], record.calculated_at);
  set(["notes"], record.notes);
  return row;
}

function isWorkingDailyScoreRow(row) {
  if (!row) return false;
  const status = safeUpper(row.status);
  const workingStatuses = ["WORKING", "PRESENT", "LATE", "EARLY_CHECKOUT", "BREAK_OVERUSE", "MISSING_CHECK_IN", "MISSING_CHECK_OUT"];
  return workingStatuses.indexOf(status) !== -1 && !isNonWorkingDay(row.shift_code, row.status);
}

function calculateMonthlyAttendanceScore(loginId, month) {
  const staff = getStaffByIdentifier(loginId);
  const identity = staff.ok ? staff : { login_id: loginId };
  const targetMonth = resolveScoreMonth(month);
  const rows = listDailyScoreRows(targetMonth, 0).filter(function (row) {
    return rowMatchesStaffIdentity(row, identity) && isWorkingDailyScoreRow(row);
  });
  let total = 0;
  rows.forEach(function (row) {
    total += clampScore(row.final_attendance_score);
  });
  const score = rows.length ? round2(total / rows.length) : 0;
  Logger.log("Monthly score calculation: " + JSON.stringify({
    login_id: clean(loginId),
    month: targetMonth,
    row_count: rows.length,
    attendance_score: score
  }));
  return score;
}

function calculateFinalScore(attendanceScore, kpiScore) {
  const score = round2((safeNumber(attendanceScore, 0) * 0.4) + (safeNumber(kpiScore, 0) * 0.6));
  Logger.log("Final score calculation: " + JSON.stringify({
    attendance_score: safeNumber(attendanceScore, 0),
    kpi_score: safeNumber(kpiScore, 0),
    final_score: score
  }));
  return score;
}

function calculateDailyScore(data) {
  try {
    const loginId = clean(data.login_id);
    const dateStr = clean(data.date) || todayDate();
    const staff = getStaffByLogin(loginId);
    if (!staff.ok) return staff;
    const schedule = getScheduleForDate(staff, dateStr);
    if (!schedule.ok) return schedule;

    const settings = getSettings();
    const state = getAttendanceState(staff, dateStr);
    const score = calculateDailyAttendanceScore(staff, schedule, state, settings, dateStr);
    const sheet = sh(SHEETS.DAILY);
    const values = sheet.getDataRange().getValues();
    const headerMap = buildHeaderMap(values[0] || []);
    let existingRow = 0;
    for (let i = 1; i < values.length; i++) {
      const rowDate = normalizeDateKey(valueByHeader(values[i], headerMap, ["score_date"], null));
      const rowLoginId = clean(valueByHeader(values[i], headerMap, ["login_id"], null)).toLowerCase();
      const rowStaffId = clean(valueByHeader(values[i], headerMap, ["staff_id"], null)).toLowerCase();
      const loginMatches = rowLoginId && rowLoginId === clean(staff.login_id).toLowerCase();
      const staffMatches = !rowLoginId && rowStaffId && rowStaffId === clean(staff.staff_id).toLowerCase();
      if (rowDate === normalizeDateKey(dateStr) && (loginMatches || staffMatches)) {
        existingRow = i + 1;
        break;
      }
    }
    const currentRow = existingRow ? values[existingRow - 1].slice() : new Array((values[0] || []).length).fill("");
    const existingId = existingRow ? valueByHeader(currentRow, headerMap, ["daily_score_id", "score_id"], null) : "";
    const dailyRow = buildDailyScoreRow(currentRow, headerMap, {
      daily_score_id: clean(existingId) || makeId("DAS"),
      score_date: normalizeDateKey(dateStr),
      score_month: clean(schedule.schedule_month) || normalizeDateKey(dateStr).substring(0, 7),
      staff_id: staff.staff_id,
      login_id: staff.login_id,
      full_name: staff.full_name,
      shift_code: schedule.shift_code,
      scheduled_start: schedule.start_time,
      scheduled_end: schedule.end_time,
      first_check_in: state.firstCheckIn,
      last_check_out: state.lastCheckOut,
      total_break_min: score.total_break_min,
      total_bio_break: score.total_bio_break,
      total_prayer_break: score.total_prayer_break,
      break_overuse: score.break_overuse_minutes,
      missing_checkin: state.hasCheckIn ? "NO" : "YES",
      missing_checkout: state.hasCheckOut ? "NO" : "YES",
      late_minutes: score.late_minutes,
      attendance_status: score.status,
      base_score: score.base_score,
      total_penalty: score.penalty,
      final_attendance_score: score.final_attendance_score,
      calculated_at: nowDateTime(),
      notes: score.notes
    });
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, dailyRow.length).setValues([dailyRow]);
    } else {
      sheet.appendRow(dailyRow);
    }
    clearSheetCache(SHEETS.DAILY);
    return {
      ok: true,
      message: existingRow ? "Daily score updated" : "Daily score calculated",
      final_attendance_score: score.final_attendance_score,
      penalty: score.penalty,
      status: score.status,
      late_minutes: score.late_minutes,
      early_checkout_minutes: score.early_checkout_minutes,
      break_overuse_minutes: score.break_overuse_minutes
    };
  } catch (err) {
    logInternalError("calculateDailyScore", err);
    return { ok: false, message: "Daily score calculation failed. Please try again." };
  }
}

function calculateDailyAttendanceScore(staff, schedule, state, settings, dateStr) {
  settings = settings || getSettings();
  const base = clampScore(safeNumber(settings.ATTENDANCE_BASE_SCORE, 5));
  const shiftCode = safeUpper(schedule && schedule.shift_code);
  const scheduleStatus = safeUpper(schedule && schedule.status);
  let penalty = 0;
  let status = "PRESENT";
  let lateMinutes = 0;
  let earlyCheckoutMinutes = 0;
  let breakOveruseMinutes = 0;

  if (isNonWorkingDay(shiftCode, scheduleStatus) || scheduleStatus !== "WORKING") {
    status = isNonWorkingDay(shiftCode, scheduleStatus) ? (shiftCode || scheduleStatus) : scheduleStatus;
    const nonWorkingResult = {
      base_score: base,
      penalty: 0,
      final_attendance_score: base,
      status: status,
      late_minutes: 0,
      early_checkout_minutes: 0,
      break_overuse_minutes: 0,
      total_break_min: 0,
      total_bio_break: 0,
      total_prayer_break: 0,
      notes: "Non-working day"
    };
    Logger.log("Daily score calculation: " + JSON.stringify({
      login_id: staff && staff.login_id,
      date: normalizeDateKey(dateStr),
      shift_code: shiftCode,
      schedule_status: scheduleStatus,
      result: nonWorkingResult
    }));
    return nonWorkingResult;
  }

  if (!state.hasCheckIn) {
    penalty += safeNumber(settings.MISSING_SIGNIN_PENALTY, 1);
    status = "MISSING_CHECK_IN";
  }

  if (state.hasCheckIn && !state.hasCheckOut) {
    penalty += safeNumber(settings.MISSING_SIGNOUT_PENALTY, 0.5);
    if (status === "PRESENT") status = "MISSING_CHECK_OUT";
  }

  if (state.firstCheckIn) {
    const scheduleWindow = getScheduleWindowMinutes(schedule);
    const checkInMinutes = alignEventMinutesToSchedule(state.firstCheckIn, scheduleWindow);
    lateMinutes = Math.max(0, checkInMinutes - scheduleWindow.start_minutes);
    const grace = safeNumber(settings.LATE_GRACE_MINUTES, 5);
    if (lateMinutes > grace) {
      const step = Math.max(1, safeNumber(settings.LATE_STEP_MINUTES, 5));
      penalty += Math.ceil((lateMinutes - grace) / step) * safeNumber(settings.LATE_PENALTY_PER_STEP, 0.25);
      if (status === "PRESENT") status = "LATE";
    }
  }

  if (state.lastCheckOut) {
    const scheduleWindow = getScheduleWindowMinutes(schedule);
    const checkOutMinutes = alignEventMinutesToSchedule(state.lastCheckOut, scheduleWindow);
    earlyCheckoutMinutes = Math.max(0, scheduleWindow.end_minutes - checkOutMinutes);
    if (earlyCheckoutMinutes > 0) {
      const step = Math.max(1, safeNumber(settings.EARLY_CHECKOUT_STEP_MINUTES, safeNumber(settings.LATE_STEP_MINUTES, 5)));
      penalty += Math.ceil(earlyCheckoutMinutes / step) * safeNumber(settings.EARLY_CHECKOUT_PENALTY_PER_STEP, 0.25);
      if (status === "PRESENT") status = "EARLY_CHECKOUT";
    }
  }

  const breakUsage = calculateBreakOveruse(staff, dateStr, schedule, settings);
  breakOveruseMinutes = breakUsage.overuse_minutes;
  if (breakOveruseMinutes > 0) {
    penalty += breakUsage.penalty;
    if (status === "PRESENT") status = "BREAK_OVERUSE";
  }

  const finalScore = clampScore(base - penalty);
  const result = {
    base_score: base,
    penalty: round2(penalty),
    final_attendance_score: finalScore,
    status: status,
    late_minutes: lateMinutes,
    early_checkout_minutes: earlyCheckoutMinutes,
    break_overuse_minutes: breakOveruseMinutes,
    total_break_min: breakUsage.total_break_min,
    total_bio_break: breakUsage.total_bio_break,
    total_prayer_break: breakUsage.total_prayer_break,
    notes: JSON.stringify({
      late_minutes: lateMinutes,
      early_checkout_minutes: earlyCheckoutMinutes,
      break_overuse_minutes: breakOveruseMinutes,
      break_details: breakUsage.details,
      break_overuse_details: breakUsage.break_overuse_details
    })
  };

  Logger.log("Daily score calculation: " + JSON.stringify({
    login_id: staff && staff.login_id,
    date: normalizeDateKey(dateStr),
    shift_code: shiftCode,
    schedule_status: scheduleStatus,
    has_check_in: state.hasCheckIn,
    has_check_out: state.hasCheckOut,
    result: result
  }));

  return result;
}

function getScheduleWindowMinutes(schedule) {
  const startMinutes = parseTimeToMinutesSafe(schedule && schedule.start_time);
  let endMinutes = parseTimeToMinutesSafe(schedule && schedule.end_time);
  if (endMinutes <= startMinutes) endMinutes += 1440;
  return {
    start_minutes: startMinutes,
    end_minutes: endMinutes,
    overnight: endMinutes > 1440
  };
}

function alignEventMinutesToSchedule(eventTime, scheduleWindow) {
  let minutes = parseTimeToMinutesSafe(eventTime);
  if (scheduleWindow && scheduleWindow.overnight && minutes < scheduleWindow.start_minutes) minutes += 1440;
  return minutes;
}

function calculateBreakOveruse(staff, dateStr, schedule, settings) {
  return evaluateBreakUsage(staff, dateStr, schedule, settings || getSettings());
}

function normalizeBreakType(value) {
  const type = safeUpper(value).replace(/\s+/g, "_");
  if (type === "BIO" || type === "BIOBREAK") return "BIO_BREAK";
  if (type === "PRAYER" || type === "PRAYERBREAK") return "PRAYER_BREAK";
  if (type === "JUST_BREAK" || type === "BREAK" || type === "NORMAL_BREAK" || type === "BREAK_BREAK") return "BREAK";
  if (type === "BIO_BREAK" || type === "PRAYER_BREAK") return type;
  return type;
}

function getBreakRulesForSchedule(schedule, settings) {
  const rule = getShiftRule(schedule && schedule.shift_code);
  return {
    step: Math.max(1, safeNumber(settings && settings.BREAK_OVERUSE_STEP_MINUTES, safeNumber(settings && settings.LATE_STEP_MINUTES, 5))),
    penalty_unit: safeNumber(settings && settings.BREAK_OVERUSE_PENALTY_PER_STEP, 0.25),
    limits: {
      BREAK: rule.ok ? safeNumber(rule.break_limit_min, 60) : 60,
      BIO_BREAK: 10,
      PRAYER_BREAK: rule.ok ? safeNumber(rule.prayer_break_limit_min, 15) : 15
    },
    counts: {
      BREAK: rule.ok ? safeNumber(rule.break_count_limit, 1) : 1,
      BIO_BREAK: rule.ok ? safeNumber(rule.bio_break_count_limit, 3) : 3,
      PRAYER_BREAK: rule.ok ? safeNumber(rule.prayer_break_count_limit, 3) : 3
    }
  };
}

function evaluateBreakUsage(staff, dateStr, schedule, settings) {
  const rules = getBreakRulesForSchedule(schedule, settings || getSettings());
  const usage = getCompletedBreakUsage(staff, dateStr, schedule);
  let overuseMinutes = 0;
  const details = {};
  const overuseDetails = [];

  Object.keys(rules.limits).forEach(function (type) {
    const item = usage[type] || { seconds: 0, count: 0, sessions: [] };
    details[type] = {
      count: item.count,
      total_minutes: Math.floor(item.seconds / 60),
      overuse_minutes: 0,
      extra_sessions: Math.max(0, item.count - rules.counts[type])
    };

    item.sessions.forEach(function (session, index) {
      const usedMinutes = Math.floor(session.duration_seconds / 60);
      const sessionOveruse = Math.max(0, usedMinutes - rules.limits[type]);
      if (sessionOveruse >= 1) {
        const sessionPenalty = Math.ceil(sessionOveruse / rules.step) * rules.penalty_unit;
        overuseMinutes += sessionOveruse;
        details[type].overuse_minutes += sessionOveruse;
        overuseDetails.push({
          break_type: type,
          start_time: session.start_time,
          end_time: session.end_time,
          used_minutes: usedMinutes,
          allowed_minutes: rules.limits[type],
          overuse_minutes: sessionOveruse,
          reason: "Duration over limit",
          penalty: round2(sessionPenalty)
        });
      }

      if (index >= rules.counts[type]) {
        const extraPenalty = rules.penalty_unit;
        overuseMinutes += rules.step;
        details[type].overuse_minutes += rules.step;
        overuseDetails.push({
          break_type: type,
          start_time: session.start_time,
          end_time: session.end_time,
          used_minutes: usedMinutes,
          allowed_minutes: rules.limits[type],
          overuse_minutes: rules.step,
          reason: "Extra break session",
          penalty: round2(extraPenalty)
        });
      }
    });
  });

  return {
    overuse_minutes: overuseMinutes,
    penalty: overuseMinutes > 0 ? round2(Math.ceil(overuseMinutes / rules.step) * rules.penalty_unit) : 0,
    total_break_min: Math.floor((usage.BREAK && usage.BREAK.seconds || 0) / 60),
    total_bio_break: usage.BIO_BREAK ? usage.BIO_BREAK.count : 0,
    total_prayer_break: usage.PRAYER_BREAK ? usage.PRAYER_BREAK.count : 0,
    details: details,
    break_overuse_details: overuseDetails,
    sessions: usage
  };
}

function getCompletedBreakUsage(staff, dateStr, schedule) {
  const values = getValues(SHEETS.EVENTS);
  const headerMap = buildHeaderMap(values[0] || []);
  const targetDate = normalizeDateKey(dateStr);
  const targetLogin = clean(staff && staff.login_id).toLowerCase();
  const targetStaffId = clean(staff && staff.staff_id).toLowerCase();
  const usage = {
    BREAK: { seconds: 0, count: 0, sessions: [] },
    PRAYER_BREAK: { seconds: 0, count: 0, sessions: [] },
    BIO_BREAK: { seconds: 0, count: 0, sessions: [] }
  };
  const activeStarts = { BREAK: [], PRAYER_BREAK: [], BIO_BREAK: [] };
  const events = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const eventDate = valueByHeader(row, headerMap, ["event_date", "date"], null);
    if (normalizeDateKey(eventDate) !== targetDate) continue;

    const rowLoginId = clean(valueByHeader(row, headerMap, ["login_id"], null)).toLowerCase();
    const rowStaffId = clean(valueByHeader(row, headerMap, ["staff_id"], null)).toLowerCase();
    const loginMatches = targetLogin && rowLoginId && rowLoginId === targetLogin;
    const staffMatches = targetStaffId && !rowLoginId && rowStaffId && rowStaffId === targetStaffId;
    if (!loginMatches && !staffMatches) continue;

    const eventType = safeUpper(valueByHeader(row, headerMap, ["event_type", "action"], null));
    const breakType = normalizeBreakType(valueByHeader(row, headerMap, ["break_type"], null));
    if (!usage[breakType]) continue;

    events.push({
      event_type: eventType,
      break_type: breakType,
      event_time: normalizeSheetTime(valueByHeader(row, headerMap, ["event_time", "time"], null)),
      timestamp_seconds: eventTimestampSeconds(eventDate, valueByHeader(row, headerMap, ["event_time", "time"], null), schedule)
    });
  }

  events.sort(function (a, b) {
    return a.timestamp_seconds - b.timestamp_seconds;
  });

  events.forEach(function (event) {
    const type = event.break_type;
    if (event.event_type === "BREAK_START") {
      activeStarts[type].push(event);
      return;
    }
    if (event.event_type !== "BREAK_END" || !activeStarts[type].length) return;

    const start = activeStarts[type].shift();
    let durationSeconds = event.timestamp_seconds - start.timestamp_seconds;
    if (durationSeconds < 0) durationSeconds += 86400;
    usage[type].seconds += Math.max(0, durationSeconds);
    usage[type].count++;
    usage[type].sessions.push({
      start_seconds: start.timestamp_seconds,
      end_seconds: event.timestamp_seconds,
      start_time: start.event_time,
      end_time: event.event_time,
      duration_seconds: Math.max(0, durationSeconds)
    });
  });

  return usage;
}

function eventTimestampSeconds(eventDate, eventTime, schedule) {
  const dateKey = normalizeDateKey(eventDate);
  const timeKey = normalizeSheetTime(eventTime);
  const dateParts = dateKey.split("-").map(function (part) { return safeNumber(part, 0); });
  const timeParts = timeKey.split(":").map(function (part) { return safeNumber(part, 0); });
  let seconds = Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1], timeParts[2] || 0) / 1000;
  const scheduleWindow = getScheduleWindowMinutes(schedule || {});
  if (scheduleWindow.overnight && parseTimeToMinutesSafe(timeKey) < scheduleWindow.start_minutes) seconds += 86400;
  return seconds;
}

function diffMinutes(startTime, endTime) {
  return parseTimeToMinutesSafe(endTime) - parseTimeToMinutesSafe(startTime);
}

function calculateQuarterScore(data) {
  try {
    const year = safeNumber(data.year, new Date().getFullYear());
    const quarter = safeUpper(data.quarter || "Q1");
    const months = getQuarterMonths(year, quarter);
    const staffValues = getValues(SHEETS.STAFF);
    const results = [];

    for (let i = 1; i < staffValues.length; i++) {
      if (safeUpper(staffValues[i][6]) !== "ACTIVE") continue;
      const staff = { staff_id: staffValues[i][0], full_name: staffValues[i][1], login_id: staffValues[i][2], team: staffValues[i][4], role: staffValues[i][5] };
      if (isAdminStaff(staff)) continue;
      const attendanceAvg = averageAttendance(staff.login_id, months);
      const kpiAvg = averageKPI(staff.login_id, months);
      const finalScore = calculateQuarterScoreValue(staff.login_id, months);
      Logger.log("Quarter score calculation: " + JSON.stringify({
        login_id: staff.login_id,
        quarter: quarter + "-" + year,
        months: months,
        attendance_avg: attendanceAvg,
        kpi_avg: kpiAvg,
        final_score: finalScore
      }));
      results.push({ staff: staff, attendance_avg: attendanceAvg, kpi_avg: kpiAvg, final_score: finalScore, final_grade: getGrade(finalScore) });
    }

    results.sort(function (a, b) {
      return safeNumber(b.final_score, 0) - safeNumber(a.final_score, 0) ||
        safeNumber(b.attendance_avg, 0) - safeNumber(a.attendance_avg, 0) ||
        safeNumber(b.kpi_avg, 0) - safeNumber(a.kpi_avg, 0) ||
        clean(a.staff.full_name).localeCompare(clean(b.staff.full_name));
    });
    const sheet = sh(SHEETS.QUARTER);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      sheet.appendRow([makeId("QFS"), quarter + "-" + year, months[0], months[2], r.staff.staff_id, r.staff.login_id, r.staff.full_name, r.staff.team, r.attendance_avg, r.kpi_avg, 40, 60, r.final_score, r.final_grade, i + 1, nowDateTime(), ""]);
    }
    clearSheetCache(SHEETS.QUARTER);
    return { ok: true, message: "Quarter score calculated", quarter: quarter + "-" + year, count: results.length, results: results };
  } catch (err) {
    logInternalError("calculateQuarterScore", err);
    return { ok: false, message: "Quarter score calculation failed. Please try again." };
  }
}

function getQuarterMonths(year, q) {
  q = safeUpper(q);
  if (q === "Q1") return [(year - 1) + "-12", year + "-01", year + "-02"];
  if (q === "Q2") return [year + "-03", year + "-04", year + "-05"];
  if (q === "Q3") return [year + "-06", year + "-07", year + "-08"];
  return [year + "-09", year + "-10", year + "-11"];
}

function getQuarterMonthsForMonth(month) {
  const key = resolveScoreMonth(month);
  const year = safeNumber(key.substring(0, 4), new Date().getFullYear());
  const monthNumber = safeNumber(key.substring(5, 7), 1);
  if (monthNumber === 12) return getQuarterMonths(year + 1, "Q1");
  if (monthNumber <= 2) return getQuarterMonths(year, "Q1");
  if (monthNumber <= 5) return getQuarterMonths(year, "Q2");
  if (monthNumber <= 8) return getQuarterMonths(year, "Q3");
  return getQuarterMonths(year, "Q4");
}

function getQuarterLabelForMonth(month) {
  const key = resolveScoreMonth(month);
  const year = safeNumber(key.substring(0, 4), new Date().getFullYear());
  const monthNumber = safeNumber(key.substring(5, 7), 1);
  if (monthNumber === 12) return "Q1-" + (year + 1);
  if (monthNumber <= 2) return "Q1-" + year;
  if (monthNumber <= 5) return "Q2-" + year;
  if (monthNumber <= 8) return "Q3-" + year;
  return "Q4-" + year;
}

function calculateQuarterScoreValue(loginId, months) {
  const monthKeys = (months || []).map(normalizeMonthKey).filter(Boolean);
  if (!monthKeys.length) return 0;

  let total = 0;
  monthKeys.forEach(function (month) {
    const attendanceScore = calculateMonthlyAttendanceScore(loginId, month);
    const kpi = getOwnKPI(loginId, month);
    const kpiScore = kpi ? safeNumber(kpi.kpi_score_out_of_5, 0) : 0;
    total += calculateFinalScore(attendanceScore, kpiScore);
  });

  const score = round2(total / monthKeys.length);
  Logger.log("Quarter score calculation: " + JSON.stringify({
    login_id: clean(loginId),
    months: monthKeys,
    quarter_score: score
  }));
  return score;
}

function averageAttendance(loginId, months) {
  const monthKeys = months.map(normalizeMonthKey).filter(Boolean);
  let total = 0;
  monthKeys.forEach(function (month) {
    total += calculateMonthlyAttendanceScore(loginId, month);
  });
  return monthKeys.length ? round2(total / monthKeys.length) : 0;
}

function averageKPI(loginId, months) {
  const monthKeys = months.map(normalizeMonthKey).filter(Boolean);
  let total = 0;
  monthKeys.forEach(function (month) {
    const kpi = getOwnKPI(loginId, month);
    total += kpi ? safeNumber(kpi.kpi_score_out_of_5, 0) : 0;
  });
  return monthKeys.length ? round2(total / monthKeys.length) : 0;
}

function getGrade(score) {
  if (score >= 4.5) return "Outstanding";
  if (score >= 4.0) return "Excellent";
  if (score >= 3.5) return "Very Good";
  if (score >= 3.0) return "Meet Expectation";
  if (score >= 2.5) return "Needs Improvement";
  return "Poor";
}

function getLeaderboard(month) {
  const list = getPerformanceDetails(resolveScoreMonth(month)).map(function (row) {
    return {
      login_id: row.login_id,
      full_name: row.full_name,
      team: row.team,
      attendance_score: row.attendance_score,
      kpi_score_out_of_5: safeNumber(row.kpi_score_out_of_5, 0),
      kpi_score: safeNumber(row.kpi_score, 0),
      final_score: row.final_score,
      monthly_final_score: row.monthly_final_score,
      quarter_score: row.quarter_score,
      ranking_score: row.ranking_score,
      rank: row.rank,
      current_rank: row.current_rank || row.rank,
      grade: row.grade,
      kpi_status: row.kpi_status
    };
  });
  return list;
}

/***** TELEGRAM ASYNC OPTIMIZATION *****/

function queueTelegramAttendance(staff, schedule, eventType, breakType, ip) {
  try {
    const settings = getSettings();
    if (safeUpper(settings.TG_NOTIFY_ENABLED) !== "YES") return;
    const payload = { id: makeId("TGQ"), created_at: nowDateTime(), staff: staff, schedule: schedule, eventType: eventType, breakType: breakType, ip: ip };
    const lock = LockService.getScriptLock();
    lock.waitLock(3000);
    try {
      const props = PropertiesService.getScriptProperties();
      const queue = JSON.parse(props.getProperty(TG_QUEUE_PROPERTY) || "[]");
      queue.push(payload);
      props.setProperty(TG_QUEUE_PROPERTY, JSON.stringify(queue));
      ensureTelegramTrigger();
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    logInternalError("queueTelegramAttendance", err);
    sendTelegramAttendance(staff, schedule, eventType, breakType, ip);
  }
}

function ensureTelegramTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TG_TRIGGER_HANDLER) return;
  }
  ScriptApp.newTrigger(TG_TRIGGER_HANDLER).timeBased().after(1).create();
}

function processTelegramQueue() {
  resetRequestCache();
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    const props = PropertiesService.getScriptProperties();
    const queue = JSON.parse(props.getProperty(TG_QUEUE_PROPERTY) || "[]");
    if (!queue.length) {
      props.deleteProperty(TG_QUEUE_PROPERTY);
      cleanupTelegramTriggers();
      return;
    }
    props.deleteProperty(TG_QUEUE_PROPERTY);
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      sendTelegramAttendance(item.staff, item.schedule, item.eventType, item.breakType, item.ip);
    }
    cleanupTelegramTriggers();
  } catch (err) {
    logInternalError("processTelegramQueue", err);
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {
      logInternalError("processTelegramQueue.releaseLock", err);
    }
  }
}

function sendTelegramAbsenceAlert(row) {
  const settings = getSettings();
  if (safeUpper(settings.TG_NOTIFY_ENABLED) !== "YES") return;

  const loginId = clean(row && row.login_id);
  const staffId = clean(row && row.staff_id);
  const scheduleDate = normalizeDateKey(row && row.schedule_date);
  const shiftCode = safeUpper(row && row.shift_code);
  if (!scheduleDate || (!loginId && !staffId) || !shiftCode) return;

  const marker = ["ABSENT_ALERT", scheduleDate, loginId || staffId, shiftCode].join("|");
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(3000);
    if (hasTelegramAbsenceAlert(marker)) return;

    const token = clean(settings.TG_BOT_TOKEN);
    const chatId = getTelegramChatIdForStaff(settings, row);
    if (!token || !chatId) return;

    const text = "ABSENT ALERT: " + clean(row.full_name || loginId || staffId) +
      " has not checked in today. Shift: " + shiftCode + " " +
      formatShiftTime(row.start_time) + " - " + formatShiftTime(row.end_time) + ".";

    try {
      const url = "https://api.telegram.org/bot" + token + "/sendMessage";
      const res = UrlFetchApp.fetch(url, { method: "post", muteHttpExceptions: true, payload: { chat_id: chatId, text: text } });
      sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ABSENCE", staffId, loginId, clean(row.full_name), "ABSENT_ALERT", text, "SENT", res.getContentText(), marker]);
      clearSheetCache(SHEETS.TG);
    } catch (err) {
      logInternalError("sendTelegramAbsenceAlert", err);
      sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ABSENCE", staffId, loginId, clean(row.full_name), "ABSENT_ALERT", text, "FAILED", String(err), marker]);
      clearSheetCache(SHEETS.TG);
    }
  } catch (err) {
    logInternalError("sendTelegramAbsenceAlert.lock", err);
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {
      logInternalError("sendTelegramAbsenceAlert.releaseLock", err);
    }
  }
}

function hasTelegramAbsenceAlert(marker) {
  const values = getValues(SHEETS.TG);
  const headerMap = buildHeaderMap(values[0] || []);
  for (let i = 1; i < values.length; i++) {
    const notes = clean(valueByHeader(values[i], headerMap, ["notes"], null));
    const eventType = safeUpper(valueByHeader(values[i], headerMap, ["event_type", "action"], null));
    if (notes === marker && eventType === "ABSENT_ALERT") return true;
  }
  return false;
}

function cleanupTelegramTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TG_TRIGGER_HANDLER) ScriptApp.deleteTrigger(triggers[i]);
  }
}

function sendTelegramAttendance(staff, schedule, eventType, breakType, ip) {
  const settings = getSettings();
  if (safeUpper(settings.TG_NOTIFY_ENABLED) !== "YES") return;

  const token = clean(settings.TG_BOT_TOKEN);
  const chatId = getTelegramChatIdForStaff(settings, staff);
  if (!token || !chatId) return;

  let text =
    "Staff attendance update\n\n" +
    "Event: " + eventType + (breakType ? " / " + breakType : "") + "\n" +
    "Name: " + staff.full_name + "\n" +
    "Team: " + staff.team + "\n" +
    "Date: " + todayDate() + "\n" +
    "Shift: " + schedule.shift_code + "\n" +
    "Shift Time: " + formatShiftTime(schedule.start_time) + " - " + formatShiftTime(schedule.end_time) + "\n" +
    "Time: " + nowDateTime() + "\n" +
    "Office IP: " + ip;

  if (eventType === "BREAK_START") {
    text =
      "Break Started\n" +
      "Name: " + staff.full_name + "\n" +
      "Break: " + getTelegramBreakName(breakType) + "\n" +
      "Time: " + nowDateTime();
  }

  if (eventType === "BREAK_END") {
    const usage = getTelegramBreakUsage(staff, normalizeDateKey(schedule.schedule_date || todayDate()), breakType, schedule);
    text =
      "Break Ended\n" +
      "Name: " + staff.full_name + "\n" +
      "Break: " + getTelegramBreakName(breakType) + "\n" +
      "Back Time: " + nowDateTime() + "\n" +
      "Used: " + usage.minutes + " min\n" +
      "Status: " + (usage.overused ? "Overuse" : "Normal") +
      (usage.overused ? "\nOveruse: " + usage.overuse_minutes + " min" : "");
  }

  if (eventType === "CHECK_OUT") {
    text =
      "Check Out\n" +
      "Name: " + staff.full_name + "\n" +
      "Time: " + nowDateTime() + "\n" +
      "Status: " + getTelegramCheckoutStatus(staff.login_id, normalizeDateKey(schedule.schedule_date || todayDate()));
  }

  try {
    const url = "https://api.telegram.org/bot" + token + "/sendMessage";
    const res = UrlFetchApp.fetch(url, { method: "post", muteHttpExceptions: true, payload: { chat_id: chatId, text: text } });
    sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ATTENDANCE", staff.staff_id, staff.login_id, staff.full_name, eventType, text, "SENT", res.getContentText(), "chat_id=" + chatId]);
    clearSheetCache(SHEETS.TG);
  } catch (err) {
    logInternalError("sendTelegramAttendance", err);
    sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ATTENDANCE", staff.staff_id, staff.login_id, staff.full_name, eventType, text, "FAILED", String(err), "chat_id=" + chatId]);
    clearSheetCache(SHEETS.TG);
  }
}

function getTelegramBreakName(breakType) {
  const type = normalizeBreakType(breakType);
  if (type === "PRAYER_BREAK") return "Prayer Break";
  if (type === "BIO_BREAK") return "Bio Break";
  return "Break";
}

function getTelegramBreakUsage(staff, dateStr, breakType, schedule) {
  const evaluation = evaluateBreakUsage(staff, dateStr, schedule || {}, getSettings());
  const type = normalizeBreakType(breakType);
  const sessions = evaluation.sessions[type] ? evaluation.sessions[type].sessions : [];
  const session = sessions.length ? sessions[sessions.length - 1] : null;
  if (!session) return { minutes: 0, overused: false, overuse_minutes: 0 };

  const detail = (evaluation.break_overuse_details || []).filter(function (item) {
    return item.break_type === type && item.start_time === session.start_time && item.end_time === session.end_time;
  })[0];
  return {
    minutes: Math.floor(session.duration_seconds / 60),
    overused: Boolean(detail),
    overuse_minutes: detail ? detail.overuse_minutes : 0
  };
}

function getTelegramCheckoutStatus(loginId, dateStr) {
  const rows = listDailyScoreRows(normalizeDateKey(dateStr).substring(0, 7), 250);
  const targetLogin = clean(loginId).toLowerCase();
  const targetDate = normalizeDateKey(dateStr);
  for (let i = 0; i < rows.length; i++) {
    if (clean(rows[i].login_id).toLowerCase() === targetLogin && normalizeDateKey(rows[i].score_date) === targetDate) {
      return clean(rows[i].status) || "Completed";
    }
  }
  return "Completed";
}

function getTelegramChatIdForStaff(settings, staff) {
  const teamKey = safeUpper(staff && staff.team).replace(/[^A-Z0-9]/g, "_");
  const teamChatId = clean(settings["TG_GROUP_CHAT_ID_" + teamKey]);
  return teamChatId || clean(settings.TG_GROUP_CHAT_ID);
}
