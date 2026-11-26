import { coverage, key, totals, weekday, weekdays } from "./roster-model.js";
import { coverageReport } from "./roster-policy.js";

export function exportName(snapshot, ext, group = "") {
  const title = snapshot.groups.find(item => item.id === group)?.name || "Unassigned";
  const suffix = group ? "-" + (title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || group) : "";
  return "SYNTHETIC-" + snapshot.team + "-" + snapshot.month + "-r" + snapshot.revision + suffix + "." + ext;
}
const safeCsv = value => {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function rosterCsv(snapshot, group = "") {
  const rows = [["schedule_month", "schedule_date", "staff_id", "login_id", "full_name", "team",
    "shift_code", "start_time", "end_time", "status", "notes"]];
  for (const person of snapshot.people.filter(p => !group || p.group === group)) {
    for (const date of snapshot.dates) {
      const shift = snapshot.catalog.find(s => s.id === snapshot.cells[key(person.id, date)]);
      if (!shift) continue;
      rows.push([snapshot.month, date, person.id, person.login, person.name, snapshot.team, shift.id,
        shift.start, shift.end, shift.kind === "work" ? "WORKING" : shift.id, "SYNTHETIC PROTOTYPE - DO NOT UPLOAD"]);
    }
  }
  return rows.map(row => row.map(safeCsv).join(",")).join("\r\n") + "\r\n";
}

export async function workbookBytes(ExcelJS, snapshot, group = "") {
  const book = new ExcelJS.Workbook();
  book.title = "Synthetic roster prototype";
  book.creator = "Staff Portal V2";
  const fill = argb => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const used = new Set(["legend", "planning summary"]);
  function sheetName(name) {
    const base = name.replace(/[\\/*?:[\]]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 25) || "Roster";
    let title = base, n = 2;
    while (used.has(title.toLowerCase())) title = base + " " + n++;
    used.add(title.toLowerCase());
    return title;
  }
  function addSheet(name, people) {
    const sheet = book.addWorksheet(sheetName(name), { views: [{ state: "frozen", xSplit: 3, ySplit: 3 }] });
    sheet.addRow(["SYNTHETIC PROTOTYPE - DO NOT UPLOAD", snapshot.month, "Draft revision " + snapshot.revision]);
    sheet.addRow(["Staff", "Staff ID", "Group", ...snapshot.dates.map(date => new Date(date + "T00:00:00Z")), "Working", "OFF", "Leave"]);
    sheet.addRow(["", "", "Weekday", ...snapshot.dates.map(date => weekdays[weekday(date)])]);
    sheet.getColumn(1).width = 26;
    sheet.getColumn(2).width = 14;
    sheet.getColumn(3).width = 20;
    snapshot.dates.forEach((_, i) => {
      sheet.getColumn(i + 4).width = 8;
      sheet.getRow(2).getCell(i + 4).numFmt = "mmm d";
    });
    for (const rowNumber of [1, 2, 3]) {
      sheet.getRow(rowNumber).eachCell(cell => { cell.font = { bold: true, color: { argb: "FFE5F4FF" } }; cell.fill = fill("FF19304A"); });
    }
    const groupNames = new Map(snapshot.groups.map(item => [item.id, item.name]));
    for (const person of people) {
      const values = snapshot.dates.map(date => snapshot.cells[key(person.id, date)] || "");
      const count = totals(snapshot.catalog, values);
      const row = sheet.addRow([person.name, person.id, groupNames.get(person.group) || "Unassigned", ...values, count.work, count.off, count.leave]);
      values.forEach((value, i) => {
        const shift = snapshot.catalog.find(item => item.id === value);
        if (shift) row.getCell(i + 4).fill = fill("FF" + shift.color.slice(1).toUpperCase());
      });
    }
    sheet.addRow(["Daily coverage"]);
    const counts = coverage(people, snapshot.dates, snapshot.cells);
    for (const shift of snapshot.catalog) sheet.addRow([shift.id, "", "", ...counts.map(count => count[shift.id] || 0)]);
  }
  if (!group) addSheet("Combined roster", snapshot.people);
  for (const g of [...snapshot.groups, { id: "unassigned", name: "Unassigned" }]) {
    if (!group || group === g.id) addSheet(g.name, snapshot.people.filter(p => p.group === g.id));
  }
  const legend = book.addWorksheet("Legend");
  legend.columns = [{ width: 44 }, { width: 14 }, { width: 14 }, { width: 14 }];
  legend.addRow(["SYNTHETIC PROTOTYPE DATA", snapshot.team, snapshot.month, "r" + snapshot.revision]);
  legend.addRow(["Shift", "Kind", "Start", "End"]);
  for (const shift of snapshot.catalog) {
    const row = legend.addRow([shift.id, shift.kind, shift.start, shift.end]);
    row.getCell(1).fill = fill("FF" + shift.color.slice(1).toUpperCase());
  }
  if (snapshot.planning) {
    const { planning } = snapshot;
    const sheet = book.addWorksheet("Planning summary", { views: [{ state: "frozen", ySplit: 2 }] });
    const report = coverageReport({ ...snapshot, draft: planning, leave: planning.leave }, snapshot.cells);
    const working = snapshot.catalog.filter(shift => shift.kind === "work");
    sheet.addRow(["SYNTHETIC PROTOTYPE DATA", snapshot.month, "Draft revision " + snapshot.revision]);
    sheet.addRow(["Group", "Date", ...working.map(s => s.id), "Work", "OFF", "AL", "SL", "UL", "OFF capacity", "Shortfall"]);
    sheet.columns.forEach((column, i) => { column.width = i === 0 ? 27 : i === 1 ? 16 : 13; });
    const daily = report.daily.filter(row => !group || row.group === group);
    if (!group) {
      for (const date of snapshot.dates) {
        const rows = daily.filter(row => row.date === date);
        const sum = field => rows.reduce((n, row) => n + row[field], 0);
        daily.push({ name: "Combined", date, working: sum("working"), off: sum("off"), cap: sum("cap"), shortfall: sum("shortfall"),
          counts: Object.fromEntries(snapshot.catalog.map(s => [s.id, rows.reduce((n, row) => n + (row.counts[s.id] || 0), 0)])) });
      }
    }
    for (const row of daily) sheet.addRow([row.name, row.date, ...working.map(s => row.counts[s.id] || 0),
      row.working, row.off, row.counts.AL || 0, row.counts.SL || 0, row.counts.UL || 0, row.cap, row.shortfall]);
    sheet.addRow([]);
    sheet.addRow(["Staff", "Staff ID", "Work", "OFF", "AL", "SL", "UL", "Paired weeks", "Max work streak", "Transitions", "Preferences"]);
    for (const person of report.staff.filter(p => !group || p.group === group)) sheet.addRow([person.name, person.id, person.work,
      person.off, person.mix.AL || 0, person.mix.SL || 0, person.mix.UL || 0, person.compliant + "/" + person.weeks,
      person.maxStreak, person.transitions, person.preferred + "/" + person.opportunities]);
  }
  return book.xlsx.writeBuffer();
}

let excel;
const loadExcel = () => excel ||= new Promise((resolve, reject) => {
  const script = document.createElement("script");
  script.src = new URL("../vendor/exceljs-4.4.0/dist/exceljs.min.js", import.meta.url);
  script.onload = () => globalThis.ExcelJS ? resolve(globalThis.ExcelJS) : reject(new Error("Excel library did not initialize"));
  script.onerror = () => reject(new Error("Excel library could not load"));
  document.head.append(script);
}).catch(error => { excel = null; throw error; });

export async function downloadRoster(snapshot, format, group = "") {
  const bytes = format === "csv" ? rosterCsv(snapshot, group) : await workbookBytes(await loadExcel(), snapshot, group);
  const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportName(snapshot, format, group);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
