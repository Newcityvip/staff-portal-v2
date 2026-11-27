import { assignCell, assignmentSource, assignmentsFromGeneration, clearRosterAssignments, contextFor, coverage,
  createHistory, datesFor, draftFor, importedLeave, isManualLock, key, overrideApprovedLeave, previousPattern,
  resetRosterScope, restore, save, snapshot, totals, transferMany, weekday, weekdays } from "./roster-model.js";
import { adjustmentTrial, recoveryValidation, staffingPreflight, validate } from "./roster-generator.js";
import { downloadRoster } from "./roster-export.js";
import { asCoverage, coverageKey, coverageReport, priorities, validCoverage } from "./roster-policy.js";
import { defaultDemand, demandKey, pairNames, validDemand, workloads } from "./roster-weekly.js";
import { createDiagnosticBundle, diagnosticMaxBytes, readDiagnosticBundle } from "./roster-diagnostic-bundle.js";

const $ = id => document.getElementById(id);
const sourceMode = new URLSearchParams(location.search).get("source");
const fixtureMode = sourceMode === "fixture", liveMode = sourceMode === "live";
const loopback = location.protocol === "http:" && location.hostname === "127.0.0.1";
const fixtureTools = (fixtureMode && loopback || liveMode && window.parent !== window && (loopback || location.protocol === "https:")) ?
  await import("./roster-source.js").catch(() => null) : null;
let fixture = null;
if (fixtureTools && fixtureMode) {
  try { fixture = JSON.parse(sessionStorage.getItem(fixtureTools.fixtureHandoffKey)); } catch {}
}
if (fixtureTools && liveMode) {
  fixture = await new Promise(resolve => {
    const timer = setTimeout(() => finish(null), 5000);
    function receive(event) {
      if (event.origin === location.origin && event.source === window.parent && event.data?.type === "roster-editor-model") finish(event.data.handoff);
    }
    function finish(value) {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(value);
    }
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "roster-editor-ready" }, location.origin);
  });
}
if ((fixtureMode || liveMode) && (!fixture || fixture.model?.leaveOrigin !== "published")) {
  if (liveMode && window.parent !== window) {
    $("roster-mode").textContent = "Live editor unavailable. Return to source review.";
  } else location.replace("admin-roster-source.html" + (liveMode ? "?source=live" : ""));
  await new Promise(() => {});
}
const initial = fixture || restore(localStorage);
const loaded = structuredClone(initial.model);
const history = createHistory(initial.model);
let team = initial.team, month = initial.month, group = "", preview = false;
let saved = JSON.stringify(initial), current, clipboard = [], selected = new Set(), anchor = "", worker;
let showReport = false;
if (fixture) {
  $("roster-mode").textContent = (liveMode ? "Live read-only" : "Fixture source") + " / Publishing disabled";
  $("team").disabled = $("month").disabled = true;
  $("roster-mode").append(document.createTextNode(" / "));
  const back = document.createElement("a");
  back.href = "admin-roster-source.html?" + new URLSearchParams({ team, month });
  if (fixtureMode && fixture.publishFixture) back.href += "&publish=fixture";
  back.textContent = "Review source";
  if (liveMode) back.onclick = event => {
    event.preventDefault();
    window.parent.postMessage({ type: "roster-editor-back" }, location.origin);
  };
  $("roster-mode").append(back);
  $("override-leave").textContent = "Override Published Leave";
}
const dirty = () => JSON.stringify({ model: history.current, team, month }) !== saved;
const notify = text => { $("notice").textContent = text; };
const make = (tag, text = "", attrs = {}) => {
  const node = document.createElement(tag);
  node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
};
const button = (label, action, attrs) => {
  const result = make("button", label, { type: "button", ...attrs });
  result.addEventListener("click", action);
  return result;
};
const choose = (pairs, value) => {
  const result = make("select");
  for (const [id, name] of pairs) result.add(new Option(name, id));
  result.value = value;
  return result;
};
const input = (type, value, attrs) => make("input", "", { type, value, ...attrs });
const row = (...children) => {
  const result = make("div", "", { class: "form-row" });
  result.append(...children);
  return result;
};
const label = (name, control) => {
  const result = make("label", name);
  result.append(control);
  return result;
};
const fill = (id, pairs, value) => {
  const select = $(id);
  select.replaceChildren(...pairs.map(([key, label]) => new Option(label, key)));
  select.value = pairs.some(([id]) => id === value) ? value : pairs[0]?.[0] || "";
};
const groupPairs = context => [...context.groups.map(g => [g.id, g.name]), ["unassigned", "Unassigned"]];
const exportRecord = () => $("source").value === "draft" ? snapshot(current) : history.current.snapshots[Number($("source").value)];
const updateExportGroups = () => {
  const source = $("source").value;
  const record = source === "draft" ? current : history.current.snapshots[Number(source)];
  fill("export-group", [["", "Combined export"], ...groupPairs(record)], $("export-group").value);
};
const workShifts = () => current.catalog.filter(s => s.kind === "work");
const timeLabel = shift => shift.kind === "work" ? shift.start + " - " + shift.end + (shift.end <= shift.start ? " (+1)" : "") : shift.kind === "off" ? "Day off" : "Leave";
const range = (value, low, high) => Number.isInteger(Number(value)) && value !== "" && +value >= low && +value <= high;

function editDraft(edit) {
  history.change(model => {
    const draft = draftFor(model, team, month);
    const before = JSON.stringify(draft);
    edit(draft);
    if (before !== JSON.stringify(draft)) draft.revision++;
  });
  render();
}
function updateSelection() {
  for (const cell of $("matrix").querySelectorAll(".cell")) cell.setAttribute("aria-pressed", selected.has(cell.dataset.key));
  $("selection").textContent = selected.size ? selected.size + " selected" : "No selection";
  for (const id of ["apply", "copy", "clear", "lock"]) $(id).disabled = preview || !selected.size;
  $("paste").disabled = preview || !selected.size || !clipboard.length;
  $("override-leave").disabled = preview || ![...selected].some(k => importedLeave(current, k));
}
function selectCell(k, event) {
  if (event.shiftKey && anchor) {
    const [startId, startDate] = anchor.split("|"), [endId, endDate] = k.split("|");
    const people = [...$("matrix").querySelectorAll("[data-person]")].map(element => element.dataset.person);
    const [lo, hi] = [people.indexOf(startId), people.indexOf(endId)].sort((a, b) => a - b);
    if (lo >= 0) {
      selected = new Set();
      for (const id of people.slice(lo, hi + 1)) for (const date of current.dates) {
        if ((date >= startDate && date <= endDate) || (date >= endDate && date <= startDate)) selected.add(key(id, date));
      }
    }
  } else if ($("multi").checked || event.ctrlKey || event.metaKey) {
    if (selected.has(k)) selected.delete(k); else selected.add(k);
    anchor = k;
  } else {
    selected = new Set([k]);
    anchor = k;
  }
  updateSelection();
}

function renderGrid(report) {
  const table = $("matrix");
  const scroll = $("scroll"), top = scroll.scrollTop, left = scroll.scrollLeft;
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  head.append(make("th", "Staff member", { class: "name", scope: "col" }));
  for (const date of current.dates) {
    const day = weekday(date);
    const cell = make("th", date.slice(-2), { scope: "col", class: day === 0 || day === 6 ? "weekend" : "" });
    cell.append(make("small", weekdays[day]));
    head.append(cell);
  }
  head.append(make("th", "Work / OFF / Leave", { scope: "col", class: "totals" }));
  function addCoverage(body, people, prefix, groupId = "") {
    const counts = coverage(people, current.dates, current.draft.cells);
    for (const shift of [...workShifts(), { id: "_working", label: "Working" }, { id: "OFF" }, { id: "AL" }, { id: "SL" }, { id: "UL" }]) {
      const tr = body.insertRow();
      tr.className = "coverage";
      tr.append(make("th", prefix + (shift.label || shift.id), { scope: "row", class: "name" }));
      counts.forEach((day, index) => {
        const td = tr.insertCell();
        const date = current.dates[index];
        const stats = report.daily.filter(row => row.date === date && (groupId ? row.group === groupId : true));
        const actual = shift.id === "_working" ? stats.reduce((sum, row) => sum + row.working, 0) : day[shift.id] || 0;
        td.textContent = actual;
        const rules = stats.flatMap(row => row.shifts.filter(s => s.id === shift.id));
        const min = rules.reduce((n, s) => n + s.min, 0), target = rules.reduce((n, s) => n + s.target, 0);
        const max = groupId ? rules[0]?.max : null;
        const dailyCap = stats.reduce((sum, row) => sum + row.cap, 0);
        const core = actual < min || max != null && actual > max;
        td.dataset.shortfall = core || shift.id === "OFF" && stats.some(row => row.off > (row.demand.maxOff ?? Infinity) || row.shortfall) ||
          shift.id === "_working" && stats.some(row => row.shortfall);
        if (groupId) td.dataset.coverage = [groupId, date, shift.id].join("|");
        td.title = date + " / " + shift.id + ": " + actual + " assigned, " + min + " minimum, " + target + " target, " +
          stats.reduce((n, s) => n + s.available, 0) + " available" + (max == null ? "" : ", " + max + " maximum");
        if (shift.id === "OFF") td.title = date + ": " + actual + "/" + dailyCap + " usable regular OFF slots";
        if (shift.id === "_working") td.title = date + ": " + actual + " working, " + stats.reduce((n, d) => n + d.shortfall, 0) + " shortfall";
      });
      tr.insertCell().textContent = shift.id === "_working"
        ? report.daily.filter(d => !groupId || d.group === groupId).reduce((sum, d) => sum + d.working, 0)
        : counts.reduce((sum, day) => sum + (day[shift.id] || 0), 0);
    }
  }
  for (const [id, name] of groupPairs(current)) {
    if (!preview && group && group !== id) continue;
    const people = current.people.filter(person => person.group === id);
    const body = table.createTBody(), heading = body.insertRow();
    heading.append(make("th", name + " / " + people.length, { class: "group-label", scope: "rowgroup" }));
    heading.append(make("td", "", { class: "group-band", colspan: current.dates.length + 1 }));
    for (const person of people) {
      const tr = body.insertRow();
      tr.dataset.person = person.id;
      const nameCell = make("th", "", { scope: "row", class: "name" });
      const locked = Boolean(current.draft.staffLocks[person.id]);
      tr.dataset.staffLocked = locked;
      if (!preview) nameCell.append(button(locked ? "Locked" : "Lock", () =>
        editDraft(d => { if (d.staffLocks[person.id]) delete d.staffLocks[person.id]; else d.staffLocks[person.id] = true; }),
      { class: "row-lock", "aria-label": "Toggle staff lock for " + person.name, "aria-pressed": locked,
        title: locked ? "Unlock staff row; approved leave stays protected" : "Lock staff row" }));
      nameCell.append(document.createTextNode(person.name), make("small", person.id));
      tr.append(nameCell);
      for (const date of current.dates) {
        const k = key(person.id, date), value = current.draft.cells[k] || "";
        const shift = current.catalog.find(s => s.id === value);
        const locked = isManualLock(current, person.id, date), source = assignmentSource(current, k);
        const origin = { approved: current.leaveOrigin === "published" ? "Published leave assignment" : "Imported approved leave",
          "manual-leave": "Manual leave", overridden: current.leaveOrigin === "published" ? "Overridden published leave" : "Overridden approved leave",
          generated: "Generated assignment", legacy: "Legacy assignment; source unknown", manual: "Manual assignment" }[source];
        const locks = [current.draft.staffLocks[person.id] && "Staff row locked", current.draft.locks[k] && "Cell locked"].filter(Boolean);
        const text = value || "-";
        const tip = person.name + ", " + date + ": " + (shift ? shift.id + " / " + timeLabel(shift) : value || "Unassigned") +
          [origin, ...locks].filter(Boolean).map(status => " (" + status + ")").join("");
        const attrs = { class: "cell", "data-key": k, "data-code": value, "data-locked": locked, "data-source": source, title: tip };
        const cell = preview ? make("span", text, attrs) : button(text, event => selectCell(k, event), { ...attrs, "aria-label": tip });
        if (shift) cell.style.setProperty("--shift", shift.color);
        tr.insertCell().append(cell);
      }
      const count = totals(current.catalog, current.dates.map(date => current.draft.cells[key(person.id, date)]));
      const cell = tr.insertCell();
      cell.className = "totals";
      cell.textContent = [count.work, count.off, count.leave].join(" / ");
    }
    if (people.length || report.daily.some(day => day.group === id && (day.demand.minWork || day.shifts.some(s => s.min || s.target)))) {
      addCoverage(body, people, "Coverage / ", id);
    }
  }
  addCoverage(table.createTBody(), current.people, "Combined / ");
  scroll.scrollTop = top;
  scroll.scrollLeft = left;
}

