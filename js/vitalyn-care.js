/* ============================================================================
   Vitalyn — Care tools
   Adds three features to the existing app without touching the React bundle:
     1. Medication reminders (schedule, due alerts, adherence)
     2. Emergency SOS with a loud alarm siren
     3. Hospital reports organised into folders

   Everything lives in its own DOM root with a .vc- prefix, so React never
   sees it and nothing here depends on the bundle's internals.
   Logic is split into plain objects (Meds / Alarm / Reports) so it can be
   lifted into React components when the source is rebuilt.
   ========================================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- utils */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    (Array.isArray(kids) ? kids : kids ? [kids] : []).forEach((c) =>
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    );
    return n;
  };
  const pad = (n) => String(n).padStart(2, "0");
  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const minsNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const toMins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const to12h = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const ap = h < 12 ? "AM" : "PM";
    return `${((h + 11) % 12) + 1}:${pad(m)} ${ap}`;
  };
  const bytes = (b) => b < 1024 ? b + " B"
    : b < 1048576 ? (b / 1024).toFixed(0) + " KB"
    : (b / 1048576).toFixed(1) + " MB";

  const ago = (ts) => {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 3) return "just now";
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return Math.floor(s / 86400) + " d ago";
  };

  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem("vitalyn." + k); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem("vitalyn." + k, JSON.stringify(v)); } catch (e) { /* quota */ }
    },
  };

  let toastTimer = null;
  function toast(msg) {
    let t = $(".vc-toast");
    if (!t) { t = el("div", { class: "vc-toast", role: "status" }); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* ------------------------------------------------------- 2. alarm engine */
  /* A siren synthesised with Web Audio — no audio file to ship or fail to load.
     Browsers require a user gesture before audio can start; the SOS press is
     that gesture, so this is safe. */
  const Alarm = {
    ctx: null, osc: null, gain: null, sweep: null, buzz: null,

    _context() {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        this.ctx = new Ctx();
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },

    /** Loud alternating two-tone siren + repeating vibration. */
    start() {
      const ctx = this._context();
      if (!ctx || this.osc) return false;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      const comp = ctx.createDynamicsCompressor();   // keeps it loud without clipping
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(740, ctx.currentTime);
      osc.connect(gain); gain.connect(comp); comp.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.85, ctx.currentTime + 0.06);

      let high = false;
      this.sweep = setInterval(() => {
        high = !high;
        osc.frequency.setTargetAtTime(high ? 1180 : 740, ctx.currentTime, 0.015);
      }, 460);

      if (navigator.vibrate) {
        const buzz = () => navigator.vibrate([700, 250, 700, 250]);
        buzz(); this.buzz = setInterval(buzz, 1900);
      }
      this.osc = osc; this.gain = gain;
      return true;
    },

    stop() {
      clearInterval(this.sweep); clearInterval(this.buzz);
      this.sweep = this.buzz = null;
      if (navigator.vibrate) navigator.vibrate(0);
      if (this.osc && this.ctx) {
        try {
          this.gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.12);
          this.osc.stop(this.ctx.currentTime + 0.15);
        } catch (e) { /* already stopped */ }
      }
      this.osc = null; this.gain = null;
    },

    /** Softer two-note chime used for medication reminders. */
    chime() {
      const ctx = this._context();
      if (!ctx) return;
      [0, 0.22].forEach((offset, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = i === 0 ? 880 : 1174;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
        g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + offset + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.45);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + offset); o.stop(ctx.currentTime + offset + 0.5);
      });
    },
  };

  /* -------------------------------------------------- 1. medication module */
  const Meds = {
    list: store.get("meds", []),
    log: store.get("medlog", {}),
    alerted: {},          // doseKeys already announced this session
    queued: {},           // doseKeys already handed to the service worker
    soundOn: store.get("medsound", true),

    save() { store.set("meds", this.list); store.set("medlog", this.log); },

    add(name, dose, times) {
      this.list.push({ id: "m" + Date.now(), name, dose, times });
      this.save();
    },
    remove(id) {
      this.list = this.list.filter((m) => m.id !== id);
      this.save();
    },

    /** Flattened schedule for today, sorted by time. */
    today() {
      const day = this.log[todayKey()] || {};
      const now = minsNow();
      const out = [];
      this.list.forEach((m) =>
        m.times.forEach((t) => {
          const key = m.id + "@" + t;
          const mins = toMins(t);
          let state = day[key] || (mins > now ? "upcoming" : (now - mins <= 60 ? "due" : "missed"));
          out.push({ med: m, time: t, mins, key, state });
        })
      );
      return out.sort((a, b) => a.mins - b.mins);
    },

    /** Clears a dose back to its natural state (due / missed / upcoming). */
    unmark(key) {
      const d = todayKey();
      if (this.log[d]) { delete this.log[d][key]; this.save(); }
    },

    mark(key, state) {
      const d = todayKey();
      this.log[d] = this.log[d] || {};
      this.log[d][key] = state;
      this.save();
    },

    next() {
      const now = minsNow();
      return this.today().filter((d) => d.mins > now && d.state === "upcoming")[0] || null;
    },

    adherence() {
      const t = this.today().filter((d) => d.state !== "upcoming");
      if (!t.length) return null;
      return Math.round((t.filter((d) => d.state === "taken").length / t.length) * 100);
    },

    /** Ask the service worker to post the notification. It can fire while the
        tab is backgrounded, which a page timer cannot. */
    schedule() {
      if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
      if (!window.Notification || Notification.permission !== "granted") return;
      const now = Date.now();
      this.today().forEach((d) => {
        if (d.state !== "upcoming" || this.queued[d.key]) return;
        const when = new Date(); when.setHours(0, 0, 0, 0);
        const at = when.getTime() + d.mins * 60000;
        if (at <= now) return;
        this.queued[d.key] = true;
        navigator.serviceWorker.controller.postMessage({
          type: "vitalyn-remind", at, tag: d.key,
          title: `Time for ${d.med.name}`,
          body: `${d.med.dose} — scheduled for ${to12h(d.time)}`,
        });
      });
    },

    /** Called on a timer; fires a notification + chime the moment a dose is due. */
    check() {
      this.today().forEach((d) => {
        if (d.state !== "due" || this.alerted[d.key]) return;
        this.alerted[d.key] = true;
        const title = `Time for ${d.med.name}`;
        const body = `${d.med.dose} — scheduled for ${to12h(d.time)}`;
        if (window.Notification && Notification.permission === "granted") {
          try { new Notification(title, { body, tag: d.key }); } catch (e) { /* iOS */ }
        }
        if (this.soundOn) Alarm.chime();
        toast(title);
        Shell.flagDot(true);
      });
    },
  };

  /* ----------------------------------------------------- 3. reports module */
  const DEFAULT_FOLDERS = ["Lab Reports", "Prescriptions", "Scans & Imaging", "Discharge Summaries"];
  /* ------------------------------------------------- emergency contacts ---
     Pressing SOS should reach people, not just make noise. Contacts live on
     the device; the message carries the risk level and a location link. */
  /* Pre-loaded so the alarm reaches someone the moment the app is installed.
     Editable and removable like any other contact. */
  const DEFAULT_CONTACTS = [
    { id: "c-default-1", name: "Aadil Ahmed", phone: "+919710904959" },
    { id: "c-default-2", name: "Niyas", phone: "+918637623766" },
    { id: "c-default-3", name: "Noohu", phone: "+917845392506" },
  ];

  const Contacts = {
    list: store.get("contacts", null) || DEFAULT_CONTACTS.slice(),
    save() { store.set("contacts", this.list); },
    add(name, phone) {
      this.list.push({ id: "c" + Date.now(), name: name.trim(), phone: phone.replace(/\s+/g, "") });
      this.save();
    },
    remove(id) { this.list = this.list.filter((c) => c.id !== id); this.save(); },
  };

  const Alert = {
    lastReport: [],
    lastSentAt: 0,

    practice() { return !!store.get("practice", 0); },
    setPractice(on) { store.set("practice", on ? 1 : 0); },

    /** Best-effort location. Never blocks the alarm for more than 6 seconds. */
    position() {
      return new Promise((res) => {
        if (!navigator.geolocation) return res(null);
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; res(v); } };
        setTimeout(() => done(null), 6000);
        navigator.geolocation.getCurrentPosition(
          (p) => done({ lat: p.coords.latitude, lon: p.coords.longitude }),
          () => done(null),
          { enableHighAccuracy: true, timeout: 5500, maximumAge: 60000 }
        );
      });
    },

    compose(pos) {
      const L = window.VitalynBLE && window.VitalynBLE.Link;
      const bits = ["EMERGENCY - Vitalyn alert."];
      const who = store.get("patientName", "");
      bits.push(who ? who + " may need help." : "The person carrying this phone may need help.");
      if (L && L.status === "connected") {
        const d = L.data, v = [];
        if (d.bpm != null) v.push("HR " + d.bpm);
        if (d.spo2 != null) v.push("SpO2 " + d.spo2 + "%");
        if (d.temp != null) v.push("Temp " + d.temp.toFixed(1) + "C");
        if (v.length) bits.push("Vitals: " + v.join(", ") + ".");
      }
      bits.push(pos
        ? "Location: https://maps.google.com/?q=" + pos.lat.toFixed(5) + "," + pos.lon.toFixed(5)
        : "Location unavailable.");
      bits.push("Sent automatically by Vitalyn (demonstration prototype).");
      return bits.join(" ");
    },

    native() {
      const N = window.VitalynNativeBLE;
      return N && typeof N.sendSms === "function" ? N : null;
    },

    /** Fires the alerts. Returns a per-contact report for the UI. */
    async send() {
      const report = [];
      if (!Contacts.list.length) {
        this.lastReport = [{ name: "No contacts saved", status: "skipped" }];
        return this.lastReport;
      }
      /* Repeated presses while testing should not fire repeated real texts. */
      if (Date.now() - this.lastSentAt < 60000) {
        this.lastReport = Contacts.list.map((c) => ({
          name: c.name, phone: c.phone, status: "skipped (alerted <1 min ago)" }));
        return this.lastReport;
      }

      const pos = await this.position();
      const body = this.compose(pos);
      const N = this.native();

      if (this.practice()) {
        this.lastSentAt = Date.now();
        this.message = body;
        this.lastReport = Contacts.list.map((c) => ({
          name: c.name, phone: c.phone, status: "practice mode - not sent" }));
        return this.lastReport;
      }

      if (N && N.canSendSms && N.canSendSms()) {
        Contacts.list.forEach((c) => {
          let err = "";
          try { err = N.sendSms(c.phone, body); } catch (e) { err = "failed"; }
          report.push({ name: c.name, phone: c.phone, status: err ? "failed: " + err : "sent" });
        });
      } else {
        // No permission, or a browser: hand off to the messaging app with
        // everything pre-filled. The user still has to press send.
        const numbers = Contacts.list.map((c) => c.phone).join(",");
        const sep = /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent) ? "&" : "?";
        try {
          window.location.href = "sms:" + numbers + sep + "body=" + encodeURIComponent(body);
          Contacts.list.forEach((c) =>
            report.push({ name: c.name, phone: c.phone, status: "opened in Messages" }));
        } catch (e) {
          Contacts.list.forEach((c) =>
            report.push({ name: c.name, phone: c.phone, status: "could not open Messages" }));
        }
        if (N && N.requestSmsPermission) N.requestSmsPermission();
      }
      this.lastReport = report;
      this.lastSentAt = Date.now();
      this.message = body;
      return report;
    },
  };

  const Reports = {
    db: null,
    folders: store.get("folders", DEFAULT_FOLDERS.slice()),
    current: store.get("folder", DEFAULT_FOLDERS[0]),

    open() {
      return new Promise((res, rej) => {
        if (this.db) return res(this.db);
        const rq = indexedDB.open("vitalyn-reports", 1);
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains("files")) {
            const s = db.createObjectStore("files", { keyPath: "id" });
            s.createIndex("folder", "folder", { unique: false });
          }
        };
        rq.onsuccess = () => { this.db = rq.result; res(this.db); };
        rq.onerror = () => rej(rq.error);
      });
    },

    async put(file, folder) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").add({
          id: "f" + Date.now() + Math.random().toString(36).slice(2, 7),
          folder, name: file.name, type: file.type || "application/octet-stream",
          size: file.size, added: Date.now(), blob: file,
        });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    },

    async all() {
      const db = await this.open();
      return new Promise((res, rej) => {
        const rq = db.transaction("files").objectStore("files").getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
    },

    async remove(id) {
      const db = await this.open();
      return new Promise((res) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").delete(id);
        tx.oncomplete = res;
      });
    },

    async move(id, folder) {
      const db = await this.open();
      return new Promise((res) => {
        const tx = db.transaction("files", "readwrite");
        const st = tx.objectStore("files");
        const rq = st.get(id);
        rq.onsuccess = () => { const r = rq.result; if (r) { r.folder = folder; st.put(r); } };
        tx.oncomplete = res;
      });
    },

    saveFolders() { store.set("folders", this.folders); store.set("folder", this.current); },
  };

  /* ------------------------------------------------------------ 1. render */
  function renderMeds(root) {
    root.textContent = "";
    const schedule = Meds.today();
    const next = Meds.next();
    const adh = Meds.adherence();

    /* hero: live countdown to the next dose — the thing you actually open this for */
    const clock = el("div", { class: "vc-next-clock" }, "--:--");
    const hero = el("div", { class: "vc-next" }, [
      clock,
      el("div", { class: "vc-next-meta" }, next
        ? [
            el("span", { class: "vc-next-label" }, "Next dose in"),
            el("span", { class: "vc-next-name" }, next.med.name),
            el("span", { class: "vc-next-sub" }, `${next.med.dose} · ${to12h(next.time)}`),
          ]
        : [
            el("span", { class: "vc-next-label" }, "Next dose"),
            el("span", { class: "vc-next-name" }, schedule.length ? "Nothing left today" : "No medication added"),
            el("span", { class: "vc-next-sub" },
              schedule.length ? "The schedule resets at midnight." : "Add one below to start reminders."),
          ]),
    ]);
    const tick = () => {
      if (!next) { clock.textContent = "--:--"; return; }
      const d = new Date(); const secs = next.mins * 60 - (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
      if (secs <= 0) { clock.textContent = "00:00"; return; }
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
      clock.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    };
    tick(); clearInterval(root._tick); root._tick = setInterval(tick, 1000);
    root.appendChild(hero);

    /* today's doses */
    const listCard = el("div", { class: "vc-card vc-stack" });
    listCard.appendChild(el("div", { class: "vc-row" }, [
      el("span", { class: "vc-eyebrow" }, "Today's doses"),
      el("span", { class: "vc-head-spacer" }),
      adh !== null ? el("span", { class: "vc-muted" }, `${adh}% taken so far`) : el("span"),
    ]));

    if (!schedule.length) {
      listCard.appendChild(el("div", { class: "vc-empty" }, "No medication scheduled. Add one below and reminders start straight away."));
    } else {
      schedule.forEach((d) => {
        const cls = "vc-dose" + (d.state === "due" ? " is-due" : d.state === "taken" ? " is-taken" : d.state === "missed" ? " is-missed" : "");
        const actions = el("div", { class: "vc-row" });
        if (d.state === "taken") {
          actions.appendChild(el("span", { class: "vc-pill vc-pill-taken" }, "Taken"));
          // marking the wrong dose is easy; let it be undone
          actions.appendChild(el("button", {
            class: "vc-btn vc-btn-ghost vc-btn-sm",
            onclick: () => { Meds.unmark(d.key); renderMeds(root); toast("Undone"); },
          }, "Undo"));
        } else {
          actions.appendChild(el("span", { class: "vc-pill vc-pill-" + d.state }, d.state));
          actions.appendChild(el("button", {
            class: "vc-btn vc-btn-ghost vc-btn-sm",
            onclick: () => { Meds.mark(d.key, "taken"); Shell.flagDot(false); renderMeds(root); toast("Marked as taken"); },
          }, "Mark taken"));
        }
        listCard.appendChild(el("div", { class: cls }, [
          el("span", { class: "vc-dose-time" }, to12h(d.time)),
          el("div", { class: "vc-dose-body" }, [
            el("div", { class: "vc-dose-name" }, d.med.name),
            el("div", { class: "vc-dose-sub" }, d.med.dose),
          ]),
          actions,
        ]));
      });
    }
    root.appendChild(listCard);

    /* add a medication */
    const name = el("input", { class: "vc-input", placeholder: "e.g. Metformin", "aria-label": "Medication name" });
    const dose = el("input", { class: "vc-input", placeholder: "e.g. 500 mg, after food", "aria-label": "Dose" });
    const times = el("input", { class: "vc-input", value: "08:00, 20:00", "aria-label": "Times, comma separated" });
    const addCard = el("div", { class: "vc-card vc-stack" }, [
      el("span", { class: "vc-eyebrow" }, "Add a medication"),
      el("div", { class: "vc-row" }, [
        el("label", { class: "vc-field" }, [el("span", { class: "vc-label" }, "Name"), name]),
        el("label", { class: "vc-field" }, [el("span", { class: "vc-label" }, "Dose"), dose]),
        el("label", { class: "vc-field" }, [el("span", { class: "vc-label" }, "Times (24h, comma separated)"), times]),
      ]),
      el("div", { class: "vc-row" }, [
        el("button", {
          class: "vc-btn vc-btn-primary",
          onclick: () => {
            const t = times.value.split(",").map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
            if (!name.value.trim()) return toast("Give the medication a name");
            if (!t.length) return toast("Add at least one time, like 08:00");
            Meds.add(name.value.trim(), dose.value.trim() || "—", t);
            name.value = ""; dose.value = "";
            renderMeds(root); toast("Medication added");
          },
        }, "Add medication"),
        el("button", {
          class: "vc-btn vc-btn-ghost",
          onclick: async () => {
            if (!window.Notification) return toast("This browser has no notification support");
            const p = await Notification.requestPermission();
            toast(p === "granted" ? "Notifications on" : "Notifications blocked in browser settings");
          },
        }, "Enable notifications"),
      ]),
    ]);
    root.appendChild(addCard);

    /* saved medication + honest limitation */
    if (Meds.list.length) {
      const saved = el("div", { class: "vc-card vc-stack" }, [el("span", { class: "vc-eyebrow" }, "Saved medication")]);
      Meds.list.forEach((m) => saved.appendChild(el("div", { class: "vc-dose" }, [
        el("div", { class: "vc-dose-body" }, [
          el("div", { class: "vc-dose-name" }, m.name),
          el("div", { class: "vc-dose-sub" }, `${m.dose} · ${m.times.map(to12h).join(", ")}`),
        ]),
        el("button", {
          class: "vc-btn vc-btn-danger vc-btn-sm",
          onclick: () => { Meds.remove(m.id); renderMeds(root); toast("Removed"); },
        }, "Remove"),
      ])));
      root.appendChild(saved);
    }

    root.appendChild(el("p", { class: "vc-note" },
      "Reminders fire while Vitalyn is open in this browser tab. For alerts when the app is closed or the phone is locked, this needs the native app or push notifications — a web page can't wake itself up."));
  }

  /* The siren has two presentations. Fired from this panel it takes over the
     screen; fired from the app's own SOS controls it shows a compact bar so
     the underlying screen stays visible. */
  const SirenUI = {
    timer: null, secs: 0,
    show(mode) {
      const live = $(".vc-alarm-live"), bar = $(".vc-alarm-bar");
      if (mode === "full") live.hidden = false; else bar.hidden = false;
      this.secs = 0;
      const paint = () => {
        const s = `${Math.floor(this.secs / 60)}:${pad(this.secs % 60)}`;
        $(".vc-alarm-count", live).textContent = s;
        $(".vc-alarm-bar-sub", bar).textContent = s + " \u00b7 siren + vibration";
      };
      paint();
      clearInterval(this.timer);
      this.timer = setInterval(() => { this.secs += 1; paint(); }, 1000);
    },
    /** Lists each contact and whether the message actually went out. */
    report(rows) {
      const box = $(".vc-alarm-report");
      if (!box) return;
      box.textContent = "";
      rows.forEach((r) => {
        const ok = r.status === "sent";
        box.appendChild(el("div", { class: "vc-alarm-row" }, [
          el("span", {}, r.name),
          el("strong", { style: ok ? "" : "opacity:.85" }, r.status),
        ]));
      });
    },

    hide() {
      clearInterval(this.timer); this.timer = null;
      $(".vc-alarm-live").hidden = true;
      $(".vc-alarm-bar").hidden = true;
    },
  };

  function triggerAlarm(mode) {
    if (Alarm.osc) return true;                 // already sounding
    const started = Alarm.start();
    if (!started && !Alarm.osc) { toast("This browser blocked audio playback"); return false; }
    SirenUI.show(mode);
    // Siren and messages go out together: noise helps whoever is nearby,
    // the message reaches whoever is not.
    Alert.send().then((report) => {
      SirenUI.report(report);
      const sent = report.filter((r) => r.status === "sent").length;
      if (sent) toast("Alert sent to " + sent + " contact" + (sent > 1 ? "s" : ""));
      else if (report[0] && report[0].status === "skipped") toast("No emergency contacts saved");
    }).catch(() => {});
    return true;
  }

  function stopAlarm() {
    if (!Alarm.osc && !SirenUI.timer) return;
    Alarm.stop();
    SirenUI.hide();
    toast("Alarm stopped");
  }

  /* ------------------------------------------------------------ 2. render */
  function renderSOS(root) {
    root.textContent = "";
    const live = $(".vc-alarm-live");

    const btn = el("button", { class: "vc-sos-btn", "aria-label": "Sound the emergency alarm" }, [
      el("span", { class: "vc-sos-ring", "aria-hidden": "true" }),
      el("span", {}, "SOS"),
      el("small", {}, "Tap once to sound it"),
    ]);
    btn.addEventListener("click", () => triggerAlarm("full"));

    root.appendChild(el("div", { class: "vc-card vc-sos-wrap" }, [
      el("span", { class: "vc-eyebrow" }, "Emergency alarm"),
      el("p", { class: "vc-muted", style: "max-width:34ch;text-align:center" },
        "Sounds a loud siren on this device and vibrates, so someone nearby can find you."),
      btn,
      el("button", {
        class: "vc-btn vc-btn-ghost",
        onclick: () => { Alarm.chime(); toast("That's the reminder chime, not the alarm"); },
      }, "Test the reminder sound"),
    ]));

    /* ---- who gets told ---- */
    const nameIn = el("input", { class: "vc-input", placeholder: "e.g. Amma", "aria-label": "Contact name" });
    const numIn = el("input", { class: "vc-input", type: "tel", placeholder: "+91 98765 43210", "aria-label": "Phone number" });
    const contactCard = el("div", { class: "vc-card vc-stack" }, [
      el("div", { class: "vc-row" }, [
        el("span", { class: "vc-eyebrow" }, "Emergency contacts"),
        el("span", { class: "vc-head-spacer" }),
        el("span", { class: "vc-muted" },
          Contacts.list.length ? Contacts.list.length + " saved" : "none yet"),
      ]),
    ]);
    if (!Contacts.list.length) {
      contactCard.appendChild(el("div", { class: "vc-empty" },
        "Nobody will be messaged until you add a contact."));
    }
    Contacts.list.forEach((c) => {
      contactCard.appendChild(el("div", { class: "vc-contact" }, [
        el("div", { class: "vc-contact-body" }, [
          el("div", { class: "vc-contact-name" }, c.name),
          el("div", { class: "vc-contact-num" }, c.phone),
        ]),
        el("button", {
          class: "vc-btn vc-btn-danger vc-btn-sm",
          onclick: () => { Contacts.remove(c.id); renderSOS(root); toast("Contact removed"); },
        }, "Remove"),
      ]));
    });
    contactCard.appendChild(el("div", { class: "vc-row" }, [
      el("label", { class: "vc-field" }, [el("span", { class: "vc-label" }, "Name"), nameIn]),
      el("label", { class: "vc-field" }, [el("span", { class: "vc-label" }, "Phone"), numIn]),
      el("button", {
        class: "vc-btn vc-btn-primary",
        onclick: () => {
          if (!nameIn.value.trim()) return toast("Give the contact a name");
          if (numIn.value.replace(/\D/g, "").length < 7) return toast("That number looks too short");
          Contacts.add(nameIn.value, numIn.value);
          renderSOS(root); toast("Contact added");
        },
      }, "Add contact"),
    ]));
    root.appendChild(contactCard);

    /* practice switch, so repeated testing doesn't text real people */
    const practiceBtn = el("button", {
      class: "vc-btn " + (Alert.practice() ? "vc-btn-primary" : "vc-btn-ghost"),
      onclick: () => { Alert.setPractice(!Alert.practice()); renderSOS(root);
                       toast(Alert.practice() ? "Practice mode on - nothing will be sent"
                                              : "Live mode - contacts will really be texted"); },
    }, Alert.practice() ? "Practice mode: ON" : "Practice mode: OFF");
    root.appendChild(el("div", { class: "vc-card vc-stack" }, [
      el("div", { class: "vc-row" }, [
        el("span", { class: "vc-eyebrow" }, "Before you demo"),
        el("span", { class: "vc-head-spacer" }),
        practiceBtn,
      ]),
      el("span", { class: "vc-muted" }, Alert.practice()
        ? "The alarm will sound but no message goes out. Turn this off for the real thing."
        : "Pressing SOS sends a real text to every contact above. Turn practice mode on while testing."),
    ]));

    /* what will actually be sent */
    root.appendChild(el("div", { class: "vc-card vc-stack" }, [
      el("span", { class: "vc-eyebrow" }, "The message they will get"),
      el("div", { class: "vc-msg-preview" }, Alert.compose(null)),
      el("span", { class: "vc-muted" },
        "Your live location is added when the alarm fires, if the phone can get a fix."),
    ]));

    /* delivery result from the last alarm */
    if (Alert.lastReport && Alert.lastReport.length) {
      const log = el("div", { class: "vc-card vc-stack" }, [
        el("span", { class: "vc-eyebrow" }, "Last alert"),
      ]);
      Alert.lastReport.forEach((r) => {
        log.appendChild(el("div", { class: "vc-row" }, [
          el("span", {}, r.name),
          el("span", { class: "vc-head-spacer" }),
          el("strong", { class: "vc-muted" }, r.status),
        ]));
      });
      root.appendChild(log);
    }

    root.appendChild(el("p", { class: "vc-note" },
      "The siren plays through your device's normal media volume. A web page cannot override a silent switch or turn the volume up on its own — on iPhone the mute switch will still silence it. A native app can use the alarm channel instead, which is one more reason the wristband build needs to be native."));

  }

  /* ------------------------------------------------------------ 3. render */
  async function renderReports(root) {
    root.textContent = "";
    let files = [];
    try { files = await Reports.all(); }
    catch (e) { root.appendChild(el("div", { class: "vc-empty" }, "This browser blocked local file storage, so reports can't be saved here.")); return; }

    const countIn = (f) => files.filter((x) => x.folder === f).length;

    /* folders */
    const folderGrid = el("div", { class: "vc-folders" });
    Reports.folders.forEach((f) => {
      folderGrid.appendChild(el("button", {
        class: "vc-folder", "aria-current": String(f === Reports.current),
        onclick: () => { Reports.current = f; Reports.saveFolders(); renderReports(root); },
      }, [
        el("span", { class: "vc-folder-name" }, f),
        el("span", { class: "vc-folder-count" }, countIn(f) === 1 ? "1 file" : countIn(f) + " files"),
      ]));
    });

    const newFolder = el("input", { class: "vc-input", placeholder: "New folder name", "aria-label": "New folder name" });
    root.appendChild(el("div", { class: "vc-card vc-stack" }, [
      el("span", { class: "vc-eyebrow" }, "Folders"),
      folderGrid,
      el("div", { class: "vc-row" }, [
        newFolder,
        el("button", {
          class: "vc-btn vc-btn-ghost",
          onclick: () => {
            const v = newFolder.value.trim();
            if (!v) return toast("Name the folder first");
            if (Reports.folders.includes(v)) return toast("That folder already exists");
            Reports.folders.push(v); Reports.current = v; Reports.saveFolders();
            renderReports(root); toast("Folder created");
          },
        }, "Create folder"),
      ]),
    ]));

    /* upload */
    const picker = el("input", { type: "file", multiple: "", style: "display:none",
      accept: ".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.txt,.csv" });
    const drop = el("div", { class: "vc-drop" }, `Drop files here, or choose them — they go into “${Reports.current}”`);
    const upload = async (fileList) => {
      const arr = Array.from(fileList || []);
      if (!arr.length) return;
      for (const f of arr) {
        if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB — skipped`); continue; }
        await Reports.put(f, Reports.current);
      }
      renderReports(root);
      toast(arr.length === 1 ? "1 report added" : arr.length + " reports added");
    };
    picker.addEventListener("change", () => upload(picker.files));
    drop.addEventListener("click", () => picker.click());
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add("is-over");
    }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove("is-over");
    }));
    drop.addEventListener("drop", (e) => upload(e.dataTransfer.files));

    root.appendChild(el("div", { class: "vc-card vc-stack" }, [
      el("span", { class: "vc-eyebrow" }, "Add reports"),
      drop, picker,
      el("button", { class: "vc-btn vc-btn-primary", onclick: () => picker.click() }, "Choose files"),
    ]));

    /* file list for the open folder */
    const mine = files.filter((f) => f.folder === Reports.current)
                      .sort((a, b) => b.added - a.added);
    const listCard = el("div", { class: "vc-card vc-stack" }, [
      el("div", { class: "vc-row" }, [
        el("span", { class: "vc-eyebrow" }, Reports.current),
        el("span", { class: "vc-head-spacer" }),
        el("span", { class: "vc-muted" }, bytes(mine.reduce((s, f) => s + f.size, 0)) + " in this folder"),
      ]),
    ]);
    if (!mine.length) {
      listCard.appendChild(el("div", { class: "vc-empty" }, "Nothing filed here yet."));
    } else {
      mine.forEach((f) => {
        const ext = (f.name.split(".").pop() || "?").slice(0, 4);
        const mover = el("select", { class: "vc-select vc-btn-sm", "aria-label": "Move to folder" });
        Reports.folders.forEach((fd) => mover.appendChild(el("option", { value: fd, selected: fd === f.folder ? "" : null }, fd)));
        mover.addEventListener("change", async () => { await Reports.move(f.id, mover.value); renderReports(root); toast("Moved to " + mover.value); });

        listCard.appendChild(el("div", { class: "vc-file" }, [
          el("span", { class: "vc-file-ext" }, ext),
          el("div", { class: "vc-file-body" }, [
            el("div", { class: "vc-file-name", title: f.name }, f.name),
            el("div", { class: "vc-file-meta" }, `${bytes(f.size)} · added ${new Date(f.added).toLocaleDateString()}`),
          ]),
          mover,
          el("button", {
            class: "vc-btn vc-btn-ghost vc-btn-sm",
            onclick: () => {
              const url = URL.createObjectURL(f.blob);
              window.open(url, "_blank", "noopener");
              setTimeout(() => URL.revokeObjectURL(url), 60000);
            },
          }, "Open"),
          el("button", {
            class: "vc-btn vc-btn-danger vc-btn-sm",
            onclick: async () => { await Reports.remove(f.id); renderReports(root); toast("Deleted"); },
          }, "Delete"),
        ]));
      });
    }
    root.appendChild(listCard);

    /* storage use */
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const pct = est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;
      root.appendChild(el("div", { class: "vc-card vc-stack" }, [
        el("span", { class: "vc-eyebrow" }, "Device storage"),
        el("div", { class: "vc-bar" }, el("div", { class: "vc-bar-fill", style: `width:${pct.toFixed(1)}%` })),
        el("span", { class: "vc-muted" }, `${bytes(est.usage || 0)} used of about ${bytes(est.quota || 0)} available to this site`),
      ]));
    }

    root.appendChild(el("p", { class: "vc-note" },
      "Reports are stored on this device only. They are not uploaded, not encrypted, and not backed up — clearing your browser data deletes them. Keep real medical records out of this until there is a server with proper access control behind it."));
  }


  /* ------------------------------------------------- vitals + health score */
  /* Reference ranges for a resting adult. Deliberately conservative and shown
     openly in the UI, because an unexplained number is not decision support —
     it is just a number wearing authority it has not earned. */
  const RANGES = {
    hr:   { label: "Heart rate",  unit: "BPM",     low: 60,   high: 100,  floor: 40, ceil: 180 },
    sys:  { label: "Systolic BP", unit: "mmHg",    low: 90,   high: 130,  floor: 70, ceil: 200 },
    dia:  { label: "Diastolic BP",unit: "mmHg",    low: 60,   high: 85,   floor: 40, ceil: 130 },
    spo2: { label: "SpO\u2082",   unit: "%",       low: 95,   high: 100,  floor: 80, ceil: 100 },
    temp: { label: "Temperature", unit: "\u00b0C", low: 36.1, high: 37.5, floor: 34, ceil: 41 },
  };

  const Vitals = {
    /* The app paints vitals into the DOM, so we read them there rather than
       reaching into React internals, which would break on any rebuild. */
    read() {
      const val = [].map.call(document.querySelectorAll(".vital-card-value"), (e) => e.innerText.replace(/\s+/g, ""));
      const trend = [].map.call(document.querySelectorAll(".vital-card-trend"), (e) => e.innerText.replace(/^Trend:\s*/i, "").trim());
      if (val.length < 4) return null;
      const num = (x) => parseFloat(String(x).replace(/[^0-9.]/g, ""));
      const bp = (val[1].match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
      const gauge = document.querySelector(".risk-gauge-score");
      const level = document.querySelector(".risk-gauge-level");
      return {
        hr: num(val[0]), sys: bp[0], dia: bp[1], spo2: num(val[2]), temp: num(val[3]),
        trends: { hr: trend[0], bp: trend[1], spo2: trend[2], temp: trend[3] },
        appRisk: gauge ? num(gauge.innerText) : null,
        appLevel: level ? level.innerText.trim() : null,
      };
    },

    /* Severity per vital, 0-3, using thresholds aligned with NEWS2 (the UK
       National Early Warning Score) plus a hypertension band, since NEWS2 is
       tuned for acute deterioration and largely ignores high BP. Graded bands
       beat linear scaling here: 89% SpO2 is not "a bit below 95", it is
       hypoxemia, and the score has to say so. */
    SEVERITY: {
      spo2: (v) => v >= 95 ? 0 : v >= 93 ? 1 : v >= 91 ? 2 : 3,
      hr:   (v) => (v >= 51 && v <= 90) ? 0
                 : ((v >= 91 && v <= 110) || (v >= 41 && v <= 50)) ? 1
                 : (v >= 111 && v <= 130) ? 2 : 3,
      sys:  (v) => (v >= 111 && v <= 129) ? 0
                 : ((v >= 130 && v <= 139) || (v >= 101 && v <= 110)) ? 1
                 : ((v >= 140 && v <= 179) || (v >= 91 && v <= 100)) ? 2 : 3,
      dia:  (v) => (v >= 61 && v <= 84) ? 0
                 : (v >= 85 && v <= 89) ? 1
                 : (v >= 90 && v <= 109) ? 2 : 3,
      temp: (v) => (v >= 36.1 && v <= 37.5) ? 0
                 : ((v > 37.5 && v <= 38.0) || (v >= 35.1 && v < 36.1)) ? 1
                 : (v > 38.0 && v <= 39.0) ? 2 : 3,
    },
    PENALTY: [0, 12, 26, 42],

    deviation(key, v) {
      if (v === undefined || v === null || isNaN(v)) return null;
      return this.SEVERITY[key] ? this.SEVERITY[key](v) : null;
    },

    /* The worst vital dominates; the rest contribute at a discount, so several
       mild readings cannot masquerade as one severe one. Bands are then capped
       by the worst severity, because a single severe reading must never be
       averaged away into a reassuring number. */
    score(v) {
      if (!v) return null;
      const parts = [];
      Object.keys(this.SEVERITY).forEach((k) => {
        const sev = this.deviation(k, v[k]);
        if (sev === null) return;
        parts.push({ key: k, sev: sev, lost: this.PENALTY[sev], value: v[k], range: RANGES[k] });
      });
      if (!parts.length) return null;

      const pens = parts.map((x) => x.lost).sort((a, b) => b - a);
      const worst = pens[0];
      const rest = pens.slice(1).reduce((a, b) => a + b, 0);
      let score = Math.round(100 - (worst + 0.35 * rest));

      const maxSev = Math.max.apply(null, parts.map((x) => x.sev));
      const mildCount = parts.filter((x) => x.sev >= 1).length;
      if (maxSev >= 3) score = Math.min(score, 39);
      else if (maxSev === 2) score = Math.min(score, 59);
      else if (mildCount >= 3) score = Math.min(score, 79);

      score = Math.max(0, Math.min(100, score));
      parts.sort((a, b) => b.lost - a.lost);
      return { score: score, parts: parts, band: this.band(score), maxSev: maxSev };
    },

    band(score) {
      if (score >= 80) return { name: "Excellent", color: "0b7a50", tone: "risk-low" };
      if (score >= 60) return { name: "Monitor",   color: "8f6205", tone: "risk-moderate" };
      if (score >= 40) return { name: "Caution",   color: "a84d18", tone: "risk-high" };
      return { name: "Critical", color: "c62828", tone: "risk-critical" };
    },

    /* Plain-language explanation. States what was measured and which way it
       is off — never names a condition, never touches medication. */
    insight(v, sc) {
      if (!v || !sc) return { risk: "Unknown", lines: ["No live readings available."], advice: "" };
      const out = [];
      const flagged = sc.parts.filter((x) => x.sev > 0);

      flagged.slice(0, 4).forEach((x) => {
        const r = x.range;
        const dir = x.value < r.low ? "below" : "above";
        const t = v.trends || {};
        const tkey = (x.key === "sys" || x.key === "dia") ? "bp" : x.key;
        const moving = t[tkey] && /increas|decreas/i.test(t[tkey]) ? " and still " + t[tkey].toLowerCase() : "";
        const grade = x.sev >= 3 ? "markedly " : x.sev === 2 ? "clearly " : "";
        out.push(r.label + " is " + x.value + (r.unit === "%" ? "%" : " " + r.unit) +
                 ", " + grade + dir + " the usual resting range of " + r.low + "\u2013" + r.high + moving + ".");
      });

      if (!out.length) out.push("All four readings are inside the usual resting range for an adult.");

      let risk, advice;
      if (sc.score >= 80) {
        risk = "Low";
        advice = "Nothing here needs action. Keep wearing the band so the trend stays visible.";
      } else if (sc.score >= 60) {
        risk = "Moderate";
        advice = "Rest, then take the reading again in a few minutes. If it stays like this, or you feel unwell, speak to a healthcare professional.";
      } else if (sc.score >= 40) {
        risk = "High";
        advice = "Stop what you are doing and rest. Contact a healthcare professional today \u2014 sooner if you feel breathless, dizzy, or have chest pain.";
      } else {
        risk = "Critical";
        advice = "These readings need medical attention now. Contact emergency services or your doctor immediately \u2014 do not wait to see whether they improve.";
      }
      return { risk: risk, lines: out, advice: advice };
    },
  };

  /* ---------------------------------------------------------- 4. AI render */
  function renderAI(root) {
    root.textContent = "";
    const v = Vitals.read();

    if (!v) {
      root.appendChild(el("div", { class: "vc-empty" },
        "Open the Dashboard or Live Vitals screen first \u2014 the analysis reads the live readings shown there."));
      return;
    }
    const sc = Vitals.score(v);
    const ins = Vitals.insight(v, sc);

    const grid = el("div", { class: "vc-vitals-grid" });
    [["hr", v.hr], ["sys", v.sys], ["spo2", v.spo2], ["temp", v.temp]].forEach(function (pair) {
      const k = pair[0], val = pair[1];
      const r = RANGES[k];
      const sev = Vitals.deviation(k, val);
      const out = sev > 0;
      const col = sev >= 2 ? "var(--risk-critical)" : sev === 1 ? "var(--risk-moderate)" : "var(--risk-low)";
      const label = k === "sys" ? "Blood pressure" : r.label;
      const shown = k === "sys" ? (v.sys + "/" + v.dia) : String(val);
      grid.appendChild(el("div", { class: "vc-vital" + (out ? " is-out" : ""), style: out ? "color:" + col : "" }, [
        el("div", { class: "vc-vital-label" }, label),
        el("div", { class: "vc-vital-value", style: "color:" + col }, [
          el("span", {}, shown), el("span", { class: "vc-vital-unit" }, r.unit),
        ]),
        el("div", { class: "vc-vital-note", style: "color:" + col },
          out ? (["", "Slightly ", "Clearly ", "Markedly "][sev] + (val < r.low ? "below range" : "above range")) : "Within usual range"),
      ]));
    });

    root.appendChild(el("div", { class: "vc-card vc-stack" }, [
      el("div", { class: "vc-row" }, [
        el("span", { class: "vc-eyebrow" }, "AI health analysis"),
        el("span", { class: "vc-head-spacer" }),
        el("span", { class: "vc-risk-chip",
                     style: "background:var(--" + sc.band.tone + "-bg);color:var(--" + sc.band.tone + ")" },
           "Risk level: " + ins.risk),
      ]),
      grid,
      el("div", { class: "vc-insight" }, [
        el("div", { class: "vc-insight-head" }, [el("span", { class: "vc-insight-title" }, "Insight")]),
        el("div", { class: "vc-insight-body" }, [
          el("ul", {}, ins.lines.map(function (l) { return el("li", {}, l); })),
          el("p", { style: "margin-top:10px" }, ins.advice),
        ]),
      ]),
      el("div", { class: "vc-row" }, [
        el("button", { class: "vc-btn vc-btn-ghost vc-btn-sm",
                       onclick: function () { renderAI(root); toast("Re-read the live vitals"); } }, "Re-analyse"),
        el("button", { class: "vc-btn vc-btn-ghost vc-btn-sm",
                       onclick: function () { Shell.go("score"); } }, "See health score"),
      ]),
    ]));

    root.appendChild(el("p", { class: "vc-note" },
      "Decision support, not a diagnosis. This compares live readings against general adult resting ranges \u2014 it does not know your history, medication or context, and it cannot identify a condition. Any treatment decision belongs to a qualified clinician. Readings here are simulated."));
  }

  /* ------------------------------------------------------- 5. score render */
  function renderScore(root) {
    root.textContent = "";
    const v = Vitals.read();
    if (!v) {
      root.appendChild(el("div", { class: "vc-empty" }, "Open the Dashboard first so there are live readings to score."));
      return;
    }
    const sc = Vitals.score(v);
    const col = "#" + sc.band.color;

    const NS = "http://www.w3.org/2000/svg";
    const R = 88, C = 2 * Math.PI * R;
    const mk = function (tag, at) {
      const n = document.createElementNS(NS, tag);
      for (const k in at) n.setAttribute(k, at[k]);
      return n;
    };
    const svg = mk("svg", { viewBox: "0 0 210 210" });
    svg.appendChild(mk("circle", { cx: 105, cy: 105, r: R, fill: "none", stroke: "var(--bg-inset)", "stroke-width": 16 }));
    svg.appendChild(mk("circle", { cx: 105, cy: 105, r: R, fill: "none", stroke: col, "stroke-width": 16,
      "stroke-linecap": "round", "stroke-dasharray": (C * sc.score / 100).toFixed(1) + " " + C.toFixed(1) }));

    const dial = el("div", { class: "vc-score-dial" }, [
      el("div", { class: "vc-score-mid" }, [
        el("div", { class: "vc-score-num", style: "color:" + col }, String(sc.score)),
        el("div", { class: "vc-score-of" }, "OUT OF 100"),
        el("div", { class: "vc-score-band", style: "color:" + col }, sc.band.name),
      ]),
    ]);
    dial.insertBefore(svg, dial.firstChild);

    const bands = [["Excellent", "80\u2013100", "0b7a50"], ["Monitor", "60\u201379", "8f6205"],
                   ["Caution", "40\u201359", "a84d18"], ["Critical", "0\u201339", "c62828"]];
    const legend = el("div", { class: "vc-score-legend" }, bands.map(function (b) {
      return el("div", { class: "vc-legend-row" + (b[0] === sc.band.name ? " is-current" : "") }, [
        el("span", { class: "vc-legend-dot", style: "background:#" + b[2] }),
        el("span", {}, b[0]),
        el("span", { class: "vc-legend-range" }, b[1]),
      ]);
    }));

    root.appendChild(el("div", { class: "vc-card" }, el("div", { class: "vc-score-wrap" }, [dial, legend])));

    const contrib = sc.parts.filter(function (x) { return x.sev > 0; });
    const card = el("div", { class: "vc-card vc-stack" }, [
      el("span", { class: "vc-eyebrow" }, contrib.length ? "What lowered the score" : "Contributing readings"),
    ]);
    if (!contrib.length) {
      card.appendChild(el("p", { class: "vc-muted" }, "Every reading is inside its usual resting range, so nothing was deducted."));
    } else {
      contrib.forEach(function (x) {
        const pct = Math.round((x.sev / 3) * 100);
        const sevName = ["", "mild", "moderate", "severe"][x.sev];
        card.appendChild(el("div", {}, [
          el("div", { class: "vc-row", style: "justify-content:space-between" }, [
            el("span", { style: "font-weight:600;font-size:var(--fs-sm)" },
              x.range.label + " \u2014 " + x.value + (x.range.unit === "%" ? "%" : " " + x.range.unit)),
            el("span", { class: "vc-muted" }, sevName + " \u00b7 \u2212" + x.lost + " pts"),
          ]),
          el("div", { class: "vc-bar", style: "margin-top:6px" },
            el("div", { class: "vc-bar-fill", style: "width:" + pct + "%;background:#" + sc.band.color })),
          el("div", { class: "vc-file-meta" },
            "usual range " + x.range.low + "\u2013" + x.range.high + " " + x.range.unit),
        ]));
      });
    }
    root.appendChild(card);

    root.appendChild(el("p", { class: "vc-note" },
      "Each reading is graded mild / moderate / severe using thresholds aligned with NEWS2, the UK National Early Warning Score, plus a hypertension band NEWS2 does not cover. The worst reading dominates and caps the band, so one severe result can never be averaged away by three normal ones. This is a prototype indicator, not a validated clinical score, and not the same as the app's risk score, which also weighs trend direction."));
  }

  /* ---------------------------------------------------- 6. passport render */
  const Passport = {
    load() {
      const d = store.get("passport", null);
      return d || {
        name: "Aadil Rahman", age: "58", blood: "O+", id: "VTL-0001",
        conditions: "Hypertension, Type 2 Diabetes, Prior cardiac event (2022)",
        allergies: "Penicillin, Sulfa drugs",
        contact: "Priya Rahman (Spouse) +91 98xxx xx341",
        doctor: "Dr. Imran Sheikh, Primary Physician +91 90xxx xx112",
        notes: "Carries GTN spray.",
        photo: "",
      };
    },
    save(d) { store.set("passport", d); },

    /* Compact payload. Every character costs QR modules, and past ~300 chars
       the modules get too small to scan off a phone screen — so labels are
       terse and long fields are trimmed. A real deployment should encode a
       signed, short-lived URL instead, so access can be logged and revoked. */
    payload(d) {
      const trim = (x, n) => {
        const t = String(x || "").trim();
        return !t ? "none" : (t.length > n ? t.slice(0, n - 1) + "\u2026" : t);
      };
      const meds = Meds.list.map((m) => m.name + " " + m.dose).join("; ");
      return [
        "VITALYN EMERGENCY",
        d.name + ", " + d.age + ", " + d.blood,
        "ID " + d.id,
        "ALLERGY: " + trim(d.allergies, 70),
        "COND: " + trim(d.conditions, 80),
        "MEDS: " + trim(meds, 70),
        "ICE: " + trim(d.contact, 55),
        "DR: " + trim(d.doctor, 55),
        d.notes ? "NOTE: " + trim(d.notes, 45) : "",
        "Demo data, not a medical record",
      ].filter(Boolean).join("\n");
    },

    qrSvg(text, px) {
      if (typeof qrcode !== "function") return null;
      let q = null;
      for (let t = 0; t <= 20; t++) {
        try { q = qrcode(t, "M"); q.addData(text); q.make(); break; }
        catch (e) { q = null; }
      }
      if (!q) return null;
      const n = q.getModuleCount(), cell = px / (n + 8), off = cell * 4;
      let path = "";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (q.isDark(r, c)) {
            path += "M" + (off + c * cell).toFixed(2) + " " + (off + r * cell).toFixed(2) +
                    "h" + cell.toFixed(2) + "v" + cell.toFixed(2) + "h-" + cell.toFixed(2) + "z";
          }
        }
      }
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 " + px + " " + px);
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Emergency medical QR code");
      svg.setAttribute("shape-rendering", "crispEdges");
      svg.dataset.modules = String(n);
      const bg = document.createElementNS(NS, "rect");
      bg.setAttribute("width", px); bg.setAttribute("height", px); bg.setAttribute("fill", "#fff");
      const pa = document.createElementNS(NS, "path");
      pa.setAttribute("d", path); pa.setAttribute("fill", "#0b3c68");
      svg.appendChild(bg); svg.appendChild(pa);
      return svg;
    },
  };

  function renderPassport(root) {
    root.textContent = "";
    const d = Passport.load();
    const initials = d.name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (x) { return x[0]; }).join("").toUpperCase();

    const photo = d.photo
      ? el("img", { class: "vc-pp-photo", src: d.photo, alt: "Patient photo" })
      : el("div", { class: "vc-pp-photo" }, initials);

    const taglist = function (str, cls) {
      const items = String(str || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      if (!items.length) return el("span", { class: "vc-muted" }, "None recorded");
      return el("div", {}, items.map(function (t) {
        return el("span", { class: "vc-pp-tag" + (cls ? " " + cls : "") }, t);
      }));
    };
    const medList = Meds.list.length
      ? el("div", { class: "vc-pp-list" }, Meds.list.map(function (m) {
          return el("span", {}, m.name + " \u2014 " + m.dose + " (" + m.times.map(to12h).join(", ") + ")");
        }))
      : el("span", { class: "vc-muted" }, "None recorded");

    const qrHolder = el("div", { class: "vc-qr-box" });
    const svg = Passport.qrSvg(Passport.payload(d), 220);
    if (svg) qrHolder.appendChild(svg);
    else qrHolder.appendChild(el("span", { class: "vc-muted" }, "QR unavailable"));
    qrHolder.style.cursor = "pointer";
    qrHolder.addEventListener("click", function () { showScan(d); });

    root.appendChild(el("div", { class: "vc-passport" }, [
      el("div", { class: "vc-pp-top" }, [
        photo,
        el("div", {}, [
          el("div", { class: "vc-pp-name" }, d.name),
          el("div", { class: "vc-pp-meta" }, d.age + " yrs \u00b7 Vitalyn health passport"),
          el("div", { class: "vc-pp-id" }, d.id),
        ]),
        el("div", { class: "vc-pp-blood" }, [
          el("div", { class: "vc-pp-blood-val" }, d.blood),
          el("div", { class: "vc-pp-blood-lbl" }, "Blood group"),
        ]),
      ]),
      el("div", { class: "vc-pp-grid" }, [
        el("div", { class: "vc-pp-cell is-alert" }, [el("h4", {}, "\u26a0 Allergies"), taglist(d.allergies, "is-allergy")]),
        el("div", { class: "vc-pp-cell" }, [el("h4", {}, "Medical conditions"), taglist(d.conditions)]),
        el("div", { class: "vc-pp-cell" }, [el("h4", {}, "Current medication"), medList]),
        el("div", { class: "vc-pp-cell" }, [el("h4", {}, "Emergency contact"),
          el("div", { class: "vc-pp-list" }, [
            el("span", {}, d.contact),
            el("span", { class: "vc-muted" }, d.doctor),
          ])]),
      ]),
      el("div", { class: "vc-qr-panel" }, [
        qrHolder,
        el("div", { class: "vc-qr-text" }, [
          el("div", { style: "font-weight:700;margin-bottom:4px" }, "Emergency access QR"),
          el("p", { class: "vc-muted" },
            "A clinician scans this to see blood group, allergies, conditions, medication and next of kin \u2014 without unlocking the phone. Tap it to preview what they would see."),
          el("div", { class: "vc-row", style: "margin-top:10px" }, [
            el("button", { class: "vc-btn vc-btn-primary vc-btn-sm", onclick: function () { showScan(d); } }, "Preview scan"),
            el("button", { class: "vc-btn vc-btn-ghost vc-btn-sm", onclick: function () { window.print(); } }, "Print card"),
          ]),
        ]),
      ]),
    ]));

    const f = {};
    const field = function (key, label, ph) {
      f[key] = el("input", { class: "vc-input", value: d[key] || "", placeholder: ph || "", "aria-label": label });
      return el("label", { class: "vc-field" }, [el("span", { class: "vc-label" }, label), f[key]]);
    };
    const filePick = el("input", { type: "file", accept: "image/*", style: "display:none" });
    filePick.addEventListener("change", function () {
      const file = filePick.files && filePick.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) return toast("Use a photo under 2 MB");
      const fr = new FileReader();
      fr.onload = function () {
        const nd = Passport.load(); nd.photo = fr.result; Passport.save(nd);
        renderPassport(root); toast("Photo updated");
      };
      fr.readAsDataURL(file);
    });

    root.appendChild(el("div", { class: "vc-card vc-stack" }, [
      el("span", { class: "vc-eyebrow" }, "Edit passport"),
      el("div", { class: "vc-row" }, [field("name", "Full name"), field("age", "Age"), field("blood", "Blood group")]),
      el("div", { class: "vc-row" }, [field("allergies", "Allergies (comma separated)", "e.g. Penicillin, Peanuts")]),
      el("div", { class: "vc-row" }, [field("conditions", "Conditions (comma separated)")]),
      el("div", { class: "vc-row" }, [field("contact", "Emergency contact"), field("doctor", "Doctor")]),
      el("div", { class: "vc-row" }, [field("notes", "Notes for a first responder")]),
      el("div", { class: "vc-row" }, [
        el("button", { class: "vc-btn vc-btn-primary", onclick: function () {
          const nd = Passport.load();
          Object.keys(f).forEach(function (k) { nd[k] = f[k].value.trim(); });
          Passport.save(nd); renderPassport(root); toast("Passport saved");
        } }, "Save passport"),
        el("button", { class: "vc-btn vc-btn-ghost", onclick: function () { filePick.click(); } }, "Add photo"),
        filePick,
      ]),
    ]));

    root.appendChild(el("p", { class: "vc-note" },
      "The QR carries this record as plain text, so anyone who scans it can read it \u2014 that is the point in an emergency, but it also means it is not private. A real deployment should encode a short-lived signed link instead, so access can be logged and revoked. Stored on this device only."));
  }

  function showScan(d) {
    const wrap = $(".vc-scan");
    const meds = Meds.list.length
      ? Meds.list.map(function (m) { return m.name + " " + m.dose; }).join(", ")
      : "None recorded";
    const rows = el("div", {});
    [["Blood group", d.blood], ["Allergies", d.allergies || "None recorded"],
     ["Conditions", d.conditions || "None recorded"], ["Medication", meds],
     ["Emergency contact", d.contact], ["Doctor", d.doctor],
     ["Notes", d.notes || "\u2014"]].forEach(function (pair, i) {
      rows.appendChild(el("div", { class: "vc-pp-cell", style: i ? "border-top:1px solid var(--border-subtle)" : "" }, [
        el("h4", {}, pair[0]),
        el("div", { style: "font-size:var(--fs-sm)" }, String(pair[1])),
      ]));
    });
    const card = el("div", { class: "vc-scan-card" }, [
      el("div", { class: "vc-scan-head" }, [
        el("h3", {}, "Emergency medical record"),
        el("p", {}, d.name + " \u00b7 " + d.age + " yrs \u00b7 " + d.id),
      ]),
      rows,
      el("div", { style: "padding:var(--sp-4) var(--sp-5);border-top:1px solid var(--border-subtle)" }, [
        el("p", { class: "vc-note", style: "border:0;padding:0" },
          "This is what a clinician sees after scanning. Demonstration data \u2014 not a medical record."),
        el("button", { class: "vc-btn vc-btn-primary", style: "margin-top:12px",
                       onclick: function () { wrap.hidden = true; } }, "Close"),
      ]),
    ]);
    wrap.textContent = ""; wrap.appendChild(card); wrap.hidden = false;
  }

  /* ------------------------------------------------------------ 4. shell */
  /* ------------------------------------------------------ wearable panel */
  const HIST = { bpm: [], spo2: [], temp: [] };

  function sparkline(vals, w, h) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "vc-spark");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    if (vals.length > 1) {
      const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      const span = (max - min) || 1;
      const d = vals.map((v, i) => {
        const x = (i / (vals.length - 1)) * w;
        const y = h - 3 - ((v - min) / span) * (h - 6);
        return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(" ");
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function bleTile(label, value, unit, series) {
    const stale = value === null || value === undefined;
    const body = stale
      ? el("div", { class: "vc-live-val" }, el("span", { class: "vc-live-none" }, "--"))
      : el("div", { class: "vc-live-val" }, [
          document.createTextNode(String(value)),
          unit ? el("span", { class: "u" }, unit) : document.createTextNode(""),
        ]);
    const t = el("div", { class: "vc-live-tile" + (stale ? " stale" : "") }, [
      el("div", { class: "vc-live-label" }, label), body,
    ]);
    if (series && series.length > 1) t.appendChild(sparkline(series, 100, 42));
    return t;
  }

  function batteryRing(pct) {
    const ns = "http://www.w3.org/2000/svg";
    const R = 34, C = 2 * Math.PI * R;
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "84"); svg.setAttribute("height", "84");
    svg.setAttribute("viewBox", "0 0 84 84");
    const mk = (cls, offset) => {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", "42"); c.setAttribute("cy", "42"); c.setAttribute("r", String(R));
      c.setAttribute("fill", "none"); c.setAttribute("stroke-width", "7");
      c.setAttribute("stroke-linecap", "round"); c.setAttribute("class", cls);
      if (offset !== null) {
        c.setAttribute("stroke-dasharray", String(C));
        c.setAttribute("stroke-dashoffset", String(offset));
      }
      return c;
    };
    svg.appendChild(mk("vc-batt-track", null));
    if (pct !== null && pct !== undefined) {
      const lvl = pct <= 10 ? " crit" : pct <= 25 ? " low" : "";
      svg.appendChild(mk("vc-batt-fill" + lvl, C * (1 - pct / 100)));
    }
    return el("div", { class: "vc-batt" }, [
      svg,
      el("div", { class: "vc-batt-num" }, [
        el("span", { class: "vc-batt-pct" }, pct === null || pct === undefined ? "--" : pct + "%"),
        el("span", { class: "vc-batt-cap" }, "BATTERY"),
      ]),
    ]);
  }

  function renderDevice(root) {
    const BLE = window.VitalynBLE;
    if (!BLE) { root.textContent = "Bluetooth module not loaded."; return; }
    const L = BLE.Link;

    const paint = () => {
      root.textContent = "";
      const d = L.data;
      const connected = L.status === "connected";
      if (connected) {
        if (d.bpm != null) HIST.bpm = HIST.bpm.concat(d.bpm).slice(-40);
        if (d.spo2 != null) HIST.spo2 = HIST.spo2.concat(d.spo2).slice(-40);
        if (d.temp != null) HIST.temp = HIST.temp.concat(d.temp).slice(-40);
      }
      const label = { idle: "Not connected", connecting: "Pairing\u2026",
                      connected: L.isSim() ? "Connected (simulated band)" : "Connected",
                      reconnecting: "Signal lost \u2014 reconnecting", error: "Connection failed" }[L.status];
      const led = { idle: "", connecting: "warn", connected: "on",
                    reconnecting: "warn", error: "err" }[L.status];

      root.appendChild(el("div", { class: "vc-dev-hero" }, [
        el("div", { class: "vc-dev-id" }, [
          el("span", { class: "vc-dev-name" }, (L.device && L.device.name) || "No wearable paired"),
          el("span", { class: "vc-dev-model" },
            (L.info.manufacturer || L.info.model)
              ? [L.info.manufacturer, L.info.model, L.info.firmware ? "fw " + L.info.firmware : null].filter(Boolean).join(" \u00b7 ")
              : "Pair a Bluetooth band to stream vitals"),
          el("span", { class: "vc-dev-state" }, [
            el("span", { class: "vc-dev-led " + led, "aria-hidden": "true" }),
            document.createTextNode(label),
          ]),
        ]),
        batteryRing(d.battery),
      ]));

      root.appendChild(el("span", { class: "vc-eyebrow" }, "Live from the band"));
      root.appendChild(el("div", { class: "vc-live" }, [
        bleTile("Heart rate", d.bpm, "bpm", HIST.bpm),
        bleTile("SpO\u2082", d.spo2 == null ? null : d.spo2.toFixed(1), "%", HIST.spo2),
        bleTile("Temperature", d.temp == null ? null : d.temp.toFixed(1), "\u00b0C", HIST.temp),
        bleTile("HRV (RMSSD)", d.hrv, "ms", null),
      ]));

      root.appendChild(el("div", { class: "vc-card vc-stack" }, [
        el("span", { class: "vc-eyebrow" }, "Connection"),
        el("div", { class: "vc-row" }, [
          el("span", { class: "vc-muted" }, "Status"),
          el("span", { class: "vc-head-spacer" }),
          el("strong", {}, label),
        ]),
        el("div", { class: "vc-row" }, [
          el("span", { class: "vc-muted" }, "Battery"),
          el("span", { class: "vc-head-spacer" }),
          el("strong", {}, d.battery == null ? "Unknown" : d.battery + "%"),
        ]),
        el("div", { class: "vc-row" }, [
          el("span", { class: "vc-muted" }, "Last sync"),
          el("span", { class: "vc-head-spacer" }),
          el("strong", {}, ago(L.lastSeen)),
        ]),
        el("div", { class: "vc-row" }, [
          el("span", { class: "vc-muted" }, "Link"),
          el("span", { class: "vc-head-spacer" }),
          el("strong", {}, L.isSim() ? "Simulated" : (L.supported() ? "Bluetooth LE" : "Unavailable")),
        ]),
      ]));

      /* In the Android build, show exactly which precondition is failing
         rather than letting a scan quietly return nothing. */
      if (L.checkReadiness) {
        const r = L.checkReadiness();
        if (!r.ok) {
          const box = el("div", { class: "vc-unsupported vc-stack" }, [
            el("strong", {}, "Bluetooth can't scan yet"),
            el("span", {}, r.message),
          ]);
          if (r.fix === "permission") {
            box.appendChild(el("button", {
              class: "vc-btn vc-btn-primary",
              onclick: () => { L.requestPermissions(); toast("Allow the permission, then try again"); },
            }, "Grant permission"));
          }
          root.appendChild(box);
        }
      }

      const row = el("div", { class: "vc-row" });
      let controlsDone = false;          // native branch renders its own controls
      if (!L.supported()) {
        root.appendChild(el("div", { class: "vc-unsupported" },
          "This browser can't talk to Bluetooth devices. Web Bluetooth works in Chrome or Edge on Android, Windows, macOS and Linux \u2014 it is not available in Safari, or on any iPhone or iPad. On iOS a real band needs the native app build. The simulated band below still works."));
      } else if (!connected && L.hasNative && L.hasNative()) {
        /* Android shell: scan natively and list what we find. */
        row.appendChild(el("button", { class: "vc-btn vc-btn-primary",
          onclick: () => { if (L.nativeScan()) toast("Scanning for 12 seconds\u2026"); },
        }, L.status === "connecting" ? "Scanning\u2026" : "Scan for wearables"));
        row.appendChild(el("button", { class: "vc-btn vc-btn-ghost",
          onclick: () => { L.startSim(); toast("Simulated band running"); },
        }, "Use simulated band"));
        root.appendChild(row);
        controlsDone = true;

        const list = el("div", { class: "vc-stack" });
        if (L.nativeDevices && L.nativeDevices.length) {
          list.appendChild(el("span", { class: "vc-eyebrow" },
            "Found " + L.nativeDevices.length + " device" + (L.nativeDevices.length > 1 ? "s" : "")));
          L.nativeDevices.slice().sort((a, b) => b.rssi - a.rssi).forEach((d) => {
            list.appendChild(el("div", { class: "vc-file" }, [
              el("div", { class: "vc-file-body" }, [
                el("div", { class: "vc-file-name" }, d.name),
                el("div", { class: "vc-file-meta" }, d.address + "  \u00b7  signal " + d.rssi + " dBm"),
              ]),
              el("button", { class: "vc-btn vc-btn-primary vc-btn-sm",
                onclick: () => { L.nativeConnect(d.address, d.name); toast("Connecting to " + d.name); },
              }, "Connect"),
            ]));
          });
        } else if (L.status === "connecting") {
          list.appendChild(el("div", { class: "vc-empty" }, "Looking for nearby Bluetooth devices\u2026"));
        }
        if (L.lastError) list.appendChild(el("div", { class: "vc-unsupported" }, L.lastError));
        root.appendChild(list);

        root.appendChild(el("p", { class: "vc-note" },
          "Native Bluetooth is active in this Android build. Every nearby BLE device is listed, not just health bands, because many bands do not advertise their services. A device that connects but shows no readings is keeping its sensors behind the maker's own app."));

      } else if (!connected) {
        const tryConnect = async (showAll) => {
          try {
            await L.connect(showAll);
            toast(L.found.length ? "Connected: " + L.found.join(", ") : "Paired, but no health data");
          } catch (e) {
            if (e && e.name === "NotFoundError") toast("No device chosen");
            else if (e && e.name === "SecurityError") toast("Bluetooth needs an HTTPS page");
            else toast("Could not connect: " + ((e && e.message) || "unknown"));
          }
        };
        row.appendChild(el("button", { class: "vc-btn vc-btn-primary",
          onclick: () => tryConnect(false),
        }, L.status === "connecting" ? "Pairing\u2026" : "Pair a wearable"));
        row.appendChild(el("button", { class: "vc-btn vc-btn-ghost",
          onclick: () => tryConnect(true),
        }, "Scan all devices"));
      }
      if (!controlsDone) {
        if (connected) {
          row.appendChild(el("button", {
            class: "vc-btn vc-btn-ghost",
            onclick: () => { L.disconnect(); HIST.bpm = []; HIST.spo2 = []; HIST.temp = []; toast("Disconnected"); },
          }, "Disconnect"));
        } else {
          row.appendChild(el("button", {
            class: "vc-btn vc-btn-ghost",
            onclick: () => { L.startSim(); toast("Simulated band running"); },
          }, "Use simulated band"));
        }
        root.appendChild(row);
      } else if (connected) {
        root.appendChild(el("div", { class: "vc-row" }, el("button", {
          class: "vc-btn vc-btn-ghost",
          onclick: () => { L.disconnect(); HIST.bpm = []; HIST.spo2 = []; HIST.temp = []; toast("Disconnected"); },
        }, "Disconnect")));
      }

      /* Paired but silent is the single most confusing outcome, so name it. */
      if (connected && !L.isSim() && L.found.length === 0) {
        root.appendChild(el("div", { class: "vc-unsupported" },
          "Paired, but this device isn't sharing any health data over Bluetooth. That usually means it keeps its sensors behind the maker's own app rather than the standard Bluetooth profiles \u2014 Samsung Galaxy Watch, Apple Watch, Fitbit and Mi Band all behave this way. See the note below for how to get a Galaxy Watch broadcasting."));
      } else if (connected && !L.isSim()) {
        root.appendChild(el("span", { class: "vc-muted" },
          "Streaming: " + L.found.join(" \u00b7 ")));
      }

      /* Galaxy Watch is the most common band people try, so answer it directly. */
      if (!connected || (!L.isSim() && L.found.length === 0)) {
        root.appendChild(el("details", { class: "vc-card" }, [
          el("summary", { style: "cursor:pointer;font-weight:600" }, "Using a Samsung Galaxy Watch?"),
          el("p", { class: "vc-muted", style: "margin-top:12px" },
            "A Galaxy Watch will not appear here on its own. It talks to your phone through Samsung Health, and does not advertise itself as a standard Bluetooth heart-rate sensor \u2014 Samsung has never shipped that feature, and there is a long-running user request asking for it."),
          el("p", { class: "vc-muted", style: "margin-top:8px" },
            "To use it today, install a broadcaster app on the watch \u2014 \u201cHeart for Bluetooth\u201d or \u201cHR2VP\u201d on the Play Store. They turn the watch into a standard BLE heart-rate monitor. Start the app on the watch, then press \u201cPair a wearable\u201d here and it will show up. Turn on continuous heart-rate monitoring in Samsung Health first, and allow the app to run in the background."),
          el("p", { class: "vc-muted", style: "margin-top:8px" },
            "The longer-term fix is the Android build reading Health Connect, which Samsung Health writes into. That gets heart rate, SpO\u2082, sleep and steps from the watch without any third-party app \u2014 and it works for Fitbit and Google Fit too."),
        ]));
      }

      /* Diagnostic log — the only visibility available in a sideloaded app. */
      if (L.log && L.log.length) {
        const pre = el("div", {
          style: "font-family:var(--font-mono);font-size:11px;line-height:1.7;" +
                 "white-space:pre-wrap;color:var(--text-secondary);max-height:190px;overflow:auto",
        }, L.log.join("\n"));
        const d = el("details", { class: "vc-card" }, [
          el("summary", { style: "cursor:pointer;font-weight:600" },
             "Connection log (" + L.log.length + ")"),
          el("div", { style: "margin-top:10px" }, pre),
        ]);
        if (L.diag) {
          d.appendChild(el("div", { class: "vc-muted", style: "margin-top:10px;font-size:11px" },
            "Android SDK " + L.diag.androidSdk +
            " \u00b7 adapter " + (L.diag.adapter ? "yes" : "no") +
            " \u00b7 bluetooth " + (L.diag.bluetoothOn ? "on" : "off") +
            " \u00b7 location permission " + (L.diag.locationPermission ? "granted" : "denied") +
            " \u00b7 location services " + (L.diag.locationServices ? "on" : "off")));
        }
        root.appendChild(d);
      }

      root.appendChild(el("p", { class: "vc-note" },
        "Vitalyn reads the adopted Bluetooth health profiles \u2014 Heart Rate (0x180D), Pulse Oximeter (0x1822), Health Thermometer (0x1809) and Battery (0x180F) \u2014 so it works with any compliant band rather than one brand. A band that only speaks its maker's proprietary protocol will pair but report nothing; that is a limit of the band, not of Vitalyn."));
    };

    if (!L._bound) { L.on(() => { if (!root.hidden) paint(); }); L._bound = true; }
    paint();
  }

  /* --------------------------------------------------------------- roles --
     Vitalyn is opened by four different people. The role decides which tools
     are shown, so a doctor is not offered a personal medication reminder and
     a family member is not shown clinical scoring they cannot act on. */
  const ROLES = [
    { id: "patient", short: "PT", cap: "PATIENT", name: "Patient",
      blurb: "Your own vitals, medication reminders and the emergency alarm.",
      tabs: ["device", "ai", "score", "passport", "meds", "sos", "reports"],
      note: "You are viewing your own record." },
    { id: "doctor", short: "DR", cap: "DOCTOR", name: "Doctor",
      blurb: "Clinical view: trends, what drove the risk score, and the patient's records.",
      tabs: ["device", "ai", "score", "passport", "reports"],
      note: "Clinical view. Vitalyn is decision support on a prototype, not a diagnosis \u2014 confirm anything here against your own examination." },
    { id: "caregiver", short: "CG", cap: "CARER", name: "Caregiver",
      blurb: "Professional carer: live status, medication adherence and alerts.",
      tabs: ["device", "ai", "passport", "meds", "sos", "reports"],
      note: "Caregiver view. You can see status and medication, and raise the alarm." },
    { id: "guardian", short: "GD", cap: "FAMILY", name: "Guardian or family",
      blurb: "Family member: how they are doing right now, and what to do if it changes.",
      tabs: ["device", "ai", "meds", "sos"],
      note: "Family view. Kept deliberately simple \u2014 status, medication and how to get help." },
  ];

  const Role = {
    get() {
      const id = store.get("role", null);
      return ROLES.find((r) => r.id === id) || null;
    },
    set(id) { store.set("role", id); },
    clear() { store.set("role", null); },
  };

  const Shell = {
    mounted: false,
    dot: null,

    flagDot(on) { if (this.dot) this.dot.hidden = !on; },

    mount() {
      if (this.mounted) return;
      this.mounted = true;

      this.dot = el("span", { class: "vc-launcher-dot", hidden: "" });
      const launcher = el("button", { class: "vc-launcher", "aria-haspopup": "dialog" }, [
        this.dot, el("span", {}, "Care tools"),
      ]);

      const ALL_KEYS = ["device", "ai", "score", "passport", "meds", "sos", "reports"];
      const activeRole = () => Role.get() || ROLES[0];
      const KEYS = ALL_KEYS;
      const panels = {};
      KEYS.forEach((k, i) => {
        panels[k] = el("section", Object.assign(
          { class: "vc-panel vc-stack", id: "vc-p-" + k, role: "tabpanel" }, i ? { hidden: "" } : {}));
      });
      const tabs = {};
      const headSub = el("div", { class: "vc-head-sub" }, "Wearable \u00b7 AI \u00b7 Score");
      const roleBadge = el("button", { class: "vc-role-badge", "aria-label": "Change role" }, "Patient");
      roleBadge.addEventListener("click", () => showRolePicker(true));
      const tabRow = el("div", { class: "vc-tabs", role: "tablist" });
      const RENDER = { device: renderDevice, ai: renderAI, score: renderScore,
                       passport: renderPassport, meds: renderMeds, sos: renderSOS,
                       reports: renderReports };
      const select = (key) => {
        Object.keys(panels).forEach((k) => {
          panels[k].hidden = k !== key;
          tabs[k].setAttribute("aria-selected", String(k === key));
        });
        RENDER[key](panels[key]);
        // remind the reader whose view this is, and what it is for
        const r = Role.get();
        if (r && panels[key].firstChild) {
          panels[key].insertBefore(el("div", { class: "vc-role-note" }, r.note), panels[key].firstChild);
        }
        // keep the chosen tab on screen when the strip is scrolled sideways
        if (tabs[key] && tabs[key].scrollIntoView) {
          try { tabs[key].scrollIntoView({ inline: "nearest", block: "nearest" }); }
          catch (e) { /* older webviews */ }
        }
      };
      Shell.go = (key) => { overlay.hidden = false; select(key); };
      [["device", "Wearable"], ["ai", "AI Analysis"], ["score", "Health Score"],
       ["passport", "Passport"], ["meds", "Medication"], ["sos", "Emergency"],
       ["reports", "Reports"]].forEach(([k, label]) => {
        tabs[k] = el("button", { class: "vc-tab", role: "tab", "aria-selected": String(k === "device"),
                                 "aria-controls": "vc-p-" + k, onclick: () => select(k) }, label);
        tabRow.appendChild(tabs[k]);
      });

      /* Show only the tools this role needs, and land on one they can see. */
      const applyRole = () => {
        const r = activeRole();
        ALL_KEYS.forEach((k) => {
          const allowed = r.tabs.indexOf(k) !== -1;
          tabs[k].hidden = !allowed;
          if (!allowed) panels[k].hidden = true;
        });
        roleBadge.textContent = r.name;
        if (Shell.paintRoleChip) Shell.paintRoleChip();
        // the subtitle should list only what this role can actually open
        const LABEL = { device: "Wearable", ai: "AI", score: "Score", passport: "Passport",
                        meds: "Medication", sos: "Alarm", reports: "Reports" };
        headSub.textContent = r.tabs.map((k) => LABEL[k]).join(" \u00b7 ");
        roleBadge.setAttribute("title", "Using Vitalyn as: " + r.name + " \u2014 tap to change");
        const visible = ALL_KEYS.filter((k) => r.tabs.indexOf(k) !== -1);
        const current = ALL_KEYS.find((k) => tabs[k].getAttribute("aria-selected") === "true");
        select(visible.indexOf(current) !== -1 ? current : visible[0]);
      };
      Shell.applyRole = applyRole;

      const overlay = el("div", { class: "vc-overlay", role: "dialog", "aria-modal": "true",
                                  "aria-label": "Vitalyn care tools", hidden: "" }, [
        el("div", { class: "vc-head" }, [
          el("div", {}, [
            el("div", { class: "vc-head-title" }, "Care tools"),
            headSub,
          ]),
          el("div", { class: "vc-head-spacer" }),
          roleBadge,
          el("button", { class: "vc-close", "aria-label": "Close care tools",
                         onclick: () => { overlay.hidden = true; launcher.focus(); } }, "\u00d7"),
        ]),
        tabRow,
        el("div", { class: "vc-body vc-stack" }, KEYS.map((k) => panels[k])),
      ]);

      /* full-screen alarm state, kept outside the overlay so it covers everything */
      const live = el("div", { class: "vc-alarm-live", role: "alertdialog", "aria-label": "Emergency alarm sounding", hidden: "" }, [
        el("div", { class: "vc-alarm-title" }, "ALARM SOUNDING"),
        el("div", { class: "vc-alarm-count" }, "0:00"),
        el("p", { class: "vc-alarm-sub" }, "Alerting your emergency contacts with your location."),
        el("div", { class: "vc-alarm-report" }),
        el("button", { class: "vc-alarm-stop", onclick: stopAlarm }, "Stop alarm"),
      ]);

      const bar = el("div", { class: "vc-alarm-bar", role: "status", hidden: "" }, [
        el("span", { class: "vc-alarm-bar-pulse", "aria-hidden": "true" }),
        el("div", { class: "vc-alarm-bar-text" }, [
          el("span", { class: "vc-alarm-bar-title" }, "Emergency alarm sounding"),
          el("span", { class: "vc-alarm-bar-sub" }, "0:00"),
        ]),
        el("button", { class: "vc-alarm-bar-stop", onclick: stopAlarm }, "Stop alarm"),
      ]);

      /* The app's own SOS controls live inside the React bundle, which we do not
         touch. Delegating from document lets those buttons sound the siren
         without the bundle knowing this code exists. Capture phase, so it still
         runs if the app stops propagation. */
      const FIRE = ".sos-button, .sidebar-sos, .topbar-sos, .quick-action-danger";
      document.addEventListener("click", (e) => {
        const node = e.target instanceof Element ? e.target : null;
        if (!node || node.closest(".vc-overlay, .vc-alarm-live, .vc-alarm-bar")) return;
        if (node.closest(FIRE)) { triggerAlarm("bar"); return; }
        const action = node.closest(".modal-actions .btn");
        if (!action) return;
        // "Send Alert" keeps it going; "Cancel" means it was a false alarm.
        if (action.classList.contains("btn-secondary")) stopAlarm();
        else triggerAlarm("bar");
      }, true);

      launcher.addEventListener("click", () => { overlay.hidden = false; select("device"); });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (!$(".vc-scan").hidden) { $(".vc-scan").hidden = true; return; }
        if (!live.hidden || !bar.hidden) stopAlarm();
        else if (!overlay.hidden) overlay.hidden = true;
      });

      /* Always-visible device chip: status, battery and last sync without
         opening anything. Lives outside #root so React re-renders can't wipe it. */
      const NS = "http://www.w3.org/2000/svg";
      const R = 23, CIRC = 2 * Math.PI * R;
      const ring = document.createElementNS(NS, "svg");
      ring.setAttribute("viewBox", "0 0 54 54");
      ring.setAttribute("aria-hidden", "true");
      const arc = (cls) => {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", "27"); c.setAttribute("cy", "27"); c.setAttribute("r", String(R));
        c.setAttribute("fill", "none"); c.setAttribute("stroke-width", "4");
        c.setAttribute("stroke-linecap", "round"); c.setAttribute("class", cls);
        return c;
      };
      const track = arc("vc-devchip-track");
      const fill = arc("vc-devchip-fill");
      fill.setAttribute("stroke-dasharray", String(CIRC));
      fill.setAttribute("stroke-dashoffset", String(CIRC));
      ring.appendChild(track); ring.appendChild(fill);

      const chipLed = el("span", { class: "vc-devchip-led", "aria-hidden": "true" });
      const chipPct = el("span", { class: "vc-devchip-pct" }, "");
      const chipIcon = el("img", { class: "vc-devchip-idle", src: "./assets/vitalyn-mark.png", alt: "" });
      const chip = el("button", { class: "vc-devchip", hidden: "",
                                  "aria-label": "Wearable status" }, [
        ring, chipPct, chipIcon, chipLed,
      ]);
      chip.addEventListener("click", () => Shell.go("device"));

      const paintChip = () => {
        const L = window.VitalynBLE && window.VitalynBLE.Link;
        chip.hidden = !document.querySelector(".app-shell");
        if (!L || chip.hidden) return;
        const st = L.status;
        chipLed.className = "vc-devchip-led " +
          ({ connected: "on", connecting: "warn", reconnecting: "warn", error: "err" }[st] || "");
        const b = L.data.battery;
        const showPct = st === "connected" && b != null;
        chipPct.textContent = showPct ? b + "%" : "";
        chipPct.hidden = !showPct;
        chipIcon.hidden = showPct;
        fill.setAttribute("stroke-dashoffset", String(showPct ? CIRC * (1 - b / 100) : CIRC));
        fill.setAttribute("class", "vc-devchip-fill" +
          (b != null && b <= 10 ? " crit" : b != null && b <= 25 ? " low" : ""));

        const name = st === "connected" ? ((L.device && L.device.name) || "Band") : "No band paired";
        const sync = st === "connected" ? "synced " + ago(L.lastSeen)
                   : ({ connecting: "pairing", reconnecting: "reconnecting",
                        error: "connection failed" }[st] || "tap to pair");
        chip.setAttribute("aria-label",
          `Wearable: ${name}, ${sync}${showPct ? ", battery " + b + "%" : ""}`);
        chip.setAttribute("title", `${name} \u00b7 ${sync}${showPct ? " \u00b7 " + b + "%" : ""}`);
      };
      if (window.VitalynBLE) window.VitalynBLE.Link.on(paintChip);
      setInterval(paintChip, 1000);
      /* Role chip, visible on the dashboard itself so the role can be set
         without opening Care tools first. */
      const roleIni = el("span", { class: "vc-rolechip-ini" }, "PT");
      const roleCap = el("span", { class: "vc-rolechip-cap" }, "ROLE");
      const roleChip = el("button", { class: "vc-rolechip", "aria-label": "Change who is using Vitalyn" }, [
        roleIni, roleCap, el("span", { class: "vc-rolechip-edit", "aria-hidden": "true" }, "\u270e"),
      ]);
      roleChip.addEventListener("click", () => showRolePicker(true));
      Shell.paintRoleChip = () => {
        const r = Role.get();
        roleIni.textContent = r ? r.short : "?";
        roleCap.textContent = r ? r.cap : "SET";
        roleChip.setAttribute("title", r ? "Using Vitalyn as " + r.name + " \u2014 tap to change"
                                         : "Tap to choose who is using Vitalyn");
      };

      const dock = el("div", { class: "vc-dock" }, [roleChip, chip, launcher]);
      /* Role picker. Shown once on first entry, and whenever the badge is tapped. */
      const rolePick = el("div", { class: "vc-role-pick", role: "dialog",
                                   "aria-modal": "true", "aria-label": "Choose your role",
                                   hidden: "" });

      function showRolePicker(canCancel) {
        const current = Role.get();
        rolePick.textContent = "";
        const list = el("div", { class: "vc-role-list" });
        ROLES.forEach((r) => {
          list.appendChild(el("button", {
            class: "vc-role-opt",
            "aria-current": String(!!current && current.id === r.id),
            onclick: () => {
              Role.set(r.id);
              rolePick.hidden = true;
              applyRole();
              overlay.hidden = false;
              toast("Using Vitalyn as " + r.name);
            },
          }, [
            el("span", { class: "vc-role-ic" }, r.short),
            el("span", { class: "vc-role-txt" }, [
              el("span", { class: "vc-role-name" }, r.name),
              el("span", { class: "vc-role-blurb" }, r.blurb),
            ]),
          ]));
        });

        const card = el("div", { class: "vc-role-card" }, [
          el("div", { class: "vc-role-title" }, "Who is using Vitalyn?"),
          el("div", { class: "vc-role-sub" },
            "This decides which tools you see. You can change it any time from the Care tools header."),
          list,
        ]);
        if (canCancel) {
          card.appendChild(el("div", { class: "vc-row", style: "margin-top:16px;justify-content:flex-end" },
            el("button", { class: "vc-btn vc-btn-ghost",
                           onclick: () => { rolePick.hidden = true; } }, "Cancel")));
        }
        rolePick.appendChild(card);
        rolePick.hidden = false;
      }
      Shell.showRolePicker = showRolePicker;
      document.body.appendChild(rolePick);

      document.body.appendChild(dock);
      paintChip();
      document.body.appendChild(overlay);
      document.body.appendChild(live);
      document.body.appendChild(bar);
      const scan = el("div", { class: "vc-scan", role: "dialog", "aria-modal": "true",
                               "aria-label": "Emergency medical record", hidden: "" });
      scan.addEventListener("click", (e) => { if (e.target === scan) scan.hidden = true; });
      document.body.appendChild(scan);

      /* only show the launcher once the user is inside the app shell */
      let askedRole = false;
      const sync = () => {
        const inApp = !!document.querySelector(".app-shell");
        dock.style.display = inApp ? "" : "none";
        // ask once, the first time the user lands inside the app
        if (inApp && !askedRole && !Role.get()) { askedRole = true; showRolePicker(false); }
      };
      sync(); setInterval(sync, 800);

      applyRole();
      setInterval(() => { Meds.check(); Meds.schedule(); }, 15000);
      Meds.check(); Meds.schedule();

      /* Install prompt. Chrome fires beforeinstallprompt; iOS Safari never
         does, so it gets instructions instead. */
      const installed = () =>
        window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
      let deferred = null;
      const panel = el("div", { class: "vc-install", hidden: "" }, [
        el("img", { src: "./assets/icon-192.png", alt: "" }),
        el("div", { class: "vc-install-text" }, [
          el("span", { class: "vc-install-title" }, "Install Vitalyn"),
          el("span", { class: "vc-install-sub" }, "Full screen, works offline"),
        ]),
        el("button", { class: "vc-install-go", onclick: async () => {
          if (deferred) { deferred.prompt(); const r = await deferred.userChoice;
            deferred = null; panel.hidden = true;
            toast(r.outcome === "accepted" ? "Installing Vitalyn" : "Install dismissed"); }
          else { toast("In Safari: Share, then Add to Home Screen"); }
        } }, "Install"),
        el("button", { class: "vc-install-x", "aria-label": "Dismiss",
                       onclick: () => { panel.hidden = true; store.set("noinstall", 1); } }, "\u00d7"),
      ]);
      document.body.appendChild(panel);

      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const maybeShow = () => {
        if (installed() || store.get("noinstall", 0)) return;
        if (deferred) panel.hidden = false;
        else if (isIOS) { $(".vc-install-sub", panel).textContent = "Share \u2192 Add to Home Screen"; panel.hidden = false; }
      };
      window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; maybeShow(); });
      window.addEventListener("appinstalled", () => { panel.hidden = true; toast("Vitalyn installed"); });
      setTimeout(maybeShow, 4000);
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => Shell.mount());
  else Shell.mount();

  window.VitalynCare = { Meds, Alarm, Reports, Vitals, Passport, Shell, RANGES };
})();
