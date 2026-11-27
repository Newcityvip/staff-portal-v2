import { datesFor, draftFor } from "./roster-model.js";
import { createSourceReader, draftComparison, fixtureDraftKey, fixtureHandoffKey, liveDraftKey, sourceDraft } from "./roster-source.js";
import { rosterLiveEnabled, rosterWorker } from "./roster-live-config.js";

const $ = id => document.getElementById(id);
const loopback = location.protocol === "http:" && location.hostname === "127.0.0.1";
const filters = new URLSearchParams(location.search);
const live = filters.get("source") === "live";
const enabled = live && rosterLiveEnabled && (location.protocol === "https:" || loopback);
const draftKey = live ? liveDraftKey : fixtureDraftKey;
let session, expiry, editor, handoff, reader;
const post = (operation, data, signal) => fetch(rosterWorker + "/roster/v1/" + operation, {
  method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal,
  headers: { "Content-Type": "application/json", ...(session && operation === "snapshot" ? { Authorization: "Bearer " + session.token } : {}) },
  body: JSON.stringify(data)
});
const makeReader = () => createSourceReader({ request: (team, month, signal) => {
  if (live) return post("snapshot", { team, month }, signal);
  const url = new URL("roster-fixture/snapshot", location.href);
  url.search = new URLSearchParams({ team, month });
  return fetch(url, { credentials: "same-origin", cache: "no-store", signal });
} });
reader = makeReader();
let source, local;
const status = (message) => { $("source-status").textContent = message; };
const element = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
const table = (headers, rows) => {
  const t = element("table", ""), head = t.createTHead().insertRow(), body = t.createTBody();
  head.append(...headers.map(value => element("th", value)));
  for (const row of rows) body.insertRow().append(...row.map(value => element("td", String(value ?? ""))));
  return t;
};
function paint(result) {
  source = result.source;
  try { local = JSON.parse(localStorage.getItem(draftKey(source.principal, source.team, source.month))); }
  catch { local = null; }
  const directory = source.staff.map(person => {
    const check = element("input", ""); check.type = "checkbox"; check.value = person.id;
    check.disabled = Boolean(person.exclusion); check.checked = !check.disabled;
    check.setAttribute("aria-label", "Include " + person.name);
    return [person.id, person.name, person.exclusion || "Active", check];
  });
  const staff = table(["ID", "Name", "Roster eligibility", "Include"], []);
  for (const [id, name, state, check] of directory) {
    const row = staff.tBodies[0].insertRow();
    row.append(...[id, name, state].map(value => element("td", value)));
    row.insertCell().append(check);
  }
  $("source-staff").replaceChildren(staff);
  $("source-schedule").replaceChildren(table(["Staff ID", "Date", "Shift", "Start", "End", "Status"], source.rows
    .map(row => [row.id, row.date, row.code + (["AL", "SL", "UL"].includes(row.code) ? " (published leave)" : ""), row.start, row.end, row.conflict || row.status])));
  $("source-counts").textContent = source.rows.length ? source.rows.length + " rows including adjacent months / " + source.timeZone : "No published schedule rows for this window.";
  $("source-issues").replaceChildren(...source.issues.map(i => element("li", [i.kind, i.date, i.staffId].filter(Boolean).join(" / "))));
  $("source-shifts").replaceChildren(...source.catalog.filter(s => s.kind === "work").map(shift => {
    const label = element("label", shift.id + " " + shift.start + " - " + shift.end);
    const input = element("input", ""); input.type = "checkbox"; input.checked = true; input.value = shift.id;
    input.setAttribute("aria-label", "Generate " + shift.id);
    label.prepend(input); return label;
  }));
  const stale = local && local.revision !== source.revision;
  $("draft-info").textContent = stale ? "Source changed since this local draft. Review differences before preparing a replacement." :
    local ? "A local draft exists for this admin, team and month." : "New Affiliate staff are unassigned until mapped locally.";
  $("resume-source").hidden = !local || stale || !source.usable;
  $("copy-published").disabled = $("blank-source").disabled = !source.usable;
  $("source-review").hidden = false;
}
async function refresh() {
  if (!(live ? session : loopback) || !$("source-month").value) return;
  const activeReader = reader;
  const team = $("source-team").value, month = $("source-month").value;
  source = null; $("source-review").hidden = true;
  status("Loading roster source...");
  const result = await reader.refresh(team, month);
  if (!result || activeReader !== reader) return;
  if (result.state === "ready") {
    const allowed = result.source.teams;
    for (const option of $("source-team").options) option.disabled = !allowed.includes(option.value);
    paint(result);
    status("Last refreshed " + new Date(result.refreshedAt).toLocaleTimeString() + " / Revision " + result.source.revision +
      (result.changed ? " / Source changed; local drafts were not replaced." : ""));
  } else {
    if (live && result.state === "denied") return endSession("Access denied or session expired. Sign in again from an approved network.");
    const failure = result.state === "denied" ? "Access denied or the fixture session expired. Reopen this preview to renew the fixture session." :
      result.state === "timeout" ? "Roster source timed out. Use Refresh Data to retry." : "Roster source unavailable. Use Refresh Data to retry.";
    status(failure + (result.previous ? " Showing stale data for review only." : ""));
    if (result.previous) {
      paint(result.previous);
      $("resume-source").hidden = true;
      $("copy-published").disabled = $("blank-source").disabled = true;
    }
  }
}
function prepare(mode) {
  if (!source?.usable) return;
  const included = mode === "resume" ? local.included : [...$("source-staff").querySelectorAll("input:checked")].map(i => i.value);
  const shifts = [...$("source-shifts").querySelectorAll("input:checked")].map(i => i.value);
  const model = sourceDraft(source, included, mode !== "new", shifts);
  if (!model.people.length) { $("draft-info").textContent = "Select at least one eligible staff member."; return; }
  const { team, month, revision, principal } = source;
  const draft = draftFor(model, team, month);
  if (mode === "resume") {
    Object.assign(draft, local.draft);
    model.memberships = local.memberships;
    model.transitions = local.transitions || model.transitions;
    const directory = new Map(model.people.map(person => [person.id, person]));
    model.snapshots = (local.snapshots || []).map(record => ({ ...record, people: record.people.filter(person => directory.has(person.id))
      .map(person => ({ ...directory.get(person.id), group: person.group })) }));
  }
  const open = () => {
    if (live) {
      if (!session || source?.revision !== revision || source?.team !== team || source?.month !== month) return;
      if (editor && !confirm("Replace the open editor? Unsaved changes will be lost.")) return;
      handoff = { model, team, month, revision, principal };
      editor = element("iframe", "");
      editor.title = "Local roster editor"; editor.width = "100%"; editor.height = "960";
      editor.src = "admin-roster.html?source=live";
      $("source-editor").replaceChildren(editor);
      showEditor(true);
      return;
    }
    sessionStorage.setItem(fixtureHandoffKey, JSON.stringify({ model, team, month, revision, principal,
      ...(filters.get("publish") === "fixture" ? { publishFixture: true } : {}) }));
    location.href = "admin-roster.html?source=fixture";
  };
  if (!local || mode === "resume") return open();
  const dialog = $("source-dialog"), baseline = source;
  const compared = [...new Set([...local.included, ...model.people.map(p => p.id)])].map(id => ({ id }));
  const diff = draftComparison(local.draft.cells, draft.cells, compared, datesFor(month));
  $("source-comparison").textContent = "Compared with your saved draft: " + diff.added + " added, " + diff.removed + " removed, " + diff.changed +
    " changed. Opening does not replace your saved draft until you explicitly save.";
  dialog.returnValue = "cancel";
  dialog.onclose = () => { if (dialog.returnValue === "proceed" && source === baseline) open(); };
  dialog.showModal();
}
function showEditor(show) {
  $("source-editor").hidden = !show;
  $("source-review").hidden = show || !source;
  $("resume-editor").hidden = show || !editor;
}
function endSession(message) {
  session = source = local = editor = handoff = null;
  clearTimeout(expiry);
  reader = makeReader();
  if ($("source-dialog").open) $("source-dialog").close("cancel");
  for (const id of ["source-editor", "source-staff", "source-schedule", "source-issues", "source-shifts"]) $(id).replaceChildren();
  for (const id of ["source-counts", "draft-info", "source-comparison"]) $(id).textContent = "";
  showEditor(false);
  $("roster-login").hidden = !enabled;
  $("source-controls").hidden = true;
  status(message);
}
window.addEventListener("message", event => {
  if (!session || !editor || event.origin !== location.origin || event.source !== editor.contentWindow) return;
  if (event.data?.type === "roster-editor-ready") event.source.postMessage({ type: "roster-editor-model", handoff }, location.origin);
  if (event.data?.type === "roster-editor-back") showEditor(false);
});
$("resume-editor").onclick = () => showEditor(true);
$("roster-logout").onclick = () => endSession("Signed out.");
$("roster-login").onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector("button");
  if (!enabled || session || button.disabled) return;
  const data = Object.fromEntries(new FormData(form));
  form.elements.password.value = "";
  button.disabled = true;
  status("Signing in...");
  try {
    const response = await post("login", data, AbortSignal.timeout(12000));
    if (!response.ok) {
      status(response.status === 429 ? "Too many attempts. Wait before trying again." :
        [401, 403].includes(response.status) ? "Sign-in denied. Check your credentials and approved network." : "Sign-in unavailable. Try again.");
      return;
    }
    const result = await response.json();
    const options = [...$("source-team").options];
    if (result.ok !== true || !/^[\w-]{1,1024}\.[a-f0-9]{64}$/.test(result.token || "") ||
      !Array.isArray(result.teams) || !result.teams.length || !result.teams.every(team => options.some(o => o.value === team)) ||
      !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error("Invalid session");
    session = { token: result.token };
    expiry = setTimeout(() => endSession("Session expired. Sign in again to continue."), Math.min(600000, result.expiresAt - Date.now()));
    for (const option of options) option.disabled = !result.teams.includes(option.value);
    if (!result.teams.includes($("source-team").value)) $("source-team").value = result.teams[0];
    form.reset();
    form.hidden = true;
    $("source-controls").hidden = $("roster-logout").hidden = false;
    refresh();
  } catch { status("Sign-in unavailable. Try again."); }
  finally { button.disabled = false; }
};
$("refresh-source").onclick = refresh;
$("source-team").onchange = $("source-month").onchange = refresh;
$("resume-source").onclick = () => prepare("resume");
$("copy-published").onclick = () => prepare("published");
$("blank-source").onclick = () => prepare("new");
if (live) {
  $("source-mode").textContent = "Live read-only / Publishing disabled";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit" })
    .formatToParts(new Date());
  $("source-month").value = parts.find(p => p.type === "year").value + "-" + parts.find(p => p.type === "month").value;
  endSession(enabled ? "Sign in to review roster source data. Save draft changes locally before your session expires." : "Live roster access is disabled.");
} else if (loopback) {
  if (["Affiliate", "CSP"].includes(filters.get("team"))) $("source-team").value = filters.get("team");
  if (/^20\d\d-(0[1-9]|1[0-2])$/.test(filters.get("month") || "")) $("source-month").value = filters.get("month");
  refresh();
} else {
  $("refresh-source").disabled = true;
  status("Live integration is not enabled. This preview requires the local fixture harness.");
}
