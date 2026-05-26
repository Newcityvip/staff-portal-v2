(function () {
  const API_BASE = "https://staff-portal-api-v2.mdrobiulislam.workers.dev";
  const SESSION_KEY = "staffPortalV2.session";
  const REMEMBER_KEY = "staffPortalV2.remember";
  const MAX_SESSION_AGE = 12 * 60 * 60 * 1000;

  const safeJson = async (response) => {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (error) { return { ok: response.ok, raw: text }; }
  };

  const normalizeArray = (value) => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    return value.data || value.rows || value.items || value.records || value.logs || value.staff || value.leaderboard || [];
  };

  const pick = (source, keys, fallback = "") => {
    if (!source || typeof source !== "object") return fallback;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
    }
    return fallback;
  };

  const formatTime = (value) => {
    if (!value) return "--";
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return String(value);
  };

  const formatDate = (value) => {
    if (!value) return "--";
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    return String(value);
  };

  const percent = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, number));
  };

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value === undefined || value === null || value === "" ? "--" : String(value);
  };

  const setStatus = (online, text) => {
    const el = document.getElementById("connectionStatus");
    if (!el) return;
    el.textContent = text || (online ? "Live" : "Offline");
    el.classList.toggle("online", Boolean(online));
    el.classList.toggle("offline", !online);
  };

  const toast = (message, type = "info") => {
    const host = document.getElementById("toastHost");
    if (!host) return;
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  };

  const buildHeaders = (session) => {
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (session?.token) headers.Authorization = `Bearer ${session.token}`;
    if (session?.staffId) headers["X-Staff-ID"] = session.staffId;
    if (session?.role) headers["X-Portal-Role"] = session.role;
    return headers;
  };

  const api = {
    base: API_BASE,
    async call(action, payload = {}, options = {}) {
      const session = Portal.getSession(false);
      const body = { action, ...payload };
      const endpoints = options.endpoints || [
        `${API_BASE}/api/${encodeURIComponent(action)}`,
        `${API_BASE}/${encodeURIComponent(action)}`,
        `${API_BASE}?action=${encodeURIComponent(action)}`,
        API_BASE
      ];
      let lastError;
      for (const url of endpoints) {
        try {
          const response = await fetch(url, {
            method: options.method || "POST",
            headers: buildHeaders(session),
            body: (options.method || "POST") === "GET" ? undefined : JSON.stringify(body),
            cache: "no-store",
            credentials: "omit"
          });
          const data = await safeJson(response);
          if (response.status === 401 || response.status === 403) {
            Portal.clearSession();
            throw new Error(data.message || "Session expired");
          }
          if (response.ok) {
            setStatus(true, "Live");
            return data;
          }
          lastError = new Error(data.message || data.error || `API ${response.status}`);
        } catch (error) {
          lastError = error;
        }
      }
      setStatus(false, "API offline");
      throw lastError || new Error("API request failed");
    },
    async login(role, identity, password) {
      const staffPayload = {
        role,
        identity,
        login_id: identity,
        loginId: identity,
        staff_id: identity,
        staffId: identity,
        email: identity
      };
      const adminPayload = {
        ...staffPayload,
        admin_id: identity,
        adminId: identity,
        username: identity,
        password,
        pin: password
      };
      const actions = role === "admin"
        ? ["adminLogin", "loginAdmin", "admin_login", "validateAdmin", "authenticateAdmin"]
        : ["staffLogin", "loginStaff", "staff_login", "validateStaff", "authenticateStaff"];
      let lastError;
      for (const action of actions) {
        try {
          const data = await this.call(action, role === "admin" ? adminPayload : staffPayload, { endpoints: [API_BASE] });
          if (data?.error && /invalid action/i.test(String(data.error))) {
            lastError = new Error(data.error);
            continue;
          }
          if (data?.message && /invalid action/i.test(String(data.message))) {
            lastError = new Error(data.message);
            continue;
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
      throw lastError || new Error("Login action is not available");
    },
    async dashboard(role) {
      return this.call(role === "admin" ? "adminDashboard" : "staffDashboard", { role });
    },
    async action(action, payload = {}) { return this.call(action, payload); }
  };

  const getSession = (redirect = true) => {
    try {
      const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      if (!raw) {
        if (redirect && !location.pathname.endsWith("index.html") && !location.pathname.endsWith("/")) location.href = "index.html";
        return null;
      }
      const session = JSON.parse(raw);
      if (!session.createdAt || Date.now() - session.createdAt > MAX_SESSION_AGE) {
        Portal.clearSession();
        if (redirect) location.href = "index.html";
        return null;
      }
      return session;
    } catch (error) {
      Portal.clearSession();
      return null;
    }
  };

  const saveSession = (session, remember) => {
    const data = JSON.stringify({ ...session, createdAt: Date.now() });
    const store = remember ? localStorage : sessionStorage;
    store.setItem(SESSION_KEY, data);
    localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
  };

  const clearSession = () => {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  };

  const normalizeSession = (role, identity, data) => {
    const root = data.user || data.staff || data.admin || data.data || data;
    return {
      role: pick(root, ["role"], role),
      token: pick(root, ["token", "jwt", "accessToken", "sessionToken", "session_id"], pick(data, ["token", "jwt", "accessToken"], "")),
      staffId: pick(root, ["staffId", "staff_id", "id", "email", "username"], identity),
      name: pick(root, ["name", "fullName", "staffName", "displayName"], identity),
      department: pick(root, ["department", "team"], ""),
      raw: root
    };
  };

  const updateClock = () => {
    setText("liveClock", new Date().toLocaleTimeString());
  };

  const bindLogout = () => {
    document.querySelectorAll("[data-logout]").forEach((btn) => {
      btn.addEventListener("click", () => {
        clearSession();
        location.href = "index.html";
      });
    });
  };

  const initLogin = () => {
    const form = document.getElementById("loginForm");
    if (!form) return;
    const existing = getSession(false);
    if (existing?.role === "admin") location.href = "admin.html";
    if (existing?.role === "staff") location.href = "staff.html";
    let role = "staff";
    const title = document.getElementById("loginTitle");
    const alert = document.getElementById("loginAlert");
    const btn = document.getElementById("loginBtn");
    const remember = document.getElementById("remember");
    remember.checked = localStorage.getItem(REMEMBER_KEY) !== "0";

    document.querySelectorAll(".tab-btn").forEach((tab) => {
      tab.addEventListener("click", () => {
        role = tab.dataset.role;
        document.querySelectorAll(".tab-btn").forEach((item) => item.classList.toggle("active", item === tab));
        title.textContent = role === "admin" ? "Admin Login" : "Staff Login";
        syncLoginFields(role);
      });
    });

    document.getElementById("sessionCheck")?.addEventListener("click", () => {
      alert.hidden = false;
      alert.textContent = getSession(false) ? "A valid local session is available." : "No active local session found.";
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      alert.hidden = true;
      btn.classList.add("loading");
      btn.disabled = true;
      try {
        const identity = document.getElementById("identity").value.trim();
        const password = document.getElementById("password").value;
        const data = await api.login(role, identity, password);
        const ok = data.ok !== false && data.success !== false && !data.error;
        if (!ok) throw new Error(data.message || data.error || "Login failed");
        saveSession(normalizeSession(role, identity, data), remember.checked);
        location.href = role === "admin" ? "admin.html" : "staff.html";
      } catch (error) {
        alert.hidden = false;
        alert.textContent = error.message || "Unable to sign in. Check credentials and try again.";
      } finally {
        btn.classList.remove("loading");
        btn.disabled = false;
      }
    });

    syncLoginFields(role);
  };

  const syncLoginFields = (role) => {
    const passwordField = document.getElementById("password");
    const passwordLabel = passwordField?.closest(".field");
    const identityField = document.getElementById("identity");
    if (!passwordField || !passwordLabel || !identityField) return;
    const isAdmin = role === "admin";
    passwordLabel.hidden = !isAdmin;
    passwordField.required = isAdmin;
    passwordField.disabled = !isAdmin;
    identityField.placeholder = isAdmin ? "Admin login ID" : "Login ID or email";
  };

  window.Portal = {
    api,
    SESSION_KEY,
    normalizeArray,
    pick,
    formatTime,
    formatDate,
    percent,
    setText,
    setStatus,
    toast,
    getSession,
    saveSession,
    clearSession,
    bindLogout,
    updateClock
  };

  updateClock();
  setInterval(updateClock, 1000);
  bindLogout();
  initLogin();
})();
