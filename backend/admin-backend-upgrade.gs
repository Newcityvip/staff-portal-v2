/***** STAFF PORTAL V2 - ADMIN DASHBOARD BACKEND UPGRADE *****
Add these switch cases inside doPost(e), before default:

  case "import_schedule":
  case "upload_schedule":
    result = importSchedule(body);
    break;

  case "save_ip_allowlist":
    result = saveIpAllowlist(body);
    break;

Then replace the existing getAdminDashboard(data) function with the one below.
This file is additive and uses the same helpers/constants from the existing Code.gs.
*****/

function getAdminDashboard(data) {
  const ip = clean(data.ip);
  if (!isAllowedIP(ip)) return { ok: false, message: "IP not allowed", ip: ip };

  const today = todayDate();
  const month = clean(data.month) || monthNow();
  const staff = getAdminStaffRows(month);
  const schedules = getAdminScheduleRows(month);
  const kpis = getAdminKpiRows(month);
  const attendanceBoard = getAdminAttendanceBoard(today);
  const breakBoard = getAdminBreakBoard(today);
  const leaderboard = getLeaderboard(month);

  return {
    ok: true,
    today: today,
    staff_count: getActiveStaffCount(),
    today_summary: getTodaySummary(today),
    staff: staff,
    schedules: schedules,
    kpis: kpis,
    attendanceBoard: attendanceBoard,
    breakBoard: breakBoard,
    topPerformers: leaderboard.slice(0, 10),
    worstPerformers: leaderboard.slice().reverse().slice(0, 10),
    leaderboard: leaderboard,
    dailyLogs: getAdminDailyLogs(80),
    telegramLogs: getAdminTelegramLogs(80),
    auditLogs: getAdminAuditLogs(80),
    ipAllowlist: getAdminIpAllowlist()
  };
}

function importSchedule(data) {
  const ip = clean(data.ip);
  if (!isAllowedIP(ip)) return { ok: false, message: "IP not allowed", ip: ip };

  const adminLoginId = clean(data.admin_login_id || data.login_id || "Admin");
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) return { ok: false, message: "No schedule rows found in CSV" };

  const staffRows = getValues(SHEETS.STAFF);
  const staffByLogin = {};
  for (let i = 1; i < staffRows.length; i++) {
    staffByLogin[clean(staffRows[i][2]).toUpperCase()] = {
      staff_id: staffRows[i][0],
      full_name: staffRows[i][1],
      login_id: staffRows[i][2],
      team: staffRows[i][4]
    };
  }

  const sheet = sh(SHEETS.SCHEDULE);
  const existing = sheet.getDataRange().getValues();
  const existingMap = {};
  for (let i = 1; i < existing.length; i++) {
    existingMap[normalizeDateKey(existing[i][2]) + "|" + clean(existing[i][4]).toUpperCase()] = i + 1;
  }

  let inserted = 0;
  let updated = 0;
  const skipped = [];

  rows.forEach(function (input, index) {
    const row = normalizeScheduleImportRow(input);
    if (!row.login_id || !row.schedule_date) {
      skipped.push({ row: index + 2, reason: "Missing login_id or schedule_date" });
      return;
    }

    const staff = staffByLogin[row.login_id.toUpperCase()];
    if (!staff) {
      skipped.push({ row: index + 2, reason: "Staff not found: " + row.login_id });
      return;
    }

    const scheduleMonth = row.schedule_month || normalizeDateKey(row.schedule_date).substring(0, 7);
    const record = [
      row.schedule_id || makeId("SCH"),
      scheduleMonth,
      normalizeDateKey(row.schedule_date),
      row.staff_id || staff.staff_id,
      staff.login_id,
      row.full_name || staff.full_name,
      row.team || staff.team,
      safeUpper(row.shift_code || "GENERAL"),
      normalizeSheetTime(row.start_time || "09:00:00"),
      normalizeSheetTime(row.end_time || "18:00:00"),
      safeUpper(row.status || "WORKING")
    ];

    const key = record[2] + "|" + clean(record[4]).toUpperCase();
    if (existingMap[key]) {
      sheet.getRange(existingMap[key], 1, 1, record.length).setValues([record]);
      updated++;
    } else {
      sheet.appendRow(record);
      inserted++;
    }
  });

  clearSheetCache(SHEETS.SCHEDULE);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "IMPORT_SCHEDULE", "SCHEDULE", "", "", JSON.stringify({ inserted: inserted, updated: updated, skipped: skipped.length }), ip, clean(data.fileName));

  return {
    ok: true,
    message: "Schedule import complete",
    inserted: inserted,
    updated: updated,
    skipped: skipped
  };
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
    status: out.status || out.day_status
  };
}