function render() {
  current = contextFor(history.current, team, month);
  $("team").value = team;
  $("month").value = month;
  const assignment = $("assignment").value;
  fill("group", [["", "All groups"], ...groupPairs(current)], group);
  fill("assignment", [...current.catalog.map(s => [s.id, s.id + " / " + timeLabel(s)]), ["", "Unassigned / empty"]],
    assignment || ($("assignment").options.length ? "" : current.catalog[0]?.id));
  fill("source", [["draft", "Current draft"], ...history.current.snapshots.map((s, i) => [String(i), s.team + " " + s.month + " snapshot r" + s.revision])], $("source").value || "draft");
  updateExportGroups();
  $("period").textContent = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(month + "-01T00:00:00Z"));
  $("summary").textContent = current.people.length + " staff / " + current.dates.length + " days / Draft r" + current.draft.revision;
  $("save").textContent = dirty() ? "Save draft" : "Saved";
  $("preview").textContent = preview ? "Back to editor" : "Preview";
  $("preview").setAttribute("aria-pressed", preview);
  $("confirm").hidden = !preview;
  $("generation").disabled = preview;
  $("scope").disabled = preview;
  $("empty-only").disabled = preview;
  $("generate").disabled = preview || Boolean(worker);
  $("group").disabled = preview;
  $("rules").disabled = preview;
  $("coverage").disabled = preview;
  $("demand").disabled = preview;
  $("groups").disabled = preview;
  $("undo").disabled = preview || !history.canUndo;
  $("undo-recovery").hidden = preview || history.current !== lastRecovery;
  $("redo").disabled = preview || !history.canRedo;
  $("clear-roster").disabled = preview;
  $("legend").replaceChildren(...current.catalog.map(shift => {
    const item = make("span");
    item.style.setProperty("--shift", shift.color);
    item.append(make("b", shift.id), document.createTextNode(" " + timeLabel(shift)));
    return item;
  }));
  const issues = validate(current);
  const report = coverageReport(current, current.draft.cells);
  renderGrid(report);
  updateSelection();
  if (showReport) renderReport(report, issues);
  $("preview").disabled = Boolean(!preview && issues.errors.length);
  $("preview").title = $("preview").disabled ? "Resolve blocking validation issues before preview" : "";
  const blanks = issues.errors.filter(item => item.type === "missing").length;
  $("validation-title").textContent = "Monthly validation / " + (issues.errors.length - blanks) + " blocking / " +
    blanks + " unassigned / " + issues.warnings.length + " warnings";
  $("issues").replaceChildren(validationSummary(issues));
}

function validationSummary({ errors, warnings }) {
  const root = make("div");
  const config = item => item.type === "group" || /: invalid (coverage|workload)/.test(item.label);
  const coverage = item => !config(item) && ["coverage", "demand"].includes(item.type);
  const sections = [["Configuration errors", errors.filter(config)], ["Unassigned roster cells", errors.filter(item => item.type === "missing")],
    ["Coverage shortfalls and limits", errors.filter(coverage)],
    ["Mandatory policy violations", errors.filter(item => !config(item) && !coverage(item) && item.type !== "missing")],
    ["Optional preference shortfalls", warnings.filter(item => item.type === "target")],
    ["Month-boundary warnings", warnings.filter(item => item.type === "boundary")],
    ["Other warnings", warnings.filter(item => !["target", "boundary"].includes(item.type))]];
  for (const [title, list] of sections) {
    if (!list.length) continue;
    const details = make("details"), items = make("ul"), grouped = new Map();
    details.open = title === "Coverage shortfalls and limits";
    details.append(make("summary", title + " (" + list.length + ")"));
    for (const item of list) {
      const signature = item.type + "|" + (item.coverage ? item.coverage[0] + "|" + item.coverage[2] : "") +
        "|" + (item.label.includes(":") ? item.label.split(":")[0] : item.type);
      const batch = grouped.get(signature) || [];
      batch.push(item); grouped.set(signature, batch);
    }
    for (const batch of grouped.values()) {
      const item = batch[0], li = make("li");
      const title = item.label + (batch.length > 1 ? " (" + batch.length + " occurrences; first shown)" : "");
      if (item.cell || item.coverage) li.append(button(title, () => { $("dialog").close(); focusIssue(item); }, { class: "issue-link" }));
      else li.textContent = title;
      items.append(li);
    }
    details.append(items);
    root.append(details);
  }
  if (!root.childElementCount) root.append(make("p", "No validation issues."));
  return root;
}

