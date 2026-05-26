(function () {
  const API_BASE = "https://staff-portal-api-v2.mdrobiulislam.workers.dev";
  const SESSION_KEY = "staffPortalV2.session";
  const REMEMBER_KEY = "staffPortalV2.remember";
  const CLIENT_IP_KEY = "staffPortalV2.clientIp";
  const MAX_SESSION_AGE = 12 * 60 * 60 * 1000;

  const safeJson = async (response) => {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (error) { return { ok: response.ok, raw: text }; }
  };

  const withTimeout = (ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { controller, timer };
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
        const timeout = withTimeout(options.timeoutMs || 15000);
        try {
          const response = await fetch(url, {
            method: options.method || "POST",
            headers: buildHeaders(session),
            body: (options.method || "POST") === "GET" ? undefined : JSON.stringify(body),
            cache: "no-store",
            credentials: "omit",
            signal: timeout.controller.signal
          });
          clearTimeout(timeout.timer);
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
          clearTimeout(timeout.timer);
          lastError = error;
        }
      }
      setStatus(false, "API offline");
      throw lastError || new Error("API request failed");
    },
    async detectIp(forceRefresh = false) {
      const cached = localStorage.getItem(CLIENT_IP_KEY);
      if (!forceRefresh && cached) return cached;
      const actions = ["clientIp", "getClientIp", "ipStatus", "checkIp", "getIp"];
      for (const action of actions) {
        try {
          const data = await this.call(action, {}, { endpoints: [API_BASE], timeoutMs: 3500 });
          const ip = pick(data?.data || data, ["ip", "clientIp", "client_ip", "requestIp", "request_ip", "address", "ipAddress"], "");
          if (ip && !/invalid action/i.test(String(data?.message || data?.error || ""))) {
            localStorage.setItem(CLIENT_IP_KEY, ip);
            return ip;
          }
        } catch (error) {
          if (/abort/i.test(String(error.message))) break;
          if (!/invalid action/i.test(String(error.message))) break;
        }
      }
      try {
        const timeout = withTimeout(3500);
        const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
          cache: "no-store",
          credentials: "omit",
          signal: timeout.controller.signal
        });
        clearTimeout(timeout.timer);
        if (!response.ok) return "";
        const trace = await response.text();
        const line = trace.split("\n").find((item) => item.startsWith("ip="));
        const ip = line ? line.slice(3).trim() : "";
        if (ip) localStorage.setItem(CLIENT_IP_KEY, ip);
        return ip;
      } catch (error) {
        return "";
      }
      return "";
    },
    async login(role, identity, password, attemptedIp = "") {
      const staffPayload = {
        role,
        identity,
        login_id: identity,
        loginId: identity,
        staff_id: identity,
        staffId: identity,
        email: identity,
        ip: attemptedIp,
        ipAddress: attemptedIp,
        request_ip: attemptedIp,
        requestIp: attemptedIp,
        attempted_ip: attemptedIp,
        client_ip: attemptedIp,
        ip_address: attemptedIp
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
        ? ["admin_login"]
        : ["staff_login"];
      let lastError;
      for (const action of actions) {
        try {
          const data = await this.call(action, role === "admin" ? adminPayload : staffPayload, { endpoints: [API_BASE], timeoutMs: 6000 });
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
      const actions = role === "admin"
        ? ["get_admin_dashboard"]
        : ["get_staff_dashboard"];
      const session = Portal.getSession(false);
      const ip = await this.detectIp();
      const payload = {
        role,
        ip,
        login_id: session?.loginId || session?.staffId || "",
        admin_login_id: session?.loginId || session?.staffId || "",
        month: new Date().toISOString().slice(0, 7)
      };
      let lastError;
      for (const action of actions) {
        try {
          const data = await this.call(action, payload, { endpoints: [API_BASE], timeoutMs: 10000 });
          if (data?.error && /invalid action/i.test(String(data.error))) {
            lastError = new Error(data.error);
            continue;
          }
          if (data?.message && /invalid action/i.test(String(data.message))) {
            lastError = new Error(data.message);
            continue;
          }
          if (data?.ok === false) throw new Error(data.message || data.error || "Dashboard request failed");
          return data;
        } catch (error) {
          if (/invalid action/i.test(String(error.message))) {
            lastError = error;
            continue;
          }
          throw error;
        }
      }
      throw lastError || new Error("Dashboard action is not available");
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

  const normalizeSession = (role, identity, data, ip = "") => {
    const root = data.user || data.staff || data.admin || data.data || data;
    return {
      role,
      accountRole: pick(root, ["role"], role),
      token: pick(root, ["token", "jwt", "accessToken", "sessionToken", "session_id"], pick(data, ["token", "jwt", "accessToken"], "")),
      staffId: pick(root, ["staffId", "staff_id", "id", "email", "username"], identity),
      loginId: pick(root, ["login_id", "loginId", "username", "email"], identity),
      name: pick(root, ["name", "fullName", "staffName", "displayName"], identity),
      department: pick(root, ["department", "team"], ""),
      ip,
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
    api.detectIp();

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
      let attemptedIp = "";
      try {
        const identity = document.getElementById("identity").value.trim();
        const password = document.getElementById("password").value;
        attemptedIp = await api.detectIp(true);
        const data = await api.login(role, identity, password, attemptedIp);
        const ok = data.ok !== false && data.success !== false && !data.error;
        if (!ok) {
          if (/ip not allowed|not allowed/i.test(String(data.message || data.error || ""))) attemptedIp = await api.detectIp();
          throw new Error(formatLoginError(data, attemptedIp));
        }
        saveSession(normalizeSession(role, identity, data, attemptedIp), remember.checked);
        location.href = role === "admin" ? "admin.html" : "staff.html";
      } catch (error) {
        if (/ip not allowed|not allowed/i.test(String(error.message)) && !attemptedIp) attemptedIp = await api.detectIp();
        alert.hidden = false;
        alert.textContent = formatLoginError(error, attemptedIp);
      } finally {
        btn.classList.remove("loading");
        btn.disabled = false;
      }
    });

    syncLoginFields(role);
  };

  const formatLoginError = (source, fallbackIp = "") => {
    const data = source?.data || source;
    const message = pick(data, ["message", "error"], source?.message || "Unable to sign in. Check credentials and try again.");
    const ip = pick(data, ["ip", "clientIp", "client_ip", "requestIp", "request_ip", "attemptedIp", "attempted_ip", "ipAddress"], fallbackIp);
    if (/Trying IP:/i.test(String(message))) return message;
    if (/ip not allowed|not allowed/i.test(String(message))) {
      return ip ? `${message}. Trying IP: ${ip}` : `${message}. Could not detect browser IP.`;
    }
    return message;
  };

  const syncLoginFields = (role) => {
    const passwordField = document.getElementById("password");
    const passwordLabel = document.getElementById("passwordField") || passwordField?.closest(".field");
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
    CLIENT_IP_KEY,
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
