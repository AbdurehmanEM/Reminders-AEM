/* Reminders app.
 * Works straight away on its own: reminders are saved on this device and alerts come from this device.
 * Optional "Connect account" (Supabase) adds sign-in, sync between devices and email reminders. */
(() => {
  const $ = (id) => document.getElementById(id);
  const CAP = window.Capacitor;
  const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());   // Android app
  const LN = NATIVE ? CAP.Plugins.LocalNotifications : null;
  const RA = NATIVE ? CAP.Plugins.ReminderAlarm : null;   // our own full-screen alarm (Android)
  const DESKTOP = !!(window.desktop && window.desktop.isDesktop);             // Windows app
  const APPLIKE = NATIVE || DESKTOP;

  const REPEAT_LABEL = { none: "", daily: "Every day", weekdays: "Weekdays", weekly: "Every week", monthly: "Every month", yearly: "Every year" };
  const LKEY = "LOCAL_REMINDERS";
  const ALARM_CHANNEL = "alarm-v1";
  const NOTES_LOCAL = "LOCAL_NOTES", NOTES_CACHE = "NOTES_CACHE", NOTES_OUTBOX = "NOTES_OUTBOX";
  let notesMissingTable = false;
  const openNotes = new Set();

  // ---------- Configuration: online account is optional ----------
  const isUnset = (c) => !c || !c.SUPABASE_URL || c.SUPABASE_URL.includes("YOUR-PROJECT") || !c.SUPABASE_ANON_KEY;
  let cfg = window.APP_CONFIG;
  let cfgFromConnect = false;
  if (isUnset(cfg)) {
    try { cfg = JSON.parse(localStorage.getItem("APP_CONFIG") || "null"); cfgFromConnect = !isUnset(cfg); } catch { cfg = null; }
  }
  const ONLINE = !isUnset(cfg) && typeof supabase !== "undefined";
  // Sync-only account: reminders are shared between devices, alerts ring on each device, no email server.
  const SERVER = ONLINE && !cfg.SYNC_ONLY;
  const CACHE_KEY = "CLOUD_CACHE";
  const sb = ONLINE ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;

  let user = null;
  let pendingEmail = "";
  let channel = null;

  // ---------- Storage: on this device, or in the online account ----------
  function localAll() { try { return JSON.parse(localStorage.getItem(LKEY) || "[]"); } catch { return []; } }
  function localSave(rows) { localStorage.setItem(LKEY, JSON.stringify(rows)); }

  // Moves repeating reminders forward and marks one-time ones as sent once their alert time passed.
  function localNormalize(rows) {
    const now = Date.now();
    let changed = false;
    for (const r of rows) {
      if (r.done || r.sent_at) continue;
      if (lastFireMs(r, new Date(r.due_at)) > now) continue;
      if (r.repeat === "none") { r.sent_at = new Date().toISOString(); changed = true; continue; }
      const next = occurrences(r.due_at, r.repeat, 800).find((d) => lastFireMs(r, d) > now);
      if (next) { r.due_at = next.toISOString(); changed = true; }
    }
    return changed;
  }

  const store = {
    async list() {
      if (!ONLINE) {
        const rows = localAll();
        if (localNormalize(rows)) localSave(rows);
        return rows.sort((a, b) => a.due_at.localeCompare(b.due_at));
      }
      // Send changes made while offline first, so the fresh list includes them.
      const flushed = await flushOutbox();
      const { data, error } = flushed ? await sb.from("reminders").select("*").order("due_at", { ascending: true }) : { error: { message: "offline" } };
      if (error) {
        // Offline: keep working from this device's copy so alarms still ring.
        const c = cacheAll();
        if (c) { setSyncState(false); if (localNormalize(c)) cacheSave(c); return c.sort((a, b) => a.due_at.localeCompare(b.due_at)); }
        throw error;
      }
      setSyncState(true);
      if (!SERVER) {
        // No server moves repeating reminders on, so each device does it (both get the same answer).
        const before = new Map(data.map((r) => [r.id, r.due_at + "|" + r.sent_at]));
        if (localNormalize(data)) {
          for (const r of data) {
            if (r.user_id === user?.id && before.get(r.id) !== r.due_at + "|" + r.sent_at) {
              sb.from("reminders").update({ due_at: r.due_at, sent_at: r.sent_at }).eq("id", r.id).then(({ error: e }) => e && console.error(e));
            }
          }
          data.sort((a, b) => a.due_at.localeCompare(b.due_at));
        }
      }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* full */ }
      return data;
    },
    async insert(row) {
      if (!ONLINE) {
        const rows = localAll();
        rows.push({ ...row, id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), sent_at: null, created_at: new Date().toISOString() });
        return localSave(rows);
      }
      // The id is made here so later offline edits can point at it.
      const full = { ...row, id: newId(), user_id: user.id };
      return sendOrQueue({ op: "insert", row: full }, (rows) => rows.push({ ...full, sent_at: null, owner_email: user.email, created_at: new Date().toISOString() }));
    },
    async update(id, patch) {
      if (!ONLINE) {
        const rows = localAll();
        const r = rows.find((x) => x.id === id);
        if (r) {
          if (patch.due_at && patch.due_at !== r.due_at) r.sent_at = null;
          if (patch.alerts !== undefined) r.sent_at = null;
          Object.assign(r, patch);
        }
        return localSave(rows);
      }
      return sendOrQueue({ op: "update", id, patch }, (rows) => {
        const r = rows.find((x) => x.id === id);
        if (r) { if ((patch.due_at && patch.due_at !== r.due_at) || patch.alerts !== undefined) r.sent_at = null; Object.assign(r, patch); }
      });
    },
    async remove(id) {
      if (!ONLINE) return localSave(localAll().filter((x) => x.id !== id));
      return sendOrQueue({ op: "remove", id }, (rows) => { const i = rows.findIndex((x) => x.id === id); if (i >= 0) rows.splice(i, 1); });
    },
  };

  // ---------- Offline changes (account mode) ----------
  // Every change is saved on this device first. If there is no internet it waits in an
  // "outbox" and is sent automatically when the connection comes back.
  const OUTBOX_KEY = "SYNC_OUTBOX";
  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function cacheAll() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; } }
  function cacheSave(rows) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(rows)); } catch { /* full */ } }
  function outbox() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch { return []; } }
  function outboxSave(list) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch { /* full */ } updateSyncTitle(); }
  const isNetErr = (e) => !navigator.onLine || /fetch|network|load failed|timeout|offline|ERR_/i.test((e && (e.message || e.details)) || "") || (e && e.status === 0);

  async function sendOp(o) {
    if (o.op === "insert") return (await sb.from("reminders").upsert(o.row, { onConflict: "id" })).error;
    if (o.op === "update") return (await sb.from("reminders").update(o.patch).eq("id", o.id)).error;
    if (o.op === "remove") return (await sb.from("reminders").delete().eq("id", o.id)).error;
    return null;
  }

  // Apply on this device now; send now if possible, otherwise queue.
  async function sendOrQueue(o, applyLocal) {
    const rows = cacheAll() || [];
    applyLocal(rows); cacheSave(rows);
    if (outbox().length === 0 && navigator.onLine) {
      const err = await sendOp(o).catch((e) => e);
      if (!err) return;
      if (!isNetErr(err)) { load(); throw err; }    // a real problem (not just offline): show it
    }
    outboxSave([...outbox(), o]);
    setSyncState(false);
  }

  let flushing = null;
  async function flushOutbox() {
    if (flushing) return flushing;
    flushing = (async () => {
      let list = outbox();
      while (list.length) {
        if (!navigator.onLine) return false;
        const err = await sendOp(list[0]).catch((e) => e);
        if (err && isNetErr(err)) return false;
        if (err) console.error("Dropped a change the server refused:", err);
        list = list.slice(1); outboxSave(list);
      }
      return true;
    })();
    try { return await flushing; } finally { flushing = null; }
  }
  function updateSyncTitle() {
    if (!ONLINE) return;
    const n = outbox().length;
    $("sync-dot").title = n ? `${n} change${n > 1 ? "s" : ""} waiting for internet` : syncOk ? "Synced" : "Offline: using this device's copy";
    $("sync-wait").hidden = !n;
    $("sync-wait").textContent = n ? `${n} waiting to sync` : "";
  }

  // ---------- Start-up ----------
  let swReg = null;
  if (!APPLIKE && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((r) => { swReg = r; updatePushBanner(); }).catch(console.error);
  }
  if (NATIVE) setupNativeAlarms();

  setupConnectCard();

  $("share-fs").hidden = !ONLINE;
  if (!ONLINE) {
    // Device-only mode: no sign-in, no setup.
    $("login").hidden = true;
    $("account").hidden = false;
    $("who").textContent = "Saved on this device";
    $("signout").hidden = true;
    $("via-fs").hidden = true;
    $("test-desc").textContent = "Shows a test alert on this device in a few seconds.";
    setUser({ id: "local", local: true });
  } else {
    $("use-local").hidden = !cfgFromConnect;
    $("connect-card").hidden = true;
    if (!SERVER) {
      // Sync-only: sign in with email + password, no emails needed.
      $("via-fs").hidden = true;
      $("password-wrap").hidden = false;
      $("password").required = true;
      $("login-btn").textContent = "Sign in";
      $("login-intro").textContent = "Use the same email and password on your laptop and your phone. The first time, this creates your account.";
      $("test-desc").textContent = "Shows a test alert on this device in a few seconds.";
    }
    // Stay signed in when the app opens without internet.
    const lastUser = () => { try { return JSON.parse(localStorage.getItem("LAST_USER") || "null"); } catch { return null; } };
    const signedIn = (u) => { try { localStorage.setItem("LAST_USER", JSON.stringify({ id: u.id, email: u.email })); } catch { /* ignore */ } setUser(u); };
    sb.auth.onAuthStateChange((event, session) => {
      if (session) signedIn(session.user);
      else if (event === "SIGNED_OUT") { localStorage.removeItem("LAST_USER"); setUser(null); }
      else if (!lastUser()) setUser(null);
    });
    sb.auth.getSession().then(({ data }) => {
      if (data.session) signedIn(data.session.user); else setUser(lastUser());
    }).catch(() => setUser(lastUser()));
  }

  function setUser(u) {
    const changed = (u?.id || null) !== (user?.id || null);
    user = u;
    $("login").hidden = !!u;
    $("app").hidden = !u;
    $("account").hidden = !u;
    if (ONLINE) $("who").textContent = u?.email || "";
    if (!changed) return;
    if (channel) { sb.removeChannel(channel); channel = null; }
    if (u) {
      setupSyncCard();
      resetForm();
      (ONLINE ? uploadLocalReminders() : Promise.resolve()).finally(load);
      if (ONLINE) uploadLocalNotes();
      loadNotes();
      updatePushBanner();
      if (ONLINE) {
        // Live sync: when another device changes a reminder, refresh the list.
        channel = sb.channel("reminders-" + u.id)
          // No filter: the database only sends rows this person may see (their own and ones shared with them).
          .on("postgres_changes", { event: "*", schema: "public", table: "reminders" }, load)
          .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, () => {
            // Don't redraw under the cursor while typing in a note.
            if (!document.activeElement || !document.activeElement.closest(".note")) loadNotes();
          })
          .subscribe();
      }
    }
  }

  // After connecting an account, reminders made on this device move into the account.
  async function uploadLocalReminders() {
    const rows = localAll().filter((r) => !r.done && !r.sent_at);
    if (!rows.length) { localStorage.removeItem(LKEY); return; }
    const payload = rows.map(({ id, sent_at, created_at, ...r }) => ({ ...r, user_id: user.id }));
    const { error } = await sb.from("reminders").insert(payload);
    if (!error) localStorage.removeItem(LKEY); else console.error(error);
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && user) { load(); updatePushBanner(); } });
  setInterval(() => { if (user) load(); }, SERVER ? 60 * 60 * 1000 : ONLINE ? 2 * 60 * 1000 : 60 * 1000);
  window.addEventListener("online", () => { if (user) { load(); loadNotes(); } });
  // Heartbeat: a gap means the computer was asleep, so check for missed alerts straight away.
  if (!NATIVE) setInterval(() => {
    const last = Number(localStorage.getItem("LAST_CHECK") || 0);
    if (user && last && Date.now() - last > 90000) load();
    else try { localStorage.setItem("LAST_CHECK", String(Date.now())); } catch { /* ignore */ }
  }, 30000);

  // ---------- Sign-in (only with a connected account) ----------
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    pendingEmail = $("email").value.trim();
    if (!SERVER) return passwordSignIn(pendingEmail, $("password").value);
    $("login-msg").textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({
      email: pendingEmail,
      options: { emailRedirectTo: APPLIKE ? cfg.APP_URL : location.origin + location.pathname },
    });
    if (error) { $("login-msg").textContent = error.message; return; }
    $("login-msg").textContent = "Check your email. You can type the code below, or click the link in the email.";
    $("code-form").hidden = false;
    $("code").focus();
  });

  async function passwordSignIn(email, password) {
    if (password.length < 6) { $("login-msg").textContent = "Use a password of at least 6 characters."; return; }
    $("login-msg").textContent = "Signing in…";
    let { error } = await sb.auth.signInWithPassword({ email, password });
    if (!error) { $("login-msg").textContent = ""; return; }
    if (/invalid login/i.test(error.message)) {
      // No account yet (or wrong password): try creating it.
      const up = await sb.auth.signUp({ email, password });
      if (up.error) {
        $("login-msg").textContent = /already registered/i.test(up.error.message) ? "Wrong password for this email. Try again."
          : /database error|not been invited/i.test(up.error.message)
            ? "This email hasn't been invited yet. Ask the person who gave you the app to send you a reminder first (that invites your email), then try again."
            : up.error.message;
        return;
      }
      if (up.data.session) { $("login-msg").textContent = ""; return; }
      $("login-msg").textContent = "Account created, but Supabase wants the email confirmed. In Supabase turn off \"Confirm email\" (step 3 of the sync guide), or click the link in the email from Supabase, then press Sign in again.";
      return;
    }
    $("login-msg").textContent = error.message;
  }

  $("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token: $("code").value.trim(), type: "email" });
    $("login-msg").textContent = error ? error.message : "";
  });

  $("signout").addEventListener("click", async () => {
    const waiting = outbox().length;
    if (waiting && !confirm(`${waiting} change(s) made offline haven't synced yet and will be lost if you sign out now. Sign out anyway?`)) return;
    for (const k of [OUTBOX_KEY, CACHE_KEY, "LAST_USER", NOTES_CACHE, NOTES_OUTBOX]) localStorage.removeItem(k);
    await unsubscribePushOnThisDevice();
    await clearAlerts();
    await sb.auth.signOut();
  });

  $("use-local").addEventListener("click", stopSync);
  async function stopSync() {
    if (!confirm("Stop syncing on this device? Your reminders stay in your account; this device goes back to keeping its own list.")) return;
    try {
      // Keep a copy of the current reminders on this device.
      const rows = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
      if (rows.length) localSave(rows.filter((r) => !r.done));
      if (sb) await sb.auth.signOut();
    } catch (e) { console.error(e); }
    localStorage.removeItem("APP_CONFIG"); localStorage.removeItem(CACHE_KEY);
    location.reload();
  }

  // ---------- Sync status and sync code ----------
  function makeSyncCode(c) {
    const j = JSON.stringify({ u: c.SUPABASE_URL, k: c.SUPABASE_ANON_KEY });
    return "RS1-" + btoa(unescape(encodeURIComponent(j))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function readSyncCode(code) {
    const m = code.replace(/\s+/g, "").match(/^RS1-([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    try {
      const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")))));
      // Only accept a secure (https) project address.
      return j.u && j.k && /^https:\/\/[a-z0-9.-]+$/i.test(j.u) ? { SUPABASE_URL: j.u, SUPABASE_ANON_KEY: j.k, SYNC_ONLY: true } : null;
    } catch { return null; }
  }
  let syncOk = null;
  function setSyncState(ok) {
    if (!ONLINE || syncOk === ok) return;
    syncOk = ok;
    $("sync-dot").hidden = false;
    $("sync-dot").className = "sync-dot " + (ok ? "on" : "off");
    updateSyncTitle();
  }
  function setupSyncCard() {
    if (!ONLINE || !cfgFromConnect) return;
    $("sync-card").hidden = false;
    const code = makeSyncCode(cfg);
    $("sync-code").value = code;
    $("sync-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(code); } catch { $("sync-code").select(); document.execCommand("copy"); }
      $("sync-msg").textContent = "Copied. Paste it into the app on your phone.";
    };
    $("sync-mail").href = "mailto:" + encodeURIComponent(user?.email || "") + "?subject=" + encodeURIComponent("Reminders sync code") +
      "&body=" + encodeURIComponent("Paste this into the Reminders app on your phone, under \"Sync laptop and phone\":\n\n" + code);
    $("sync-stop").onclick = stopSync;
  }

  // ---------- Optional: connect an online account ----------
  function setupConnectCard() {
    if (ONLINE) return;
    $("connect-card").hidden = false;
    $("connect-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const first = $("connect-url").value.trim();
      const key = $("connect-key").value.trim();
      $("connect-msg").textContent = "Connecting…";
      try {
        let c = readSyncCode(first);
        if (!c && /supabase\.(co|in)/i.test(first)) {
          // Supabase Project URL + publishable key.
          if (!key) throw new Error("Also paste the publishable (anon) key.");
          c = { SUPABASE_URL: first.replace(/\/+$/, "").replace(/\/rest\/v1$/, ""), SUPABASE_ANON_KEY: key, SYNC_ONLY: true };
          if (!/^https?:\/\//i.test(c.SUPABASE_URL)) c.SUPABASE_URL = "https://" + c.SUPABASE_URL;
          if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(c.SUPABASE_URL)) throw new Error("The Project URL should look like https://xxxx.supabase.co");
        }
        if (!c) c = await configFromAppAddress(first).catch(() => {
          throw new Error("That doesn't look like a sync code or a Supabase Project URL (https://xxxx.supabase.co).");
        });
        if (isUnset(c)) throw new Error("That doesn't look like a sync code or a Supabase Project URL.");
        // Check the project answers and the reminders table exists.
        const res = await fetch(c.SUPABASE_URL + "/rest/v1/reminders?select=id&limit=1", { headers: { apikey: c.SUPABASE_ANON_KEY } });
        if (res.status === 404 || res.status === 400) throw new Error("The project has no reminders table yet. Run the setup SQL (step 2 of the sync guide).");
        if (res.status === 401 || res.status === 403) {
          const t = await res.text();
          if (/api key|apikey|jwt/i.test(t) && !/permission/i.test(t)) throw new Error("The key was not accepted. Copy the publishable (anon) key again.");
        }
        localStorage.setItem("APP_CONFIG", JSON.stringify(c));
        location.reload();
      } catch (err) {
        $("connect-msg").textContent = "Could not connect: " + (err.message || err);
      }
    });
  }

  // Older way: an app address whose config.js holds the account settings.
  async function configFromAppAddress(input) {
    let addr = input.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(addr)) addr = (/^(localhost|127\.|192\.168\.|10\.)/.test(addr) ? "http://" : "https://") + addr;
    const res = DESKTOP ? await window.desktop.fetchText(addr + "/config.js")
      : NATIVE ? await CAP.Plugins.CapacitorHttp.get({ url: addr + "/config.js", responseType: "text" })
      : await fetch(addr + "/config.js").then(async (r) => ({ status: r.status, data: await r.text() }));
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const pick = (k) => (text.match(new RegExp(k + '\\s*:\\s*["\']([^"\']+)["\']')) || [])[1];
    const c = { SUPABASE_URL: pick("SUPABASE_URL"), SUPABASE_ANON_KEY: pick("SUPABASE_ANON_KEY"), VAPID_PUBLIC_KEY: pick("VAPID_PUBLIC_KEY"), APP_URL: addr };
    if (res.status !== 200 || isUnset(c)) throw new Error("No account settings found at that address.");
    return c;
  }

  // ---------- Work plan & notes ----------
  // Saved on this device first; with an account they sync like reminders (and wait offline).
  function jget(k, d) { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } }

  function notesAll() { return jget(ONLINE ? NOTES_CACHE : NOTES_LOCAL, []); }
  function notesSaveAll(rows) { jset(ONLINE ? NOTES_CACHE : NOTES_LOCAL, rows); }
  function notesRetry(e) { return isNetErr(e) || /notes|schema cache|PGRST205|42P01|does not exist/i.test((e && (e.message || e.code)) || ""); }

  async function notesSend(o) {
    if (o.op === "upsert") return (await sb.from("notes").upsert(o.row, { onConflict: "id" })).error;
    if (o.op === "delete") return (await sb.from("notes").delete().eq("id", o.id)).error;
    return null;
  }
  async function notesFlush() {
    let list = jget(NOTES_OUTBOX, []);
    while (list.length) {
      if (!navigator.onLine) return false;
      const err = await notesSend(list[0]).catch((e) => e);
      if (err && notesRetry(err)) { notesMissingTable = !isNetErr(err); return false; }
      if (err) console.error("Dropped a note change the server refused:", err);
      // Several saves of the same note: only the newest is needed.
      list = jget(NOTES_OUTBOX, []).slice(1); jset(NOTES_OUTBOX, list);
    }
    return true;
  }
  async function notesQueue(o) {
    if (!ONLINE) return;
    let list = jget(NOTES_OUTBOX, []);
    if (o.op === "upsert") list = list.filter((x) => !(x.op === "upsert" && x.row.id === o.row.id));
    list.push(o); jset(NOTES_OUTBOX, list);
    await notesFlush();
    notesHint();
  }
  function notesHint() {
    $("notes-hint").hidden = !notesMissingTable;
  }

  async function loadNotes() {
    if (ONLINE && user) {
      if (await notesFlush()) {
        const { data, error } = await sb.from("notes").select("*").order("updated_at", { ascending: false });
        if (!error) { notesMissingTable = false; notesSaveAll(data); }
        else notesMissingTable = !isNetErr(error);
      }
      notesHint();
    }
    renderNotes();
  }

  function saveNote(n) {
    n.updated_at = new Date().toISOString();
    const rows = notesAll(); const i = rows.findIndex((x) => x.id === n.id);
    if (i >= 0) rows[i] = n; else rows.unshift(n);
    notesSaveAll(rows);
    const row = { id: n.id, title: n.title, body: n.body, items: n.items, updated_at: n.updated_at };
    if (ONLINE && user) row.user_id = user.id;
    notesQueue({ op: "upsert", row });
  }
  const saveSoon = (() => { const t = {}; return (n) => { clearTimeout(t[n.id]); t[n.id] = setTimeout(() => saveNote(n), 600); }; })();

  function deleteNote(n) {
    if (!confirm(`Delete the note "${n.title || "Untitled"}"?`)) return;
    notesSaveAll(notesAll().filter((x) => x.id !== n.id));
    notesQueue({ op: "delete", id: n.id });
    renderNotes();
  }

  $("new-note").addEventListener("click", () => {
    const n = { id: newId(), title: "", body: "", items: [], updated_at: new Date().toISOString() };
    openNotes.add(n.id);
    saveNote(n); renderNotes();
    const t = document.querySelector(`[data-note="${n.id}"] .note-title`); if (t) t.focus();
  });

  // Turn a task into a reminder: fills in the reminder form.
  function taskToReminder(text, noteTitle) {
    resetForm();
    $("r-title").value = text;
    $("r-notes").value = noteTitle ? "From work plan: " + noteTitle : "";
    $("reminder-form").scrollIntoView({ behavior: "smooth" });
    setTimeout(() => $("r-date").focus(), 300);
  }

  function renderNotes() {
    const box = $("notes-list"); box.innerHTML = "";
    const rows = notesAll().sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    $("notes-empty").hidden = rows.length > 0;
    for (const n of rows) {
      n.items = Array.isArray(n.items) ? n.items : [];
      const d = document.createElement("details"); d.className = "note"; d.dataset.note = n.id; d.open = openNotes.has(n.id);
      d.addEventListener("toggle", () => { if (d.open) openNotes.add(n.id); else openNotes.delete(n.id); });
      const sum = document.createElement("summary");
      const left = n.items.filter((x) => !x.done).length;
      const st = document.createElement("span"); st.className = "note-sum"; st.textContent = n.title || "Untitled note";
      const cnt = document.createElement("span"); cnt.className = "note-count"; cnt.textContent = n.items.length ? `${n.items.length - left}/${n.items.length} done` : "";
      sum.append(st, cnt); d.append(sum);

      const title = document.createElement("input"); title.className = "note-title"; title.placeholder = "Title, e.g. Monday work plan"; title.maxLength = 200; title.value = n.title || "";
      title.oninput = () => { n.title = title.value; st.textContent = n.title || "Untitled note"; saveSoon(n); };
      const body = document.createElement("textarea"); body.rows = 3; body.maxLength = 20000; body.placeholder = "Write your notes here…"; body.value = n.body || "";
      body.oninput = () => { n.body = body.value; saveSoon(n); };

      const ul = document.createElement("ul"); ul.className = "tasks";
      const drawTasks = () => {
        ul.innerHTML = "";
        n.items.forEach((it, idx) => {
          const li = document.createElement("li"); if (it.done) li.className = "done";
          const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!it.done;
          cb.onchange = () => { it.done = cb.checked; li.className = it.done ? "done" : ""; const l = n.items.filter((x) => !x.done).length; cnt.textContent = `${n.items.length - l}/${n.items.length} done`; saveNote(n); };
          const tx = document.createElement("input"); tx.className = "task-text"; tx.value = it.text || ""; tx.maxLength = 300;
          tx.oninput = () => { it.text = tx.value; saveSoon(n); };
          const rem = document.createElement("button"); rem.type = "button"; rem.className = "secondary mini"; rem.textContent = "⏰"; rem.title = "Make this a reminder";
          rem.onclick = () => taskToReminder(it.text, n.title);
          const del = document.createElement("button"); del.type = "button"; del.className = "danger mini"; del.textContent = "✕"; del.title = "Remove task";
          del.onclick = () => { n.items.splice(idx, 1); saveNote(n); drawTasks(); cnt.textContent = n.items.length ? `${n.items.filter((x) => x.done).length}/${n.items.length} done` : ""; };
          li.append(cb, tx, rem, del); ul.append(li);
        });
      };
      drawTasks();
      const add = document.createElement("form"); add.className = "add-task";
      const addIn = document.createElement("input"); addIn.placeholder = "+ Add a task and press Enter"; addIn.maxLength = 300;
      add.append(addIn);
      add.onsubmit = (e) => {
        e.preventDefault(); const v = addIn.value.trim(); if (!v) return;
        n.items.push({ text: v, done: false }); addIn.value = ""; saveNote(n); drawTasks();
        cnt.textContent = `${n.items.filter((x) => x.done).length}/${n.items.length} done`; addIn.focus();
      };
      const foot = document.createElement("div"); foot.className = "note-foot";
      const when = document.createElement("span"); when.className = "muted"; when.textContent = n.updated_at ? "Edited " + new Date(n.updated_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      const delN = document.createElement("button"); delN.type = "button"; delN.className = "danger mini"; delN.textContent = "Delete note";
      delN.onclick = () => deleteNote(n);
      foot.append(when, delN);
      d.append(title, body, ul, add, foot);
      box.append(d);
    }
  }

  // After connecting an account, notes made on this device move into the account.
  function uploadLocalNotes() {
    const rows = jget(NOTES_LOCAL, []);
    if (!rows.length) return;
    for (const n of rows) saveNote(n);
    localStorage.removeItem(NOTES_LOCAL);
  }

  // ---------- Reminders list ----------
  async function load() {
    let data;
    try { data = await store.list(); } catch (e) { console.error(e); return; }
    const now = Date.now();
    const isUpcoming = (r) => !r.done && (!r.sent_at || lastFireMs(r, new Date(r.due_at)) > now);
    const upcoming = data.filter(isUpcoming);
    const past = data.filter((r) => !isUpcoming(r)).reverse();
    render($("list"), upcoming, true);
    render($("past"), past, false);
    $("empty").hidden = upcoming.length > 0;
    if (!ONLINE || APPLIKE) scheduleAlerts(data).catch(console.error);
  }

  function render(ul, items, editable) {
    ul.innerHTML = "";
    for (const r of items) {
      const li = document.createElement("li");
      li.className = "item";
      const slots = slotsOf(r);
      const when = slots.length > 1
        ? new Date(r.due_at).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" }) +
          (r.mode === "range" && r.range ? ` · Every ${BEFORE_LABEL(r.range.every)} from ${fmtMin(r.range.from)} to ${fmtMin(r.range.to)}` : "")
        : new Date(r.due_at).toLocaleString([], { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const via = SERVER ? [r.notify_email && "email", r.notify_push && "notification"].filter(Boolean).join(" + ") : "";
      const al = alertsOf(r);
      const early = (al.length > 1 || al[0]) ? "Alerts: " + al.map((m) => (m ? BEFORE_LABEL(m) + " before" : "at the time")).join(", ") : "";
      const info = document.createElement("div");
      info.innerHTML = `<div class="t"></div><div class="meta"></div><div class="slot-chips"></div><div class="notes"></div>`;
      if (slots.length > 1) {
        const chips = info.querySelector(".slot-chips");
        const shown = slots.length > 12 ? slots.slice(0, 11) : slots;
        for (const m of shown) { const c = document.createElement("span"); c.textContent = fmtMin(m); chips.append(c); }
        if (slots.length > 12) { const c = document.createElement("span"); c.textContent = `+${slots.length - 11} more`; chips.append(c); }
      }
      info.querySelector(".t").textContent = r.title;
      const fromOther = isShared(r);
      const shareTxt = fromOther ? "From " + (r.owner_email || "someone else")
        : (Array.isArray(r.shared_with) && r.shared_with.length ? "Also reminds " + r.shared_with.join(", ") : "");
      info.querySelector(".meta").textContent = [when, REPEAT_LABEL[r.repeat], early, via, shareTxt].filter(Boolean).join(" · ");
      if (fromOther) li.classList.add("shared");
      info.querySelector(".notes").textContent = r.notes || "";
      const btns = document.createElement("div");
      btns.className = "btns";
      if (editable && !fromOther) {
        const edit = document.createElement("button");
        edit.className = "secondary"; edit.textContent = "Edit";
        edit.onclick = () => startEdit(r);
        btns.append(edit);
      }
      if (!r.done && !fromOther) {
        const done = document.createElement("button");
        done.className = "secondary"; done.textContent = r.repeat === "none" ? "Done" : "Stop";
        done.title = r.repeat === "none" ? "Mark as done" : "Stop repeating";
        done.onclick = async () => {
          try { await store.update(r.id, { done: true }); load(); } catch (e) { alert(e.message); }
        };
        btns.append(done);
      }
      if (fromOther) {
        const leave = document.createElement("button");
        leave.className = "danger"; leave.textContent = "Remove";
        leave.title = "Stop getting this reminder";
        leave.onclick = async () => {
          if (!confirm(`Stop getting "${r.title}" from ${r.owner_email || "this person"}?`)) return;
          const { error } = await sb.rpc("leave_reminder", { rid: r.id });
          if (error) alert(error.message); else load();
        };
        btns.append(leave);
        li.append(info, btns); ul.append(li); continue;
      }
      const del = document.createElement("button");
      del.className = "danger"; del.textContent = "Delete";
      del.onclick = async () => {
        if (!confirm(`Delete "${r.title}"?`)) return;
        try { await store.remove(r.id); load(); } catch (e) { alert(e.message); }
      };
      btns.append(del);
      li.append(info, btns);
      ul.append(li);
    }
  }

  function isShared(r) { return ONLINE && user && r.user_id && r.user_id !== user.id; }
  function parseEmails(text) {
    const list = (text || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const bad = list.filter((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    return { list: [...new Set(list)].filter((x) => x !== (user?.email || "").toLowerCase()), bad };
  }

  // Alert offsets (minutes before the time) for a reminder, largest first.
  function alertsOf(r) {
    const a = Array.isArray(r.alerts) && r.alerts.length ? r.alerts : [r.remind_before_min || 0];
    return [...new Set(a.map(Number))].sort((x, y) => y - x);
  }
  function lastAlertMs(r) { return Math.min(...alertsOf(r)) * 60000; }
  function alertBoxes() { return [...document.querySelectorAll('input[name="alert"]')]; }

  // Times of day (minutes after midnight) a reminder rings on each of its days.
  function slotsOf(r) {
    if (Array.isArray(r.slots) && r.slots.length) return r.slots.map(Number).sort((a, b) => a - b);
    const d = new Date(r.due_at);
    return [d.getHours() * 60 + d.getMinutes()];
  }
  function atSlot(day, m) { const d = new Date(day); d.setHours(Math.floor(m / 60), m % 60, 0, 0); return d; }
  // When the very last alert of that day goes off.
  function lastFireMs(r, day) { const s = slotsOf(r); return atSlot(day, s[s.length - 1]).getTime() - lastAlertMs(r); }
  function toMin(hhmm) { const [h, m] = (hhmm || "").split(":").map(Number); return isNaN(h) ? null : h * 60 + (m || 0); }
  function toHHMM(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
  function fmtMin(m) { const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function rangeSlots(from, to, every) {
    const out = [];
    if (from == null || to == null || !every) return out;
    for (let m = from; m <= to && out.length < 96; m += every) out.push(m);
    return out;
  }

  function BEFORE_LABEL(m) {
    if (m % 1440 === 0) return m / 1440 + (m === 1440 ? " day" : " days");
    if (m % 60 === 0) return m / 60 + (m === 60 ? " hour" : " hours");
    return m + " min";
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function resetForm() {
    $("r-id").value = "";
    $("r-title").value = "";
    $("r-notes").value = "";
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    $("r-date").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    $("r-time").value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $("r-repeat").value = "none";
    $("times-list").innerHTML = "";
    $("r-from").value = "09:00"; $("r-to").value = "17:00"; $("r-every").value = "60";
    setMode("once");
    updateDateText();
    alertBoxes().forEach((b) => { b.checked = b.value === "0"; });
    $("r-email").checked = SERVER;
    $("r-push").checked = true;
    $("r-share").value = "";
    $("form-title").textContent = "New reminder";
    $("save-btn").textContent = "Save reminder";
    $("cancel-edit").hidden = true;
  }

  function startEdit(r) {
    const d = new Date(r.due_at);
    $("r-id").value = r.id;
    $("r-title").value = r.title;
    $("r-notes").value = r.notes || "";
    $("r-date").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    $("r-time").value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $("r-repeat").value = r.repeat;
    $("times-list").innerHTML = "";
    const mode = r.mode && slotsOf(r).length > 1 ? r.mode : (slotsOf(r).length > 1 ? "several" : "once");
    if (mode === "several") slotsOf(r).forEach((m) => addTimeRow(toHHMM(m)));
    if (mode === "range" && r.range) { $("r-from").value = toHHMM(r.range.from); $("r-to").value = toHHMM(r.range.to); $("r-every").value = String(r.range.every); }
    setMode(mode);
    updateDateText();
    const al = alertsOf(r).map(String);
    alertBoxes().forEach((b) => { b.checked = al.includes(b.value); });
    $("r-email").checked = SERVER && r.notify_email;
    $("r-push").checked = r.notify_push;
    $("r-share").value = (r.shared_with || []).join(", ");
    $("form-title").textContent = "Edit reminder";
    $("save-btn").textContent = "Save changes";
    $("cancel-edit").hidden = false;
    $("reminder-form").scrollIntoView({ behavior: "smooth" });
  }

  function addTimeRow(value) {
    const row = document.createElement("div");
    row.className = "time-row";
    const input = document.createElement("input");
    input.type = "time"; input.className = "t-slot"; input.value = value || "";
    const del = document.createElement("button");
    del.type = "button"; del.className = "danger"; del.textContent = "✕"; del.title = "Remove this time";
    del.onclick = () => { row.remove(); if (!document.querySelector(".t-slot")) addTimeRow(""); };
    row.append(input, del);
    $("times-list").append(row);
    return input;
  }

  // Date shown like "Saturday, November 21" on the date pill.
  function updateDateText() {
    const v = $("r-date").value;
    const d = v ? new Date(v + "T12:00") : null;
    $("date-text").textContent = d && !isNaN(d) ? d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) : "Pick a date";
  }
  $("r-date").addEventListener("input", updateDateText);
  $("r-date").addEventListener("change", updateDateText);
  $("r-date").addEventListener("click", (e) => { try { e.target.showPicker(); } catch { /* older browsers open it themselves */ } });

  function setMode(mode) {
    $("r-mode").value = mode;
    $("mode-once").hidden = mode !== "once";
    $("mode-several").hidden = mode !== "several";
    $("mode-range").hidden = mode !== "range";
    $("mode-range-times").hidden = mode !== "range";
    if (mode === "several" && !document.querySelector(".t-slot")) {
      const first = toMin($("r-time").value) ?? 8 * 60;
      addTimeRow(toHHMM(first));
      addTimeRow(toHHMM(Math.min(first + 4 * 60, 23 * 60 + 59)));
    }
    updateRangePreview();
  }

  function updateRangePreview() {
    $("range-preview").hidden = $("r-mode").value !== "range";
    const slots = rangeSlots(toMin($("r-from").value), toMin($("r-to").value), Number($("r-every").value));
    $("range-preview").textContent = slots.length
      ? `Rings ${slots.length} time${slots.length > 1 ? "s" : ""} a day: ` + (slots.length > 8 ? slots.slice(0, 7).map(fmtMin).join(", ") + ` … ${fmtMin(slots[slots.length - 1])}` : slots.map(fmtMin).join(", "))
      : "Pick a start hour and an end hour.";
  }

  $("r-mode").addEventListener("change", () => setMode($("r-mode").value));
  $("add-time").addEventListener("click", () => addTimeRow("").focus());
  ["r-from", "r-to", "r-every"].forEach((id) => $(id).addEventListener("input", updateRangePreview));

  $("cancel-edit").addEventListener("click", resetForm);

  $("reminder-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = $("r-mode").value;
    let slots;
    if (mode === "once") slots = [toMin($("r-time").value)].filter((m) => m != null);
    else if (mode === "several") slots = [...new Set([...document.querySelectorAll(".t-slot")].map((i) => toMin(i.value)).filter((m) => m != null))].sort((a, b) => a - b);
    else {
      const from = toMin($("r-from").value), to = toMin($("r-to").value);
      if (from == null || to == null || to < from) { alert("Please pick a start hour and an end hour that comes after it."); return; }
      slots = rangeSlots(from, to, Number($("r-every").value));
    }
    if (!slots.length) { alert("Please pick at least one time."); return; }
    const when = new Date(`${$("r-date").value}T${toHHMM(slots[0])}`);
    if (isNaN(when)) { alert("Please pick a valid date and time."); return; }
    const lastToday = new Date(`${$("r-date").value}T${toHHMM(slots[slots.length - 1])}`);
    if (SERVER && !$("r-email").checked && !$("r-push").checked) { alert("Choose email, notification, or both."); return; }
    if (lastToday < new Date() && $("r-repeat").value === "none" && !confirm("That time is in the past. Save anyway?")) return;
    let alerts = alertBoxes().filter((b) => b.checked).map((b) => Number(b.value)).sort((x, y) => y - x);
    if (!alerts.length) alerts = [0];
    const row = {
      title: $("r-title").value.trim(),
      notes: $("r-notes").value.trim() || null,
      due_at: when.toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      repeat: $("r-repeat").value,
      mode,
      slots: mode === "once" ? null : slots,
      range: mode === "range" ? { from: toMin($("r-from").value), to: toMin($("r-to").value), every: Number($("r-every").value) } : null,
      alerts,
      // The email (with an account) goes out at the last alert, closest to the time.
      remind_before_min: Math.min(...alerts),
      notify_email: SERVER && $("r-email").checked,
      notify_push: SERVER ? $("r-push").checked : true,
      done: false,
    };
    if (ONLINE) {
      const sh = parseEmails($("r-share").value);
      if (sh.bad.length) { alert("This doesn't look like an email address: " + sh.bad.join(", ")); return; }
      if (sh.list.length || $("r-id").value) row.shared_with = sh.list;
    }
    $("save-btn").disabled = true;
    const id = $("r-id").value;
    try {
      if (id) await store.update(id, row); else await store.insert(row);
    } catch (err) {
      $("save-btn").disabled = false;
      alert(/shared_with/.test(err.message || "")
        ? "Sending to other people needs one more setup step: run 003_sharing.sql in Supabase (see SHARING-GUIDE.md)."
        : err.message);
      return;
    }
    $("save-btn").disabled = false;
    resetForm();
    load();
    if (row.notify_push) updatePushBanner(true);
  });

  // ---------- Notification permission banner ----------
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;

  async function currentSubscription() {
    if (!swReg || !swReg.pushManager) return null;
    return swReg.pushManager.getSubscription();
  }

  async function updatePushBanner(nudge = false) {
    if (!user) return;
    const banner = $("notify-banner");
    if (NATIVE) return updateNativeBanner(banner, nudge);
    if (DESKTOP) { banner.hidden = true; return; }
    if (!("Notification" in window)) { banner.hidden = true; return; }
    if (Notification.permission === "denied") {
      $("notify-text").textContent = "Notifications are blocked for this site. Allow them in your browser's site settings to get alerts on this device.";
      $("enable-push").hidden = true;
      banner.hidden = false;
      return;
    }
    if (!SERVER) {
      // Device-only web mode: alerts appear while this page or installed app is open.
      if (Notification.permission === "granted") { banner.hidden = true; return; }
    } else {
      if (!pushSupported) {
        if (isIOS && !isStandalone) {
          $("notify-text").textContent = "On iPhone/iPad: tap the Share button, then \"Add to Home Screen\". Open the app from your home screen to turn on notifications.";
          $("enable-push").hidden = true;
          banner.hidden = false;
        } else banner.hidden = true;
        return;
      }
      const sub = await currentSubscription();
      if (sub && Notification.permission === "granted") {
        await saveSubscription(sub);
        banner.hidden = true;
        return;
      }
    }
    $("notify-text").textContent = "Turn on notifications on this device so it can alert you.";
    $("enable-push").hidden = false;
    banner.hidden = false;
    if (nudge) banner.scrollIntoView({ behavior: "smooth" });
  }

  function urlBase64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function saveSubscription(sub) {
    const j = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert({
      user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      device: navigator.userAgent.slice(0, 300),
    }, { onConflict: "endpoint" });
    if (error) console.error(error);
  }

  $("enable-push").addEventListener("click", async () => {
    if (NATIVE) return; // handled in updateNativeBanner
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { updatePushBanner(); return; }
      if (SERVER && cfg.VAPID_PUBLIC_KEY) {
        const reg = swReg || (await navigator.serviceWorker.ready);
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY) });
        }
        await saveSubscription(sub);
      }
      notifyNow("Notifications are on", "This device will now alert you about your reminders.");
      updatePushBanner();
      load();
    } catch (err) {
      console.error(err);
      alert("Could not turn on notifications: " + err.message);
    }
  });

  async function unsubscribePushOnThisDevice() {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
    } catch (e) { console.error(e); }
  }

  // ---------- Test button ----------
  $("test-btn").addEventListener("click", async () => {
    const btn = $("test-btn");
    btn.disabled = true;
    const where = NATIVE ? "phone" : "computer";
    if (NATIVE) {
      RA.test({ title: "⏰ Test reminder", body: "If you can hear this, alarms work. Press Stop." }).catch(console.error);
    } else {
      setTimeout(() => fireAlert("⏰ Test reminder", "If you can hear this, alerts work. Tap Stop."), 3000);
    }
    if (!SERVER) {
      $("test-msg").textContent = `A test alarm will ring on this ${where} in a few seconds.`;
      btn.disabled = false;
      return;
    }
    $("test-msg").textContent = "Sending…";
    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch(cfg.SUPABASE_URL + "/functions/v1/send-reminders?test=1", {
        method: "POST",
        headers: { Authorization: "Bearer " + session.access_token, apikey: cfg.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: "{}",
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || res.statusText);
      $("test-msg").textContent = APPLIKE
        ? `Email: ${out.email}. A test alert will appear on this ${where} in a few seconds.`
        : `Email: ${out.email}. Notifications sent to ${out.push} device(s).`;
    } catch (err) {
      $("test-msg").textContent = "Email test failed: " + err.message + ` (the alert on this ${where} still works).`;
    } finally { btn.disabled = false; }
  });

  // ---------- Alerts raised by this device ----------
  function notifyNow(title, body) {
    try {
      if (DESKTOP || !swReg) {
        const n = new Notification(title, { body, icon: "icon-192.png", requireInteraction: true });
        n.onclick = () => { if (DESKTOP) window.desktop.show(); else window.focus(); };
      } else {
        swReg.showNotification(title, { body, icon: "icon-192.png", badge: "icon-192.png", requireInteraction: true });
      }
    } catch (e) { console.error(e); }
  }

  async function updateNativeBanner(banner, nudge) {
    const perm = await LN.checkPermissions();
    let exact = "granted";
    try { exact = (await LN.checkExactNotificationSetting()).exact_alarm; } catch { /* not needed */ }
    if (perm.display !== "granted") {
      $("notify-text").textContent = "Allow notifications so this phone can alert you.";
      $("enable-push").textContent = "Allow notifications";
      $("enable-push").hidden = false; $("enable-push").onclick = async () => { await LN.requestPermissions(); lastSig = ""; load(); updatePushBanner(); };
      banner.hidden = false;
    } else if (exact !== "granted") {
      $("notify-text").textContent = "Allow \"Alarms & reminders\" so alerts arrive exactly on time.";
      $("enable-push").textContent = "Open setting";
      $("enable-push").hidden = false; $("enable-push").onclick = async () => { await LN.changeExactNotificationSetting(); updatePushBanner(); };
      banner.hidden = false;
    } else {
      const st = await RA.status().catch(() => ({ overlay: true, fullScreen: true }));
      if (!st.overlay) {
        $("notify-text").textContent = "Allow \"Display over other apps\" so the alarm pops up on top of whatever you are using. Find Reminders in the list and switch it on.";
        $("enable-push").textContent = "Open setting";
        $("enable-push").hidden = false; $("enable-push").onclick = () => RA.openOverlaySettings();
        banner.hidden = false;
      } else if (!st.fullScreen) {
        $("notify-text").textContent = "Allow full-screen alarms so the alarm shows on the lock screen.";
        $("enable-push").textContent = "Open setting";
        $("enable-push").hidden = false; $("enable-push").onclick = () => RA.openFullScreenSettings();
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    }
    if (nudge && !banner.hidden) banner.scrollIntoView({ behavior: "smooth" });
  }

  function occurrences(baseIso, rep, count) {
    const base = new Date(baseIso), out = [base];
    if (rep === "none") return out;
    if (rep === "weekdays" && (base.getDay() === 0 || base.getDay() === 6)) out.pop();  // weekend start date: begin on Monday
    let d = new Date(base);
    for (let k = 1; out.length < count && k < 5000; k++) {
      if (rep === "daily") { d = new Date(base); d.setDate(base.getDate() + k); }
      else if (rep === "weekly") { d = new Date(base); d.setDate(base.getDate() + 7 * k); }
      else if (rep === "weekdays") { d = new Date(d); do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
      else if (rep === "monthly" || rep === "yearly") {
        const months = rep === "monthly" ? k : 12 * k;
        d = new Date(base); d.setDate(1); d.setMonth(base.getMonth() + months);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(base.getDate(), last));
      }
      out.push(d);
    }
    return out;
  }

  function prevOccurrence(iso, rep) {
    const d = new Date(iso);
    if (rep === "daily") d.setDate(d.getDate() - 1);
    else if (rep === "weekly") d.setDate(d.getDate() - 7);
    else if (rep === "weekdays") { do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else if (rep === "monthly") d.setMonth(d.getMonth() - 1);
    else if (rep === "yearly") d.setFullYear(d.getFullYear() - 1);
    return d;
  }

  function notifId(key) {
    let h = 7;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h) % 2000000000 + 1000000;
  }

  let timers = [];
  let lastSig = "";

  async function clearAlerts() {
    timers.forEach(clearTimeout); timers = []; lastSig = "";
    if (NATIVE) {
      await RA.setAlarms({ alarms: [] }).catch(console.error);
      const pending = await LN.getPending();  // alerts left by older versions of the app
      const keep = pending.notifications.filter((n) => n.id !== 999999 && n.id < 900000000);
      if (keep.length) await LN.cancel({ notifications: keep.map((n) => ({ id: n.id })) });
    }
  }

  async function scheduleAlerts(rows) {
    if (NATIVE && (await LN.checkPermissions()).display !== "granted") return;
    const now = Date.now(), list = [], missed = [];
    // Computer: alerts whose time passed while the computer was asleep or the app was closed (last 12 hours).
    let lastCheck = Number(localStorage.getItem("LAST_CHECK") || 0);
    if (!lastCheck || NATIVE) lastCheck = now;
    lastCheck = Math.max(lastCheck, now - 12 * 3600000);
    for (const r of rows) {
      if (r.done || !r.notify_push) continue;
      const slots = slotsOf(r);
      const days = r.repeat === "none" ? 1 : Math.max(2, Math.min(12, Math.ceil(48 / slots.length)));
      const daysList = occurrences(r.due_at, r.repeat, days);
      // A repeating reminder has already moved on to its next day, so look at the previous one for missed alerts.
      if (!NATIVE && r.repeat !== "none") daysList.unshift(prevOccurrence(r.due_at, r.repeat));
      for (const day of daysList) {
        for (const slot of slots) {
          const fire = atSlot(day, slot);
          const whenTxt = fire.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          for (const m of alertsOf(r)) {
            const at = fire.getTime() - m * 60000;
            if (at <= now) { if (at > lastCheck) missed.push({ title: r.title, whenTxt, m, at }); continue; }
            list.push(alarmNotification(notifId(r.id + "|" + fire.toISOString() + "|" + m), "⏰ " + r.title,
              (m ? "In " + BEFORE_LABEL(m) + " · " : "Now · ") + whenTxt + (r.notes ? "\n" + r.notes : ""), new Date(at)));
          }
        }
      }
    }
    list.sort((a, b) => a.schedule.at - b.schedule.at);
    if (DESKTOP && window.desktop.upcoming) {
      const seen = new Set(), next = [];
      for (const n of list) { if (next.length >= 5) break; if (seen.has(n.title)) continue; seen.add(n.title); next.push({ title: n.title.replace(/^⏰\s*/, ""), at: n.schedule.at.getTime() }); }
      window.desktop.upcoming(next);
    }
    if (!NATIVE) {
      try { localStorage.setItem("LAST_CHECK", String(now)); } catch { /* ignore */ }
      if (missed.length) {
        missed.sort((a, b) => a.at - b.at);
        const lines = missed.slice(-8).map((x) => `• ${x.title} (${x.m ? BEFORE_LABEL(x.m) + " before " : ""}${x.whenTxt})`);
        if (missed.length === 1) fireAlert("⏰ " + missed[0].title, "Missed while the computer was asleep · " + missed[0].whenTxt);
        else fireAlert(`⏰ ${missed.length} missed reminders`, "While the computer was asleep:\n" + lines.join("\n"));
        lastSig = "";   // rebuild timers so none of these ring twice
      }
    }
    const sig = list.map((n) => n.id + ":" + n.schedule.at.getTime()).join(",");
    if (sig === lastSig) return;   // nothing changed since last time
    await clearAlerts();
    lastSig = sig;
    if (NATIVE) {
      await RA.setAlarms({ alarms: list.slice(0, 400).map((n) => ({ id: n.id, at: n.schedule.at.getTime(), title: n.title, body: n.body })) });
      return;
    }
    // Computer / browser: timers while the app is running (the Windows app keeps running in the tray).
    const limit = 20 * 86400000;
    for (const n of list) {
      const wait = n.schedule.at.getTime() - Date.now();
      const at = n.schedule.at.getTime();
      if (wait > 0 && wait < limit) timers.push(setTimeout(() => {
        // A timer that fires very late means the computer slept: the catch-up in load() rings it instead.
        if (Date.now() - at > 2 * 60000) { load(); return; }
        try { localStorage.setItem("LAST_CHECK", String(Date.now())); } catch { /* ignore */ }
        fireAlert(n.title, n.body); load();
      }, wait));
    }
  }

  // ---------- Ringing alarm (plays until Stop or Snooze) ----------
  function alarmNotification(id, title, body, at) {
    return { id, title, body, channelId: ALARM_CHANNEL, sound: "alarm_long.ogg", actionTypeId: "ALARM",
             autoCancel: true, schedule: { at, allowWhileIdle: true } };
  }

  async function setupNativeAlarms() {
    // Alarms are handled by the app's own Android code (full screen, over other apps, rings until Stop).
  }

  function fireAlert(title, body) {
    if (!DESKTOP) notifyNow(title, body);
    ringAlarm(title, body);
  }

  let ringing = null;
  function ringAlarm(title, body) {
    ringing = { title, body };
    $("alarm-title").textContent = title.replace(/^⏰\s*/, "");
    $("alarm-body").textContent = body || "";
    $("alarm").hidden = false;
    const audio = $("alarm-audio");
    audio.currentTime = 0;
    audio.play().catch((e) => console.warn("sound blocked", e));
    if (DESKTOP && window.desktop.alarm) window.desktop.alarm(true);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  }

  function stopAlarm() {
    $("alarm-audio").pause();
    $("alarm").hidden = true;
    if (DESKTOP && window.desktop.alarm) window.desktop.alarm(false);
    const r = ringing; ringing = null;
    return r;
  }

  function snooze(title, body) {
    const at = new Date(Date.now() + 10 * 60000);
    const label = /snoozed/i.test(body || "") ? body : "Snoozed · " + (body || "");
    if (NATIVE) {
      /* Android snoozes inside the native alarm window */
    } else {
      setTimeout(() => fireAlert(title, label), at - Date.now());
    }
  }

  $("alarm-stop").addEventListener("click", stopAlarm);
  $("alarm-snooze").addEventListener("click", () => { const r = stopAlarm(); if (r) snooze(r.title, r.body); });
})();