function focusIssue(issue) {
  const value = issue.cell || issue.coverage.join("|");
  const selector = "[" + (issue.cell ? "data-key" : "data-coverage") + '="' + CSS.escape(value) + '"]';
  let target = $("matrix").querySelector(selector);
  if (!target && group) {
    group = ""; selected.clear(); render();
    target = $("matrix").querySelector(selector);
  }
  if (target) {
    target.tabIndex = 0;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function bulk(values) {
  const keys = [...selected];
  const editable = keys.filter(k => !importedLeave(current, k) && !isManualLock(current, ...k.split("|")));
  const kept = [keys.some(k => importedLeave(current, k)) && (fixture ?
    "Use Override Published Leave for published leave" : "Use Override Approved Leave for imported leave"),
    keys.some(k => isManualLock(current, ...k.split("|"))) && "Unlock locked cells or rows before editing"].filter(Boolean);
  if (!editable.length) return notify(kept.join(". ") + ".");
  const allowed = new Set(editable);
  editDraft(draft => keys.forEach((k, index) => {
    if (allowed.has(k)) assignCell(draft, k, values[index % values.length]);
  }));
  notify(editable.length + " updated." + (kept.length ? " " + kept.join(". ") + "." : ""));
}

function confirmLeaveOverride(changes, apply) {
  const guard = current, before = history.current;
  const names = new Map(current.people.map(p => [p.id, p.name]));
  const reason = make("textarea", "", { maxlength: 500, rows: 3, required: "" });
  const reasonLabel = label("Reason for modification", reason);
  reasonLabel.className = "override-reason";
  const feedback = make("p", "", { role: "status" });
  const confirm = button("Confirm Override", () => {
    if (guard !== current || before !== history.current || preview) {
      $("dialog").close();
      return notify("Draft changed. Review the selected assignments again.");
    }
    const note = reason.value.trim();
    if (!note) { feedback.textContent = "Enter a reason before confirming the override."; reason.focus(); return; }
    $("dialog").close();
    apply(note, new Date().toISOString());
  }, { class: "primary" });
  openDialog(fixture ? "Override published leave" : "Override approved leave", [
    make("p", fixture ? "This changes the local draft only, not a published schedule or leave record." :
      "This changes the synthetic roster only. The original leave record and the reason are kept in the draft audit."),
    reportTable(["Staff", "Date", "Original leave", "Proposed assignment"], changes.map(([k, value]) => {
      const [id, date] = k.split("|");
      return [names.get(id), date, importedLeave(current, k), value || "Unassigned"];
    })),
    reasonLabel, feedback,
    row(button("Cancel", () => $("dialog").close()), confirm)
  ]);
}

function editApprovedLeave() {
  const proposed = $("assignment").value;
  const protectedKeys = [...selected].filter(k => importedLeave(current, k) && (current.draft.cells[k] || "") !== proposed);
  if (!protectedKeys.length) return notify("Choose a different assignment before overriding approved leave.");
  if (protectedKeys.some(k => isManualLock(current, ...k.split("|")))) {
    return notify("Unlock the manually locked cells or staff rows before overriding approved leave.");
  }
  const changes = protectedKeys.map(k => [k, proposed]);
  const context = current;
  confirmLeaveOverride(changes, (reason, at) => {
    editDraft(d => overrideApprovedLeave(context, d, changes, reason, at));
    notify(changes.length + " approved leave override(s) recorded.");
  });
}

function clearRosterDialog() {
  const operation = choose([["generated", "Clear Generated Assignments"], ["unlocked", "Clear Unlocked Assignments"],
    ["all", "Clear All Draft Assignments"], ["reset", "Reset to Original Draft"]], "generated");
  const staffIds = [...new Set([...selected].map(k => k.split("|")[0]))];
  const scope = choose([["staff", "Selected staff"], ["group", "Selected brand group"], ["team", "Entire selected team/month"]],
    staffIds.length ? "staff" : group ? "group" : "team");
  const target = choose(groupPairs(current), group || current.groups[0]?.id);
  const feedback = make("p", "", { role: "status" });
  openDialog("Clear / Reset Roster", [
    row(label("Operation", operation), label("Roster scope", scope), label("Brand group", target)),
    make("p", "Generated and unlocked clears keep protected leave and locked assignments. Clear All removes manual locks after confirmation and requires a reason for approved leave."),
    feedback, row(button("Cancel", () => $("dialog").close()), button("Review operation", () => {
      const action = operation.value, kind = scope.value, targetGroup = target.value, context = current;
      const ids = context.people.filter(p => kind === "team" || (kind === "group" ? p.group === targetGroup : staffIds.includes(p.id))).map(p => p.id);
      if (!ids.length) { feedback.textContent = "Select at least one staff member in this scope."; return; }
      const description = operation.selectedOptions[0].textContent;
      const commit = (reason = "", at = "") => {
        if (current !== context || preview) return notify("Roster changed. Review the operation again.");
        if (action === "reset") {
          const original = draftFor(loaded, team, month);
          editDraft(d => resetRosterScope(d, original, ids, context.dates, { whole: kind === "team", group: kind === "group" ? targetGroup : "" }));
        } else editDraft(d => clearRosterAssignments(context, d, ids, action, reason, at));
        notify(description + ": " + ids.length + " staff in " + team + " / " + month + ".");
      };
      openDialog(description, [make("p", description + " for " + ids.length + " staff in " + team + " / " + month +
        (kind === "group" ? " / " + new Map(groupPairs(current)).get(targetGroup) : "") + "?"),
        ...(action === "all" ? [make("p", "This also clears manual leave and removes manual cell and row locks in the selected scope. Imported leave still requires an approved leave override.")] : []),
        ...(action === "reset" ? [make("p", "Restore the draft values from when this page loaded. Other teams and months stay unchanged.")] : []),
        row(button("Cancel", () => $("dialog").close()), button("Confirm roster operation", () => {
          if (current !== context || preview) { $("dialog").close(); return notify("Roster changed. Review the operation again."); }
          const changes = ids.flatMap(id => context.dates.map(date => key(id, date)))
            .filter(k => action === "all" && importedLeave(context, k) && (context.leave[k] || context.draft.cells[k])).map(k => [k, ""]);
          if (changes.length) return confirmLeaveOverride(changes, commit);
          $("dialog").close(); commit();
        }, { class: "primary" }))]);
    }, { class: "primary" }))
  ]);
}

function openDialog(title, content) {
  $("dialog-title").textContent = title;
  $("dialog-content").replaceChildren(...content);
  if (!$("dialog").open) $("dialog").showModal();
}
function groupsDialog() {
  const groupList = choose([["", "New group"], ...current.groups.map(g => [g.id, g.name])], "");
  const name = input("text", "", { maxlength: 40 });
  groupList.onchange = () => { name.value = current.groups.find(g => g.id === groupList.value)?.name || ""; };
  const feedback = make("p", "", { role: "status" });
  const target = choose(groupPairs(current), group || current.people[0]?.group);
  const effective = input("month", month, { min: "2020-01", max: "2099-12" });
  const duration = choose([["permanent", "From effective month"], ["temporary", "Only this month"]], "permanent");
  const checklist = make("div", "", { class: "check-grid" });
  for (const person of current.people) checklist.append(label(person.name + " / " +
    (current.groups.find(g => g.id === person.group)?.name || "Unassigned"), input("checkbox", person.id)));
  openDialog("Brand groups", [
    row(label("Group", groupList), label("Name", name), button("Save group", () => {
      const value = name.value.trim();
      if (!value || current.groups.some(g => g.id !== groupList.value && g.name.toLowerCase() === value.toLowerCase())) {
        feedback.textContent = "Enter a nonempty, unique group name."; return;
      }
      history.change(model => {
        const existing = model.groups.find(g => g.id === groupList.value);
        if (existing) existing.name = value;
        else model.groups.push({ id: crypto.randomUUID(), name: value, team });
      });
      render();
      groupsDialog();
      notify("Group saved in the current draft.");
    })),
    make("h3", "Transfer staff"),
    checklist,
    row(label("To group", target), label("Effective month", effective), label("Duration", duration), button("Transfer", () => {
      const ids = [...checklist.querySelectorAll("input:checked")].map(control => control.value);
      if (!ids.length) { feedback.textContent = "Select at least one staff member."; return; }
      if (!datesFor(effective.value).length || effective.value < "2020-01" || effective.value > "2099-12") {
        feedback.textContent = "Enter a month between 2020 and 2099."; return;
      }
      history.change(model => {
        if (transferMany(model, ids, target.value, effective.value, duration.value === "temporary")) draftFor(model, team, month).revision++;
      });
      render();
      groupsDialog();
      notify(ids.length + " staff transferred. Earlier months and snapshots are unchanged.");
    })),
    feedback
  ]);
}

function coverageDialog(initialGroup = group, initialPeriod = "*") {
  const scope = choose(groupPairs(current), initialGroup || current.groups[0]?.id);
  const period = choose([["*", "Daily defaults"], ...weekdays.map(day => [day, day + " override"]),
    ...current.dates.map(date => [date, date + " override"])], initialPeriod);
  const table = make("table"), holder = make("div", "", { class: "dialog-table" });
  holder.append(table);
  const heading = table.createTHead().insertRow();
  ["Shift", "Override", "Auto", "Min", "Target", "Max", "Priority", "Flex"].forEach(text => heading.append(make("th", text)));
  const feedback = make("p", "", { role: "status" });
  const summary = make("p", "", { class: "muted" });
  const entries = [];
  const convert = button("Convert selected caps to targets", () => {
    for (const e of entries.filter(entry => entry.enabled.checked && entry.flex.checked && entry.max.value !== "")) {
      e.target.value = String(Math.max(+e.min.value, +e.target.value, +e.max.value));
      e.max.value = ""; e.override.checked = true; e.flex.checked = false;
    }
    sync();
    feedback.textContent = "Inputs updated. Review and save to change the draft.";
  });
  const sync = () => {
    const min = entries.reduce((n, e) => n + Number(e.min.value || 0), 0);
    const target = entries.reduce((n, e) => n + Number(e.target.value || 0), 0);
    const people = current.people.filter(person => person.group === scope.value);
    const available = /^\d/.test(period.value) ? people.filter(p => !current.leave[key(p.id, period.value)]).length : people.length;
    summary.textContent = "Total minimum " + min + " / target " + target + " / available " + available +
      (/^\d/.test(period.value) ? " (excluding confirmed leave)" : " before date-specific leave");
  };
  const refresh = () => {
    table.tBodies[0]?.remove();
    const body = table.createTBody();
    entries.length = 0;
    const selectedPeriod = period.value, groupId = scope.value;
    for (const shift of workShifts()) {
      const entryKey = coverageKey(groupId, selectedPeriod, shift.id);
      const exact = current.draft.coverage[entryKey];
      const weekdayKey = /^\d/.test(selectedPeriod) ? weekdays[weekday(selectedPeriod)] : "";
      const rule = asCoverage(exact ?? (weekdayKey ? current.draft.coverage[coverageKey(groupId, weekdayKey, shift.id)] : undefined) ??
        current.draft.coverage[coverageKey(groupId, "*", shift.id)]);
      const override = input("checkbox", "", { "aria-label": shift.id + " override" });
      override.checked = selectedPeriod === "*" || exact !== undefined;
      override.disabled = selectedPeriod === "*";
      const enabled = input("checkbox", "", { "aria-label": shift.id + " automatic generation" });
      enabled.checked = rule.enabled;
      const field = (value, name) => input("number", value ?? "", { min: 0, max: 99, step: 1, "aria-label": shift.id + " " + name });
      const min = field(rule.min, "minimum"), target = field(rule.target, "target"), max = field(rule.max, "maximum");
      const priority = choose(priorities.map((name, i) => [String(i), name]), String(rule.priority));
      const flex = input("checkbox", "", { "aria-label": shift.id + " select cap to convert" });
      priority.setAttribute("aria-label", shift.id + " priority");
      for (const control of [enabled, min, target, max, priority]) control.oninput = () => { override.checked = true; sync(); };
      override.onchange = sync;
      const tr = body.insertRow();
      tr.append(make("th", shift.id, { scope: "row" }));
      for (const control of [override, enabled, min, target, max, priority, flex]) tr.insertCell().append(control);
      entries.push({ entryKey, shift, min, target, max, priority, enabled, override, flex });
    }
    sync();
  };
  scope.onchange = period.onchange = refresh;
  refresh();
  openDialog("Coverage matrix", [row(label("Group", scope), label("Rule period", period)), summary,
    make("p", "Minimum is required. Target is a preference. Maximum is a strict limit; leave it blank for no cap beyond eligible staff."),
    holder, row(convert),
    row(button("Save coverage", () => {
      const updates = entries.map(e => [e, { min: e.min.value === "" ? NaN : +e.min.value,
        target: e.target.value === "" ? NaN : +e.target.value, max: e.max.value === "" ? null : +e.max.value,
        priority: +e.priority.value, enabled: e.enabled.checked }]);
      const invalid = updates.find(([e, rule]) => e.override.checked && (!validCoverage(rule) || rule.target > 99 || rule.max > 99));
      if (invalid) { feedback.textContent = invalid[0].shift.id + ": require minimum <= target <= maximum; disabled shifts need zero minimum and target."; return; }
      editDraft(d => {
        for (const [e, rule] of updates) {
          if (e.override.checked) d.coverage[e.entryKey] = rule; else delete d.coverage[e.entryKey];
        }
      });
      feedback.textContent = "Coverage saved.";
    })), feedback]);
}

function demandDialog(initialGroup = group, initialDate = "") {
  const scope = choose(groupPairs(current), initialGroup || current.groups[0]?.id);
  scope.setAttribute("aria-label", "Demand group");
  const override = choose([["", "Weekly rules"], ...current.dates.map(date => [date, date + " override"])], initialDate);
  const table = make("table"), holder = make("div", "", { class: "dialog-table" }), feedback = make("p", "", { role: "status" });
  const capacity = make("div");
  holder.append(table);
  const heading = table.createTHead().insertRow();
  ["Day", "Workload", "OFF max", "OFF preferred", "Work min"].forEach(text => heading.append(make("th", text, { scope: "col" })));
  const settings = [];
  function showCapacity() {
    const report = coverageReport(current, current.draft.cells);
    const rows = report.daily.filter(day => day.group === scope.value);
    const required = current.people.filter(person => person.group === scope.value).length * 2;
    const weeks = [];
    for (let i = 0; i + 6 < rows.length; i++) {
      const week = rows.slice(i, i + 7), slots = week.reduce((sum, day) => sum + day.cap, 0);
      weeks.push([week[0].date + " to " + week.at(-1).date, required, slots, slots < required ? "Insufficient" : "Aggregate only"]);
    }
    capacity.replaceChildren(make("h3", "Weekly OFF capacity"), reportTable(["Dates", "Required", "Available", "Capacity check"], weeks),
      make("p", "Capacity totals are not proof of feasible OFF pairs or shift coverage."));
  }
  const refresh = () => {
    table.tBodies[0]?.remove();
    const body = table.createTBody();
    settings.length = 0;
    for (const period of override.value ? [override.value] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      const k = demandKey(scope.value, period);
      const rule = { ...defaultDemand, ...(current.draft.demand[k] || (override.value ? current.draft.demand[demandKey(scope.value, weekdays[weekday(period)])] : null)) };
      const tr = body.insertRow();
      tr.append(make("th", period, { scope: "row" }));
      const workload = choose(workloads.map(name => [name, name]), rule.workload);
      workload.setAttribute("aria-label", period + " workload");
      const numeric = (n, name) => input("number", n ?? "", { min: 0, max: 99, step: 1, "aria-label": period + " " + name });
      const maxOff = numeric(rule.maxOff, "OFF maximum"), preferredOff = numeric(rule.preferredOff, "OFF preferred"), minWork = numeric(rule.minWork, "working minimum");
      for (const field of [workload, maxOff, preferredOff, minWork]) tr.insertCell().append(field);
      settings.push({ k, period, workload, maxOff, preferredOff, minWork });
    }
    showCapacity();
  };
  scope.onchange = override.onchange = refresh;
  refresh();
  openDialog("Weekly Demand & OFF Planning", [row(label("Group", scope), label("Rule period", override)), holder, row(
    button("Save demand", () => {
      const nullable = field => field.value === "" ? null : +field.value;
      const entries = settings.map(item => [item.k, { workload: item.workload.value, maxOff: nullable(item.maxOff),
        preferredOff: nullable(item.preferredOff), minWork: nullable(item.minWork) ?? 0 }]);
      if (entries.some(([, rule]) => !validDemand(rule) || [rule.maxOff, rule.preferredOff, rule.minWork].some(n => n > 99))) {
        feedback.textContent = "Use whole numbers and do not set preferred OFF above its maximum."; return;
      }
      editDraft(d => { for (const [k, value] of entries) d.demand[k] = value; });
      showCapacity();
      feedback.textContent = "Demand saved.";
    }), button("Clear date override", () => {
      if (!override.value) { feedback.textContent = "Select a date override first."; return; }
      editDraft(d => { delete d.demand[demandKey(scope.value, override.value)]; }); refresh();
      feedback.textContent = "Date override cleared.";
    })), feedback, capacity]);
}

function preferencesDialog(initialStaff) {
  const person = choose(current.people.map(p => [p.id, p.name]), initialStaff || current.people[0]?.id);
  const fields = make("div");
  const feedback = make("p", "", { role: "status" });
  const refresh = () => {
    const pref = current.draft.preferences[person.value] || {};
    const shifts = workShifts().map(s => [s.id, s.id]);
    const fixed = choose([["", "No fixed shift"], ...shifts], pref.fixed || "");
    const preferred = choose([["", "No preference"], ...shifts], pref.preferred || "");
    const rotation = choose([["", "Any eligible shift"], ["rotate", "Rotate weekly"], ["restricted", "One shift for this month"]],
      pref.restrictRotation ? "restricted" : pref.rotate ? "rotate" : "");
    const choices = (pairs, values) => {
      const block = make("div", "", { class: "check-grid" });
      for (const [value, text] of pairs) {
        const checkbox = input("checkbox", value);
        checkbox.checked = values.includes(value);
        block.append(label(text, checkbox));
      }
      return block;
    };
    const selectedValues = block => [...block.querySelectorAll("input:checked")].map(c => c.value);
    const allowed = choices(shifts, pref.allowed || []);
    const offPair = choose([["", "Optimize automatically"], ...pairNames.map((name, index) => [String(index), name])], String(pref.offPair ?? ""));
    const fieldsByRule = [["maxRun", "Max work streak", 1, 14], ["rest", "Rest (hours)", 0, 48]].map(([id, name, min, max]) =>
      ({ id, name, min, max, control: input("number", pref[id] ?? "", { min, max, step: 1, placeholder: "Default" }) }));
    const teamGroup = current.groups.find(g => g.id === current.people.find(p => p.id === person.value)?.group)?.name || "Unassigned";
    fields.replaceChildren(make("p", "Monthly group: " + teamGroup), make("h3", "Mandatory"),
      row(label("Fixed shift", fixed), label("Shift rotation", rotation)), make("p", "Allowed shifts (none selected means any eligible shift)"), allowed,
      row(...fieldsByRule.map(item => label(item.name, item.control))), make("h3", "Preferences"),
      row(label("Preferred shift", preferred), label("Preferred OFF pair", offPair)),
      row(button("Save preferences", () => {
        const allowedValues = selectedValues(allowed);
        if (fieldsByRule.some(item => item.control.value !== "" && !range(item.control.value, item.min, item.max)) ||
          fixed.value && allowedValues.length && !allowedValues.includes(fixed.value)) {
          feedback.textContent = "Check rule ranges and ensure the fixed shift is allowed."; return;
        }
        const numeric = Object.fromEntries(fieldsByRule.filter(item => item.control.value !== "").map(item => [item.id, +item.control.value]));
        editDraft(d => { d.preferences[person.value] = { ...d.preferences[person.value], ...Object.fromEntries(fieldsByRule.map(item => [item.id, numeric[item.id]])), fixed: fixed.value, preferred: preferred.value,
          allowed: allowedValues, offPair: offPair.value === "" ? null : +offPair.value,
          rotate: rotation.value === "rotate", restrictRotation: rotation.value === "restricted" }; });
        feedback.textContent = "Preferences saved.";
      }), button("Monthly group assignments", groupsDialog)));
  };
  person.onchange = refresh;
  refresh();
  openDialog("Staff scheduling preferences", [row(label("Staff", person)), fields, feedback]);
}

function rulesDialog() {
  const rules = current.draft.rules;
  const numeric = (value, min, max) => input("number", value, { min, max, step: 1 });
  const run = numeric(rules.maxRun, 1, 14), rest = numeric(rules.rest, 0, 48), fair = input("checkbox", "");
  fair.checked = rules.fair;
  const catalogEntry = choose([["", "New shift"], ...current.catalog.map(s => [s.id, s.id])], "");
  const id = input("text", "", { maxlength: 8 }), start = input("time", ""), end = input("time", "");
  const kind = choose([["work", "Working"], ["off", "OFF"], ["leave", "Leave"]], "work");
  const color = input("color", "#82d9ee");
  catalogEntry.onchange = () => {
    const entry = current.catalog.find(s => s.id === catalogEntry.value);
    id.value = entry?.id || "";
    id.disabled = Boolean(entry);
    start.value = entry?.start || "";
    end.value = entry?.end || "";
    color.value = entry?.color || "#82d9ee";
    kind.value = entry?.kind || "work";
    kind.disabled = Boolean(entry);
  };
  const feedback = make("p", "", { role: "status" });
  const transitions = make("div", "", { class: "check-grid" });
  const pairs = workShifts().flatMap((shift, i, all) => all.slice(i + 1).map(other => [shift.id, other.id]));
  const transitionInputs = pairs.map(([a, b]) => {
    const check = input("checkbox", "");
    check.checked = current.transitions.some(pair => pair.includes(a) && pair.includes(b));
    transitions.append(label(a + " / " + b, check));
    return check;
  });
  openDialog("Shift rules", [
    make("p", "Weekly OFF: exactly two consecutive regular OFF days per seven-day cycle."),
    row(label("Max work streak", run), label("Rest (hours)", rest), label("Fair distribution", fair),
      button("Save rules", () => {
        if (!range(run.value, 1, 14) || !range(rest.value, 0, 48)) { feedback.textContent = "Check rule ranges."; return; }
        editDraft(d => { Object.assign(d.rules, { maxRun: +run.value, rest: +rest.value, fair: fair.checked }); });
        feedback.textContent = "Rules saved.";
      })),
    make("h3", "Allowed adjustments before an OFF pair"), transitions,
    row(button("Save transitions", () => {
      history.change(model => {
        model.transitions[team] = pairs.filter((_, i) => transitionInputs[i].checked);
        draftFor(model, team, month).revision++;
      });
      render();
      feedback.textContent = "Team transitions saved.";
    })),
    row(button("Coverage matrix", () => coverageDialog()), button("Staff preferences", preferencesDialog)),
    make("h3", "Team shift catalog"),
    row(label("Edit", catalogEntry), label("Code", id), label("Type", kind), label("Start", start), label("End", end), label("Color", color),
      button("Save shift", () => {
        if (fixture) return;
        const code = id.value.trim().toUpperCase(), type = kind.value;
        if (!/^[A-Z][A-Z0-9]{0,7}$/.test(code) || (!catalogEntry.value && current.catalog.some(s => s.id === code)) ||
            (type === "off" && !catalogEntry.value) || (type === "work" && (!start.value || !end.value || start.value === end.value))) {
          feedback.textContent = "Enter a unique code and distinct start/end times for working shifts."; return;
        }
        history.change(model => {
          const catalog = model.catalogs[team];
          const value = { id: code, kind: type, start: type === "work" ? start.value : "", end: type === "work" ? end.value : "", color: color.value };
          const index = catalog.findIndex(s => s.id === code);
          if (index >= 0) catalog[index] = value; else catalog.push(value);
          draftFor(model, team, month).revision++;
        });
        render();
        rulesDialog();
        notify("Shift catalog updated.");
      }, fixture ? { disabled: "", title: "The source catalog is read-only" } : undefined)),
    feedback
  ]);
}

function confirmDialog() {
  const issues = validate(current);
  const revision = history.current;
  const acknowledgement = input("checkbox", "");
  const accept = button("Save simulated snapshot", () => {
    if (!acknowledgement.checked || issues.errors.length || revision !== history.current) return;
    const record = snapshot(current);
    history.change(model => { model.snapshots.push(record); });
    $("dialog").close();
    render();
    notify("Simulated snapshot created. Save draft to keep it in this browser.");
  }, { disabled: "" });
  acknowledgement.onchange = () => { accept.disabled = !acknowledgement.checked || Boolean(issues.errors.length); };
  openDialog("Simulated final confirmation", [
    make("p", "Production publishing is unavailable in prototype mode."),
    make("p", "Please check the Future_Leave_Requests tab in the Staff Schedule & Leave Management spreadsheet and ensure all approved leave requests for the selected month are included in the roster."),
    row(label("I acknowledge the reminder", acknowledgement)),
    ...(issues.warnings.some(issue => issue.type === "boundary")
      ? [make("p", "Month-boundary data is incomplete. This synthetic snapshot is provisional.", { class: "warning" })] : []),
    make("p", issues.errors.length ? issues.errors.length + " blocking issues must be resolved first." : "This saves a synthetic snapshot only."),
    row(accept, ...(fixtureMode && fixture?.publishFixture && !issues.errors.length ?
      [button("Review simulated publish", () => publishFixtureDialog(revision))] : []))
  ]);
}

async function publishFixtureDialog(revision) {
  if (!loopback || !fixtureMode || !fixture?.publishFixture || revision !== history.current) return;
  const scope = { team, month };
  const status = make("p", "Validating fixture draft...", { role: "status" });
  const request = async body => {
    const response = await fetch("./roster-fixture/publish", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      signal: AbortSignal.timeout(8000), body: JSON.stringify({ ...scope, ...body })
    });
    return response.json();
  };
  const stillOpen = () => status.isConnected && $("dialog").open && revision === history.current && team === scope.team && month === scope.month;
  openDialog("Review simulated publish", [status]);
  const records = current.people.flatMap(person => current.dates.map(date => ({
    staffId: person.id, date, shift: current.draft.cells[key(person.id, date)]
  })));
  try {
    const result = await request({ action: "preview", records, sourceRevision: fixture.revision,
      configuration: fixtureTools.publicationConfiguration(current) });
    if (!stillOpen()) return;
    if (!result.ok) {
      status.textContent = result.message;
      status.after(...(result.conflicts || []).map(conflict => make("p", conflict)));
      return;
    }
    const acknowledgement = input("checkbox", "");
    const counts = result.counts;
    status.textContent = counts.new + " new / " + counts.updated + " updated / " + counts.unchanged + " unchanged / " +
      counts.conflicting + " conflicting. No production writes.";
    const receipt = make("p", "", { role: "status" });
    const show = response => {
      receipt.textContent = response.state === "verified" ? "Simulated schedule write verified." :
        response.state === "not-written" ? "Reconciled: no rows were written." :
        response.message || "Write not verified. Check operation status before trying again.";
    };
    const check = button("Check Operation Status", async () => {
      try { show(await request({ action: "status", id: result.id })); }
      catch { receipt.textContent = "Status unavailable. Do not resubmit."; }
    });
    const recovery = button("Reconcile Uncertain Write", async () => {
      try { show(await request({ action: "recover", id: result.id })); }
      catch { receipt.textContent = "Reconciliation unavailable. Keep publishing paused."; }
    });
    const confirm = button("Publish Final Schedule", async () => {
      if (!stillOpen() || !acknowledgement.checked || confirm.disabled) return;
      confirm.disabled = acknowledgement.disabled = true;
      check.hidden = recovery.hidden = false;
      receipt.textContent = "Publishing to the local fixture...";
      try { show(await request({ action: "commit", id: result.id, acknowledged: true })); }
      catch { receipt.textContent = "Write outcome unknown. Check operation status; do not resubmit."; }
    }, { disabled: "" });
    check.hidden = recovery.hidden = true;
    acknowledgement.onchange = () => { confirm.disabled = !acknowledgement.checked; };
    const changes = make("details");
    changes.append(make("summary", "Show changed rows"), reportTable(["Staff ID", "Date", "Before", "After"],
      result.changes.map(({ before, after }) => [after.staff_id, after.schedule_date, before?.code || "-", after.shift_code])));
    status.after(changes, make("p", "Manually verify Future_Leave_Requests for this roster before publishing."),
      row(label("I verified the leave requests", acknowledgement), confirm), row(check, recovery), receipt);
  } catch {
    if (stillOpen()) status.textContent = "Fixture publish preview unavailable.";
  }
}

function reportTable(headers, values) {
  const table = make("table"), wrapper = make("div", "", { class: "dialog-table report-table" });
  const head = table.createTHead().insertRow();
  headers.forEach(name => head.append(make("th", name, { scope: "col" })));
  const body = table.createTBody();
  for (const valuesRow of values) {
    const tr = body.insertRow();
    for (const value of valuesRow) tr.insertCell().textContent = String(value);
  }
  wrapper.append(table);
  return wrapper;
}
const countPass = day => day.shifts.every(s => s.count >= s.min && (s.max === null || s.count <= s.max));
const targetRatio = day => day.shifts.reduce((sum, s) => sum + Math.min(s.count, s.target), 0) + "/" +
  day.shifts.reduce((sum, s) => sum + s.target, 0);
function renderReport(report, issues) {
  $("results").hidden = false;
  const groupNames = new Map(groupPairs(current));
  const combined = current.dates.map(date => {
    const days = report.daily.filter(d => d.date === date);
    return { date, name: "Combined", available: days.reduce((n, d) => n + d.available, 0),
      shifts: days.flatMap(d => d.shifts), working: days.reduce((n, d) => n + d.working, 0), off: days.reduce((n, d) => n + d.off, 0),
      cap: days.reduce((n, d) => n + d.cap, 0), shortfall: days.reduce((n, d) => n + d.shortfall, 0),
      counts: Object.fromEntries(current.catalog.map(s => [s.id, days.reduce((sum, d) => sum + (d.counts[s.id] || 0), 0)])) };
  });
  $("result-report").replaceChildren(
    make("p", report.staff.filter(p => p.work || p.off || p.leave).length + " staff / " + report.dates +
      " dates scheduled / " + report.working + " working shifts / " + report.missing + " unassigned"),
    make("p", issues.errors.length + " blocking / " + issues.warnings.length + " warnings / " +
      issues.errors.filter(e => e.type === "leave").length + " leave conflicts / " +
      issues.errors.filter(e => e.type === "lock").length + " lock conflicts"),
    make("p", "PM coverage: " + report.pmPercent.toFixed(1) + "% (" + report.pm + "/" + report.working +
      " working assignments). Preferences matched: " + report.preferenceHits + "/" + report.preferenceTotal + "."),
    make("p", "Paired OFF: " + report.offCompliant + "/" + report.offWeeks + " complete seven-day windows / " +
      report.excessOff + " excess OFF / " + report.cycleTransitions + " in-cycle shift adjustments."),
    make("p", Object.entries(report.distribution).map(([code, n]) => code + " " + n).join(" / ")),
    reportTable(["Staff", "Group", "Work", "OFF", "AL", "SL", "UL", "Shift totals", "Paired weeks", "Max work streak", "Transitions", "Preferences"],
      report.staff.map(p => [p.name, groupNames.get(p.group), p.work, p.off, p.mix.AL || 0, p.mix.SL || 0, p.mix.UL || 0,
        workShifts().map(s => s.id + " " + (p.mix[s.id] || 0)).join(" / "), p.compliant + "/" + p.weeks,
        p.maxStreak, p.transitions, p.preferred + "/" + p.opportunities])),
    make("h3", "Daily coverage"),
    reportTable(["Group", "Date", ...workShifts().map(s => s.id), "Work", "OFF / capacity", "AL", "SL", "UL", "Shortfall", "Target met"],
      [...combined, ...report.daily].map(day => [day.name, day.date, ...workShifts().map(s => day.counts[s.id] || 0),
        day.working, day.off + "/" + day.cap, day.counts.AL || 0, day.counts.SL || 0, day.counts.UL || 0,
        day.shortfall, targetRatio(day)]))
  );
}
const percent = n => n.toFixed(1) + "%";
const metricLine = m => percent(m.completion) + " assigned / " + percent(m.coverage) + " minimum coverage / " +
  m.met + "/" + m.needed + " required slots met / " + m.shortfall + " short / " + m.excess + " over caps / " + m.blockers + " blockers";
const recoveryMetrics = m => metricLine(m) + " / OFF " + m.paired + "/" + m.windows +
  " / Leave " + m.leaveMet + "/" + m.leaveTotal + " / PM " + m.pm + "/" + m.work;
function coverageChangeTable(item) {
  const changes = make("details"), names = new Map(groupPairs(current));
  changes.append(make("summary", item.changes.length + " exact-date coverage changes"),
    reportTable(["Group", "Date", "Shift", "Previous target / cap", "Proposed target / cap"], item.changes.map(c => [
      names.get(c.group) || c.group, c.date, c.shift, c.previous.target + " / " + c.previous.max,
      c.rule.target + " / " + (c.rule.max ?? "Unlimited")
    ])));
  return changes;
}
let lastRecovery;
function undoRecovery() {
  if (!lastRecovery || history.current !== lastRecovery) return notify("Use draft Undo for later changes first.");
  history.undo();
  lastRecovery = null;
  render();
  $("dialog").close();
  notify("Restored the draft before recovery.");
}

function recommendationPanel(flow, guard) {
  const { result, options } = flow, best = result.candidates?.[0], selected = [];
  const names = new Map(groupPairs(current));
  const alternatives = make("details"), list = make("div", "", { class: "recommendation-list" });
  const stats = (item, name) => [name, item.impact?.outcome || "Not tested",
    ...(item.impact ? [recoveryMetrics(item.impact.before), recoveryMetrics(item.impact.after)] : ["-", "-"])];
  const test = (items) => {
    if (!guard()) return notify("Draft changed. Generate again.");
    if (!items.length) return;
    $("dialog").close();
    launchGeneration({ ...options, retry: true }, items, result.suggestions, best?.metrics, null, flow);
  };
  const staffing = staffingPreflight(current, options);
  const allocations = staffing.moves.length ? staffing.unassigned.filter(person => !current.conflicts.includes(person.id)).map(person => {
    const control = choose([["", "Keep unassigned"], ...staffing.empty.map(g => [g.id, g.name])], "");
    control.setAttribute("aria-label", person.name + " (" + person.id + ")");
    return { person, control };
  }) : [];
  const testAllocation = button("Test Staff Allocation", () => {
    const moves = allocations.filter(row => row.control.value).map(row => ({ person: row.person.id, group: row.control.value }));
    if (!moves.length) return;
    test([{ id: "staff-allocation", title: "Staff allocation for " + month, moves }]);
  });
  const updateAllocation = () => { testAllocation.disabled = !allocations.some(row => row.control.value); };
  allocations.forEach(row => { row.control.onchange = updateAllocation; });
  updateAllocation();
  const auto = (result.suggestions || []).find(item => item.id === "optimize-caps" && item.impact.outcome !== "No improvement alone") ||
    (result.suggestions || []).find(item => item.id === "flexible-caps" && item.impact.outcome !== "No improvement alone");
  const autoButton = button("Auto Optimize Coverage", () => test([auto]), { class: "primary" });
  const testButton = button("Test Selected Recommendations", () => test(selected.filter(entry => entry.control.checked).map(entry => entry.item)));
  autoButton.disabled = !auto;
  testButton.disabled = true;
  for (const item of result.suggestions || []) {
    const control = input("checkbox", "");
    const name = item.title || [names.get(item.group) || item.group, item.staff, item.date, item.shift,
      item.current + " to " + item.proposed].filter(Boolean).join(" / ");
    control.onchange = () => {
      if (control.checked) for (const entry of selected) if (entry.control !== control && (item.changes || entry.item.changes)) entry.control.checked = false;
      testButton.disabled = !selected.some(entry => entry.control.checked);
    };
    selected.push({ item, control, name });
    const section = make("section", "", { class: "recommendation-item" });
    section.append(row(label(name, control)), make("p", item.effect));
    if (item.impact) section.append(make("p", item.impact.outcome + ". Before: " + recoveryMetrics(item.impact.before) +
      ". After: " + recoveryMetrics(item.impact.after) + "."));
    if (item.changes) section.append(coverageChangeTable(item));
    list.append(section);
  }
  alternatives.append(make("summary", "Tested recovery alternatives"),
    reportTable(["Alternative", "Outcome", "Before", "After"], selected.map(({ item, name }) => stats(item, name))));
  const edit = button("Edit Coverage Settings", () => {
    const first = best?.metrics?.overflow.find(row => row.shift !== "OFF") || best?.metrics?.shortages[0];
    coverageDialog(first?.group || options.group, first?.date || "*");
  });
  const pending = button("Apply Changes & Regenerate", () => {}, { disabled: "", title: "A verified trial is required" });
  const undo = button("Undo Applied Changes", undoRecovery);
  undo.disabled = !lastRecovery || history.current !== lastRecovery;
  const packageNote = list.childElementCount ?
    make("p", "Select individual recommendations together, or test one coordinated plan.") : null;
  const improved = selected.some(entry => entry.item.impact && entry.item.impact.outcome !== "No improvement alone");
  const solved = selected.some(entry => entry.item.impact?.outcome === "Resolves in this trial");
  const compare = button("Compare Alternatives", () => {
    alternatives.open = !alternatives.open;
    if (alternatives.open) alternatives.scrollIntoView({ block: "nearest" });
  });
  compare.disabled = !selected.length;
  return [
    make("h3", "Main Constraint Conflicts"),
    make("p", (result.issues || []).find(i => i.code === "weekly-work-capacity")?.reason ||
      (result.issues || []).find(i => i.certainty === "Confirmed")?.reason || "No proven contradiction. The best generated plan still has blockers."),
    ...((result.issues || []).some(i => i.code === "weekly-work-capacity") ? [make("p", (() => {
      const i = result.issues.find(x => x.code === "weekly-work-capacity");
      return [names.get(i.group), i.date + " to " + i.end, i.current, i.available].join(" / ");
    })())] : []),
    make("h3", "Recommended Adjustments"),
    ...(staffing.empty.length ? [
      make("p", "Review staffing before reducing coverage. " + staffing.empty.map(g => g.name + ": 0 staff, " + g.slots + " required slots").join(" / ") +
        ". " + staffing.unassigned.length + " unassigned staff in this scope."),
      row(button("Review Brand Groups", groupsDialog), button("Review Coverage Settings", () => coverageDialog(staffing.empty[0].id))),
      ...(allocations.length ? [
        ...allocations.map(({ person, control }) => row(label(person.name + " (" + person.id + ")", control))),
        row(button("Suggest Coordinated Allocation", () => {
          for (const { person, control } of allocations) control.value = staffing.moves.find(move => move.person === person.id)?.group || "";
          updateAllocation();
        }), testAllocation),
        make("p", "Test one transfer or several together. Nothing changes until approval; transfers apply to this month only.")
      ] : [])
    ] : []),
    row(autoButton, testButton, compare, edit),
    ...(!improved && !staffing.empty.length ? [make("p", "No tested change improved this plan. Review staff eligibility, retained assignments and required coverage. Temporary transfers can be reviewed in Brand groups."),
      row(button("Review Brand Groups", groupsDialog), button("Review Staff Eligibility", () => preferencesDialog()))] : []),
    ...(improved && !solved ? [make("p", "Some trials improved coverage, but none cleared all blockers. Review the remaining conflicts before changing requirements.")] : []),
    ...(packageNote ? [packageNote, list, alternatives] : []),
    row(pending, undo)
  ];
}

function reviewCandidates(candidates, guard, trial, detail = {}) {
  const source = trial?.context || current;
  const pick = choose(candidates.map((c, i) => [String(i), c.profile || "Candidate " + (i + 1)]), "0");
  const selectedPreview = make("div");
  const compare = reportTable(["Candidate", "Status", "Complete", "Minimum coverage", "Paired weeks", "PM share",
    "Workdays spread", "Blockers"], candidates.map((c, i) => {
    const people = c.report.staff.filter(p => c.scopePeople.includes(p.id));
    const daily = c.report.daily.filter(d => c.scopeGroups.includes(d.group));
    if (c.metrics) {
      const m = c.metrics;
      return [c.profile, c.status === "feasible" ? "Feasible" : "Provisional", percent(m.completion), percent(m.coverage),
        m.paired + "/" + m.windows, m.pm + "/" + m.work, m.fairness, m.blockers];
    }
    return [i + 1, "Feasible", "100%",
      daily.filter(d => countPass(d) && !d.shortfall && d.off <= (d.demand.maxOff ?? Infinity)).length + "/" + daily.length,
      people.reduce((n, p) => n + p.compliant, 0) + "/" + people.reduce((n, p) => n + p.weeks, 0),
      percent(c.report.pmPercent), Math.max(...people.map(p => p.work)) - Math.min(...people.map(p => p.work)), 0];
  }));
  const apply = button("", () => {
    const result = candidates[Number(pick.value)];
    const review = recoveryValidation(current, detail.baseline, source, result);
    const partial = result.status !== "feasible";
    if (detail.readOnly || !review.safe || partial && (!detail.approval || !review.improved)) return;
    if (!guard()) { $("dialog").close(); notify("Draft changed. Generate candidates again."); return; }
    showReport = true;
    history.change(model => {
      if (trial?.allocations?.length && !trial.allocations.every(move => transferMany(model, [move.person], move.group, month, true))) {
        throw new Error("Staff allocation no longer valid.");
      }
      const d = draftFor(model, team, month);
      const before = JSON.stringify(d);
      if (trial) {
        d.coverage = trial.context.draft.coverage;
        d.demand = trial.context.draft.demand;
        d.preferences = trial.context.draft.preferences;
      }
      assignmentsFromGeneration(d, result.cells);
      if (trial?.allocations?.length || JSON.stringify(d) !== before) d.revision++;
    });
    $("dialog").close();
    render();
    $("results").open = true;
    notify("Generated " + result.selectedCount + " staff assignments; review " + result.warnings.length + " warnings.");
    if (detail.approval) {
      lastRecovery = history.current;
      $("undo-recovery").hidden = false;
      openDialog(partial ? "Partial improvement applied" : trial?.allocations?.length ? "Staff allocation applied" : "Coverage changes applied", [
        make("p", "Full-month blockers: " + (review.before ?? "not measured") + " before / " + review.after + " after. " +
          (review.after ? "Final confirmation remains blocked." : "No mandatory conflicts remain.")),
        row(button("Continue Editing", () => $("dialog").close()), button("Undo Applied Changes", undoRecovery)),
        ...(review.after ? [validationSummary(validate(current))] : [])
      ]);
    }
  }, { class: "primary" });
  const openProvisional = button("Open Provisional in Editor", () => {
    const candidate = candidates[Number(pick.value)];
    if (!detail.recovery || !guard() || candidate.status !== "provisional" ||
      !recoveryValidation(current, null, current, candidate).safe) return;
    $("dialog").close();
    showReport = true;
    editDraft(d => assignmentsFromGeneration(d, candidate.cells));
    lastRecovery = history.current;
    $("undo-recovery").hidden = false;
    notify("Provisional roster opened for editing. Coverage conflicts remain; final confirmation is blocked until validation passes.");
  });
  const renderPreview = () => {
    const candidate = candidates[Number(pick.value)];
    const review = !detail.readOnly || detail.recovery ? recoveryValidation(current, detail.baseline, source, candidate) : null;
    apply.textContent = candidate.status !== "feasible" ? "Apply Partial Improvement" : detail.approval ? "Apply Changes & Regenerate" :
      trial ? "Apply tested changes and candidate" : "Apply candidate";
    apply.hidden = detail.readOnly || !review?.safe || candidate.status !== "feasible" && (!detail.approval || !review.improved);
    openProvisional.hidden = !detail.recovery || candidate.status !== "provisional" || !review?.safe;
    const metrics = candidate.metrics;
    const staff = source.people.filter(p => candidate.scopePeople.includes(p.id));
    const grid = reportTable(["Staff", ...source.dates.map(date => date.slice(-2))], staff.map(p =>
      [p.name, ...source.dates.map(date => candidate.cells[key(p.id, date)] || "-")]));
    const nodes = [];
    if (metrics) {
      nodes.push(make("p", metricLine(metrics) + ". Confirmed leave: " + metrics.leaveMet + "/" + metrics.leaveTotal + "."));
      if (detail.before) nodes.push(make("p", "Before trial: " + metricLine(detail.before) + ". After trial: " + metricLine(metrics) + "."));
      if (detail.approval && review) nodes.push(make("p", "Full-month blockers: " + (review.before ?? "not measured") + " before / " +
        review.after + " after. " + (candidate.status === "provisional" ? review.improved ? "Validated partial improvement; not a full resolution." :
          "This trial did not qualify as a safe partial improvement." : review.after ? "This scope is valid; other monthly conflicts remain." :
          "Full resolution.")));
      const staffTotals = make("details");
      staffTotals.append(make("summary", "Staff totals"), reportTable(["Staff", "Workdays", "OFF", "Leave", "PM", "Paired weeks"],
        metrics.people.map(p => [p.name, p.work, p.off, p.leave, p.mix.PM || 0, p.compliant + "/" + p.weeks])));
      nodes.push(staffTotals);
      if (metrics.shortages.length || metrics.overflow.length) {
        const shortages = make("details");
        shortages.append(make("summary", "Coverage shortages and caps (" + (metrics.shortages.length + metrics.overflow.length) + ")"),
          reportTable(["Group", "Date", "Shift", "Actual", "Requirement"], [
            ...metrics.shortages.map(r => [r.name, r.date, r.shift, r.actual, "Min " + r.required]),
            ...metrics.overflow.map(r => [r.name, r.date, r.shift, r.actual, "Max " + r.maximum])
          ]));
        nodes.push(shortages);
      }
      if (candidate.errors.length) nodes.push(validationSummary({ errors: candidate.errors, warnings: [] }));
    }
    selectedPreview.replaceChildren(make("p", candidate.warnings.length + " validation warnings in generation scope. " +
      staff.length + "/" + source.people.length + " staff in scope; other rows are unchanged."), grid, ...nodes);
  };
  pick.onchange = renderPreview;
  renderPreview();
  const actions = row(...(detail.readOnly ? [] : [apply]), ...(detail.recovery ? [openProvisional] : []),
    detail.back ? button(detail.approval ? "Discard changes" : "Back to diagnostics", detail.back) :
      button("Discard candidates", () => { $("dialog").close(); notify("Draft unchanged."); }));
  openDialog(detail.readOnly ? "Best Available Monthly Roster" : "Review generated candidates", [
    ...(detail.readOnly ? [make("p", "Read-only preview. Provisional plans cannot be applied as final, confirmed or published. " + (detail.feasibility || ""))] :
      trial ? [make("p", candidates.some(c => c.status === "feasible") ?
        "The trial produced a valid candidate for this scope. Review before applying the changes to the local draft." :
        "Review tested changes before approval. Applying updates the local draft only.")] : []),
    ...(detail.recovery ? [make("p", recoveryMetrics(candidates[0].metrics) + "."), ...recommendationPanel(detail.recovery, guard)] : []),
    ...(detail.approval && detail.before ? [make("p", "Before trial: " + recoveryMetrics(detail.before) +
      ". After trial: " + recoveryMetrics(candidates[0].metrics) + "."), actions,
      ...detail.tested.flatMap(item => item.moves ? [make("p", item.title), reportTable(["Staff", "Previous group", "Proposed group"],
        item.moves.map(move => [current.people.find(p => p.id === move.person)?.name, "Unassigned", current.groups.find(g => g.id === move.group)?.name]))] :
        item.changes ? [make("p", item.title), coverageChangeTable(item)] :
        [make("p", [item.group, item.date, item.shift, item.current + " to " + item.proposed].filter(Boolean).join(" / "))])] : []),
    compare, row(label("Preview", pick)),
    ...(detail.approval && detail.before ? [] : [actions]),
    selectedPreview]);
}

function openDiagnosticSetting(issue) {
  if (issue.setting === "coverage") return coverageDialog(issue.group, issue.date);
  if (issue.setting === "demand") return demandDialog(issue.group, issue.date);
  if (issue.setting === "groups") return groupsDialog();
  if (issue.setting === "staff") return preferencesDialog(issue.cell?.split("|")[0]);
  if (issue.cell) { $("dialog").close(); focusIssue(issue); }
}

function recoveryDialog(result, options, guard, trial = null, before = null) {
  const trialFailed = Boolean(trial);
  const headings = {
    timeout: "Search budget reached. Feasibility is unknown.",
    infeasible: "No valid candidate under the selected constraints.",
    "missing-boundary": "Previous-month data is unavailable.",
    error: "The generator could not complete."
  };
  const affectedGroups = options.group ? [options.group] : options.people ?
    [...new Set(current.people.filter(p => options.people.includes(p.id)).map(p => p.group))] : groupPairs(current).map(([id]) => id);
  const people = new Set(current.people.filter(p => affectedGroups.includes(p.group) && (!options.people || options.people.includes(p.id))).map(p => p.id));
  const scoped = validate(current, current.draft.cells, { groups: affectedGroups, people });
  const monthly = validate(current);
  const counts = value => value.errors.filter(i => i.type === "missing").length + " unassigned, " +
    value.errors.filter(i => i.type !== "missing").length + " other validation issues, " + value.warnings.length + " warnings";
  const grouped = new Map(), names = new Map(groupPairs(current));
  const orderedIssues = [...(result.issues || [])].sort((a, b) => Number(b.certainty === "Confirmed") - Number(a.certainty === "Confirmed"));
  for (const issue of orderedIssues) {
    const k = JSON.stringify([issue.certainty, issue.code, issue.reason, issue.group, issue.shift,
      issue.code === "boundary" ? "" : issue.staff, issue.current, issue.available]);
    const batch = grouped.get(k) || [];
    batch.push(issue); grouped.set(k, batch);
  }
  const details = make("div", "", { class: "diagnostic-list" });
  for (const batch of grouped.values()) {
    const item = batch[0], section = make("details");
    const dates = batch.map(i => i.date).filter(Boolean);
    const first = dates[0], last = batch.at(-1).end || dates.at(-1);
    section.append(make("summary", item.certainty + ": " + item.reason + " / " + (names.get(item.group) || item.group) +
      (item.shift ? " / " + item.shift : "") + (batch.length > 1 ? " (" + batch.length + " occurrences)" : "")),
      make("p", [[...new Set(batch.map(i => i.staff).filter(Boolean))].join(", "),
        first && (first === last ? first : first + " to " + last)].filter(Boolean).join(" / ")),
      make("p", "Current: " + (item.current ?? "Not determined") + " / Required or available: " + (item.available ?? "Not determined")),
      make("p", item.action));
    section.open = item.certainty === "Confirmed" && details.childElementCount < 2;
    if (item.setting || item.cell) section.append(button(batch.length > 1 ? "Open first affected setting or cell" : "Open affected setting or cell",
      () => openDiagnosticSetting(item)));
    details.append(section);
  }
  const list = make("div", "", { class: "diagnostic-list" });
  const selectedItems = [];
  const restart = (proposals = []) => {
    if (!guard()) { $("dialog").close(); return notify("Draft changed. Generate again."); }
    $("dialog").close();
    launchGeneration({ ...options, retry: true }, proposals, result.suggestions, before || result.candidates?.[0]?.metrics);
  };
  const apply = button("Apply & Regenerate", () => restart(selectedItems.filter(entry => entry.control.checked).map(entry => entry.item)));
  apply.disabled = true;
  for (const item of result.suggestions || []) {
    const control = input("checkbox", "");
    control.onchange = () => { apply.disabled = !selectedItems.some(entry => entry.control.checked); };
    selectedItems.push({ item, control });
    list.append(row(label(item.title || (item.group ? [names.get(item.group), item.date, item.shift].join(" / ") + ": " : "") +
      item.current + " to " + item.proposed, control)), make("p", item.effect),
      ...(item.impact ? [make("p", item.impact.outcome + ". Before: " + metricLine(item.impact.before) +
        ". After: " + metricLine(item.impact.after) + ".")] : []));
  }
  const controls = row(button("Retry Generation", () => restart()));
  controls.append(button("Diagnostic bundle", () => diagnosticDialog(options, () => recoveryDialog(result, options, guard, trial, before))));
  if (result.candidates?.length) controls.prepend(button("Review monthly candidates", () =>
    reviewCandidates(result.candidates, guard, trial, { readOnly: true, feasibility: result.feasibility, before,
      recovery: { result, options },
      back: () => recoveryDialog(result, options, guard, trial, before) }), { class: "primary" }));
  if (result.best) controls.append(button("View Best Possible Draft", () => {
    const best = result.best;
    const checked = validate(current, best.cells, { groups: best.scopeGroups, people: new Set(best.scopePeople) });
    const unresolved = (result.issues || []).filter(item => item.certainty === "Confirmed");
    const staff = current.people.filter(p => best.scopePeople.includes(p.id));
    const invalid = new Set(checked.errors.map(issue => issue.cell).filter(Boolean));
    const grid = reportTable(["Staff", ...current.dates.map(date => date.slice(-2))],
      staff.map(p => [p.name, ...current.dates.map(date => best.cells[key(p.id, date)] || "-")]));
    [...grid.querySelectorAll("tbody tr")].forEach((tr, i) => [...tr.cells].slice(1).forEach((td, n) => {
      if (invalid.has(key(staff[i].id, current.dates[n]))) td.classList.add("error");
    }));
    openDialog("Best Possible Draft (incomplete)", [
      make("p", "Invalid for final confirmation or publishing. Read-only preview; original draft unchanged."),
      make("p", best.completed + " candidate assignments evaluated. " + counts(checked) + " in this scope."),
      ...(unresolved.length ? [make("p", unresolved.map(item => item.reason).join(" / "))] : []),
      validationSummary(checked), grid,
      row(button("Back to diagnostics", () => recoveryDialog(result, options, guard, trial, before)))
    ]);
  }));
  openDialog("Generation diagnostics", [
    make("p", result.feasibility || headings[result.status] || "No candidate was generated."),
    ...(trialFailed ? [make("p", "The proposed trial did not succeed. No settings or assignments were changed.")] : []),
    make("p", "Selected scope: " + counts(scoped) + ". Full month: " + counts(monthly) + "."),
    make("p", "Generation conflicts: " + (result.issues || []).filter(item => item.certainty === "Confirmed").length +
      " confirmed before search. Unassigned draft cells are not generation conflicts."),
    ...(result.steps ? [make("p", result.steps + " steps in the reported attempt. Observed branches do not prove the cause of failure.")] : []),
    ...(result.candidates?.length ? [make("p", metricLine(result.candidates[0].metrics) + ".")] : []),
    ...(result.candidates?.length && staffingPreflight(current, options).empty.length ? [
      make("p", "Review monthly candidates to test staff allocation or open the provisional roster for editing.")
    ] : []),
    controls,
    ...(selectedItems.length ? [make("h3", "Smart Adjustments"), make("p", "Select changes to test together before approving them."),
      list, row(apply)] : []),
    ...(details.childElementCount ? [details] : [make("p", result.reason)])
  ]);
}

function diagnosticDialog(options, back) {
  const file = input("file", "", { accept: ".json,application/json" });
  const feedback = make("p", "", { role: "status" });
  const exportOptions = options || {
    strategy: $("generation").value === "copy" ? "previous" : $("generation").value,
    group: $("scope").value === "group" ? group : "", keepAssigned: $("empty-only").checked,
    people: $("scope").value === "staff" ? [...new Set([...selected].map(k => k.split("|")[0]))] : undefined
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([createDiagnosticBundle(current, exportOptions)], { type: "application/json" }));
    const link = make("a", "", { href: url, download: "roster-diagnostic-" + current.team + "-" + month + ".json" });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const replay = button("Replay imported bundle", async () => {
    const chosen = file.files[0];
    if (!chosen || chosen.size > diagnosticMaxBytes) { feedback.textContent = "Choose a supported JSON bundle under 512 KB."; return; }
    replay.disabled = true;
    try {
      const imported = readDiagnosticBundle(await chosen.text());
      if (!$("dialog").open || !replay.isConnected) return;
      if (worker) { feedback.textContent = "Cancel or wait for the current generation before replaying."; return; }
      $("dialog").close();
      launchGeneration(imported.options, [], [], null, imported.context);
    } catch { feedback.textContent = "This file is not a supported anonymized roster diagnostic bundle."; }
    finally { replay.disabled = false; }
  });
  openDialog("Diagnostic bundle", [
    make("p", "Export the current roster inputs with staff aliases and no login IDs. The bundle contains coverage, assignments, locks, leave and nearby roster dates. Review it before sharing."),
    row(button("Export anonymized diagnostic bundle", download)),
    row(label("Diagnostic JSON", file), replay),
    make("p", "Replay is local and read-only. It does not replace the current draft or browser storage."),
    feedback, ...(back ? [button("Back to diagnostics", back)] : [])
  ]);
}

function run() {
  const strategy = $("generation").value, scope = $("scope").value;
  if (strategy === "copy") {
    if (!Object.keys(current.previous).length) return notify("No previous-month draft or snapshot.");
    const ids = scope === "staff" ? new Set([...selected].map(k => k.split("|")[0])) : null;
    if (scope === "group" && !group) return notify("Select a group first.");
    if (ids && !ids.size) return notify("Select a cell for each staff member to include.");
    const cells = previousPattern({ ...current, people: current.people.filter(person => (!ids || ids.has(person.id)) &&
      (scope !== "group" || person.group === group)) }, $("empty-only").checked);
    editDraft(d => assignmentsFromGeneration(d, cells));
    return notify("Previous pattern copied. Review validation before continuing.");
  }
  if (scope === "group" && !group) return notify("Select a group first.");
  const ids = scope === "staff" ? [...new Set([...selected].map(k => k.split("|")[0]))] : undefined;
  if (ids && !ids.length) return notify("Select a cell for each staff member to include.");
  const options = { strategy, people: ids, group: scope === "group" ? group : "", keepAssigned: $("empty-only").checked };
  const staffing = staffingPreflight(current, options);
  if (!staffing.empty.length) return launchGeneration(options);
  openDialog("Staffing check before generation", [
    make("p", staffing.unassigned.length + " unassigned staff in this scope. Allocate staff or review group settings before reducing coverage."),
    reportTable(["Empty brand group", "Peak staff needed per day", "Required slots in month"], staffing.empty.map(g => [g.name, g.peak, g.slots])),
    row(button("Review Brand Groups", groupsDialog), button("Generate Baseline & Review", () => {
      $("dialog").close();
      launchGeneration(options);
    }))
  ]);
}

function launchGeneration(options, proposals = [], availableProposals = [], baseline, replay, flow) {
  if (worker) return;
  const before = history.current, beforeTeam = team, beforeMonth = month;
  const unchanged = () => history.current === before && team === beforeTeam && month === beforeMonth && !preview;
  const trial = proposals.length ? adjustmentTrial(current, options, proposals) : null;
  const job = new Worker(new URL("./roster-generator.js", import.meta.url), { type: "module" });
  worker = job;
  $("generate").disabled = true;
  $("cancel-generation").hidden = false;
  notify("");
  const progress = $("generation-progress");
  progress.hidden = false;
  progress.textContent = trial ? "Testing selected adjustments..." : options.retry ?
    "Retrying with a wider search..." : "Checking constraints and generating candidates...";
  const done = result => {
    if (worker !== job) return;
    job.terminate();
    worker = null;
    $("cancel-generation").hidden = true;
    progress.hidden = true;
    render();
    if (!unchanged()) return notify("Roster changed during generation. Run it again.");
    if (result.status === "cancelled") return notify(result.reason);
    if (replay) {
      if (result.candidates?.length) {
        reviewCandidates(result.candidates, unchanged, { context: replay }, { readOnly: true, feasibility: result.feasibility ||
          "Imported replay. The saved draft is unchanged." });
      } else openDialog("Diagnostic replay result", [make("p", result.reason),
        make("p", "Read-only imported replay. The saved draft is unchanged."),
        ...result.issues?.filter(i => i.certainty === "Confirmed").slice(0, 12).map(i =>
          make("p", [i.group, i.staff, i.date, i.shift, i.reason].filter(Boolean).join(" / "))) || []]);
      return;
    }
    if (result.status === "feasible") {
      notify(result.candidates.length + " candidate(s) ready to review. Draft unchanged.");
      reviewCandidates(result.candidates, unchanged, trial, { before: baseline, baseline: flow?.result.candidates?.[0], approval: Boolean(flow), tested: proposals,
        back: flow && (() => reviewCandidates(flow.result.candidates, unchanged, null, { readOnly: true,
          recovery: flow, feasibility: flow.result.feasibility })) });
    } else {
      notify("No candidate applied. Draft unchanged.");
      if (flow && result.candidates?.length) {
        reviewCandidates(result.candidates, unchanged, trial, { approval: true, before: baseline, baseline: flow.result.candidates?.[0],
          tested: proposals, back: () => reviewCandidates(flow.result.candidates, unchanged, null, {
            readOnly: true, recovery: flow, feasibility: flow.result.feasibility }) });
        return;
      }
      // Do not offer partial trials computed with settings that were never committed.
      if (trial) {
        result.best = undefined;
        result.suggestions = availableProposals;
      }
      recoveryDialog(result, options, unchanged, trial, baseline);
    }
  };
  $("cancel-generation").onclick = () => done({ status: "cancelled", reason: "Generation cancelled. Draft unchanged." });
  worker.onmessage = ({ data }) => {
    if (worker !== job) return;
    if (data.progress) progress.textContent = (data.progress.profile ? "Planning " + data.progress.profile : "Searching candidate " + data.progress.variant + " of 3") + (data.progress.date ?
      " / " + data.progress.date + " / " + data.progress.steps + " steps" : "");
    else done(data);
  };
  worker.onerror = () => done({ status: "error", reason: "Worker unavailable." });
  worker.postMessage(trial || { context: replay || current, options });
}

$("team").onchange = () => {
  team = $("team").value; group = ""; selected.clear(); anchor = ""; preview = false; showReport = false;
  $("results").hidden = true; $("generation").value = team === "Affiliate" ? "pm" : "balanced"; render();
};
$("month").onchange = () => {
  const value = $("month").value;
  if (!$("month").checkValidity() || !datesFor(value).length) { $("month").value = month; return; }
  month = value; selected.clear(); anchor = ""; preview = false; showReport = false; $("results").hidden = true; render();
};
$("group").onchange = () => { group = $("group").value; selected.clear(); anchor = ""; render(); };
$("apply").onclick = () => bulk([$("assignment").value]);
$("clear").onclick = () => bulk([""]);
$("override-leave").onclick = editApprovedLeave;
$("clear-roster").onclick = clearRosterDialog;
$("copy").onclick = () => { clipboard = [...selected].map(k => current.draft.cells[k] || ""); updateSelection(); notify(clipboard.length + " copied."); };
$("paste").onclick = () => {
  if (clipboard.some(value => value && !current.catalog.some(s => s.id === value))) return notify("Clipboard contains a shift outside this team catalog.");
  bulk(clipboard);
};
$("lock").onclick = () => {
  const keys = [...selected].filter(k => !current.draft.staffLocks[k.split("|")[0]]);
  if (!keys.length) return notify("Unlock the staff row before changing its cell locks.");
  const allLocked = keys.every(k => current.draft.locks[k]);
  editDraft(d => {
    for (const k of keys) { if (allLocked) delete d.locks[k]; else d.locks[k] = true; }
  });
  notify(keys.length + (allLocked ? " cell lock(s) removed" : " cell(s) locked") + ". Approved leave protection is unchanged.");
};
$("undo").onclick = () => { history.undo(); render(); };
$("undo-recovery").onclick = undoRecovery;
$("redo").onclick = () => { history.redo(); render(); };
$("save").onclick = () => {
  try {
    if (fixture) {
      const { people, memberships, snapshots, transitions } = history.current;
      const draft = draftFor(history.current, team, month);
      const sourceDraftKey = liveMode ? fixtureTools.liveDraftKey : fixtureTools.fixtureDraftKey;
      localStorage.setItem(sourceDraftKey(fixture.principal, team, month), JSON.stringify({
        revision: fixture.revision, included: people.map(p => p.id), memberships, transitions,
        snapshots: snapshots.map(record => ({ ...record, people: record.people.map(p => ({ id: p.id, group: p.group })) })), draft
      }));
    } else save(localStorage, history.current, team, month);
    saved = JSON.stringify({ model: history.current, team, month });
    render(); notify("Draft saved in this browser.");
  }
  catch { notify("Draft could not be saved. Browser storage may be unavailable or full."); }
};
$("preview").onclick = () => { preview = !preview; selected.clear(); anchor = ""; render(); };
$("confirm").onclick = confirmDialog;
$("groups").onclick = groupsDialog;
$("rules").onclick = rulesDialog;
$("coverage").onclick = () => coverageDialog();
$("demand").onclick = () => demandDialog();
$("generate").onclick = run;
$("diagnostic-bundle").onclick = () => diagnosticDialog();
$("source").onchange = updateExportGroups;
for (const format of ["csv", "xlsx", "audit-csv"]) $(format).onclick = async () => {
  try { $(format).disabled = true; await downloadRoster(exportRecord(), format, $("export-group").value); }
  catch (error) { notify("Export failed: " + error.message); }
  finally { $(format).disabled = false; }
};
window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
$("generation").value = team === "Affiliate" ? "pm" : "balanced";
render();