function saveIpAllowlist(data) {
  const ip = clean(data.ip);
  if (!isAllowedIP(ip)) return { ok: false, message: "IP not allowed", ip: ip };

  const adminLoginId = clean(data.admin_login_id || data.login_id || "Admin");
  const ips = Array.isArray(data.ips) ? data.ips.map(clean).filter(Boolean) : [];
  if (!ips.length) return { ok: false, message: "No IP addresses provided" };

  const sheet = sh(SHEETS.IP);
  const values = sheet.getDataRange().getValues();
  const existing = {};
  for (let i = 1; i < values.length; i++) {
    existing[clean(values[i][1])] = i + 1;
  }

  ips.forEach(function (allowedIp) {
    const row = [
      makeId("IP"),
      allowedIp,
      "Admin added",
      "ACTIVE",
      adminLoginId,
      nowDateTime(),
      ""
    ];

    if (existing[allowedIp]) {
      sheet.getRange(existing[allowedIp], 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  });

  clearSheetCache(SHEETS.IP);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "SAVE_IP_ALLOWLIST", "SECURITY", "", "", ips.join(","), ip, "");

  return { ok: true, message: "IP allowlist saved", count: ips.length, ipAllowlist: getAdminIpAllowlist() };
}

function getAdminStaffRows(month) {
  const staffValues = getValues(SHEETS.STAFF);
  const kpiValues = getValues(SHEETS.KPI);
  const kpiByLogin = {};

  for (let i = 1; i < kpiValues.length; i++) {
    if (clean(kpiValues[i][1]) === clean(month)) {
      kpiByLogin[clean(kpiValues[i][3]).toUpperCase()] = safeNumber(kpiValues[i][14], 0);
    }
  }

  const rows = [];
  for (let i = 1; i < staffValues.length; i++) {
    rows.push({
      staff_id: staffValues[i][0],
      full_name: staffValues[i][1],
      login_id: staffValues[i][2],
      email: staffValues[i][3],
      team: staffValues[i][4],
      role: staffValues[i][5],
      status: staffValues[i][6],
      kpi_score_out_of_5: kpiByLogin[clean(staffValues[i][2]).toUpperCase()] || ""
    });
  }
  return rows;
}

function getAdminScheduleRows(month) {
  const values = getValues(SHEETS.SCHEDULE);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (month && clean(values[i][1]) !== clean(month)) continue;
    rows.push({
      schedule_id: values[i][0],
      schedule_month: values[i][1],
      schedule_date: normalizeDateKey(values[i][2]),
      staff_id: values[i][3],
      login_id: values[i][4],
      full_name: values[i][5],
      team: values[i][6],
      shift_code: values[i][7],
      start_time: normalizeSheetTime(values[i][8]),
      end_time: normalizeSheetTime(values[i][9]),
      status: values[i][10]
    });
  }
  return rows.slice(0, 200);
}

function getAdminKpiRows(month) {
  const values = getValues(SHEETS.KPI);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (month && clean(values[i][1]) !== clean(month)) continue;
    rows.push({
      kpi_id: values[i][0],
      kpi_month: values[i][1],
      staff_id: values[i][2],
      login_id: values[i][3],
      full_name: values[i][4],
      team: values[i][5],
      kpi_score_out_of_5: values[i][14],
      updated_by: values[i][15],
      updated_at: values[i][17]
    });
  }
  return rows;
}

function getAdminAttendanceBoard(dateStr) {
  const values = getValues(SHEETS.EVENTS);
  const rowsByLogin = {};
  const targetDate = normalizeDateKey(dateStr);

  for (let i = 1; i < values.length; i++) {
    if (normalizeDateKey(values[i][1]) !== targetDate) continue;
    const loginId = clean(values[i][4]);
    if (!rowsByLogin[loginId]) {
      rowsByLogin[loginId] = {
        login_id: loginId,
        full_name: values[i][5],
        team: "",
        status: "Online",
        check_in: "",
        ip: values[i][9]
      };
    }
    if (safeUpper(values[i][6]) === "CHECK_IN") rowsByLogin[loginId].check_in = normalizeSheetTime(values[i][2]);
    if (safeUpper(values[i][6]) === "CHECK_OUT") rowsByLogin[loginId].status = "Checked out";
  }

  return Object.keys(rowsByLogin).map(function (key) { return rowsByLogin[key]; });
}

function getAdminBreakBoard(dateStr) {
  const values = getValues(SHEETS.EVENTS);
  const rowsByLogin = {};
  const targetDate = normalizeDateKey(dateStr);

  for (let i = 1; i < values.length; i++) {
    if (normalizeDateKey(values[i][1]) !== targetDate) continue;
    const loginId = clean(values[i][4]);
    const eventType = safeUpper(values[i][6]);
    if (eventType === "BREAK_START") {
      rowsByLogin[loginId] = {
        login_id: loginId,
        full_name: values[i][5],
        breakStart: normalizeSheetTime(values[i][2]),
        break_type: values[i][7],
        status: values[i][7] || "Break"
      };
    }
    if (eventType === "BREAK_END") delete rowsByLogin[loginId];
  }

  return Object.keys(rowsByLogin).map(function (key) { return rowsByLogin[key]; });
}

function getAdminDailyLogs(limit) {
  const values = getValues(SHEETS.EVENTS);
  return tailRows(values, limit).map(function (row) {
    return {
      created_at: normalizeDateKey(row[1]) + " " + normalizeSheetTime(row[2]),
      full_name: row[5],
      login_id: row[4],
      event_type: row[6],
      status: row[7] || row[6],
      ip: row[9]
    };
  });
}

function getAdminTelegramLogs(limit) {
  const values = getValues(SHEETS.TG);
  return tailRows(values, limit).map(function (row) {
    return {
      created_at: row[1],
      target: row[4] || row[5],
      event_type: row[6],
      message: row[7],
      status: row[8]
    };
  });
}

function getAdminAuditLogs(limit) {
  const values = getValues(SHEETS.AUDIT);
  return tailRows(values, limit).map(function (row) {
    return {
      created_at: row[1],
      actor_name: row[4],
      action: row[5],
      ip: row[10],
      result: row[11] || "OK"
    };
  });
}

function getAdminIpAllowlist() {
  const values = getValues(SHEETS.IP);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (!clean(values[i][1])) continue;
    rows.push({
      ip_id: values[i][0],
      ip_address: values[i][1],
      label: values[i][2],
      status: values[i][3]
    });
  }
  return rows;
}

function tailRows(values, limit) {
  const rows = [];
  for (let i = values.length - 1; i >= 1 && rows.length < limit; i--) {
    rows.push(values[i]);
  }
  return rows;
}
