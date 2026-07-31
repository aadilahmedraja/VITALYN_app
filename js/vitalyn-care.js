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

  /* ------------------------------------------------------------ 4. shell */
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

      const panels = {
        meds: el("section", { class: "vc-panel vc-stack", id: "vc-p-meds", role: "tabpanel" }),
        sos: el("section", { class: "vc-panel vc-stack", id: "vc-p-sos", role: "tabpanel", hidden: "" }),
        reports: el("section", { class: "vc-panel vc-stack", id: "vc-p-reports", role: "tabpanel", hidden: "" }),
      };
      const tabs = {};
      const tabRow = el("div", { class: "vc-tabs", role: "tablist" });
      const select = (key) => {
        Object.keys(panels).forEach((k) => {
          panels[k].hidden = k !== key;
          tabs[k].setAttribute("aria-selected", String(k === key));
        });
        if (key === "meds") renderMeds(panels.meds);
        if (key === "sos") renderSOS(panels.sos);
        if (key === "reports") renderReports(panels.reports);
      };
      [["meds", "Medication"], ["sos", "Emergency"], ["reports", "Reports"]].forEach(([k, label]) => {
        tabs[k] = el("button", { class: "vc-tab", role: "tab", "aria-selected": String(k === "meds"),
                                 "aria-controls": "vc-p-" + k, onclick: () => select(k) }, label);
        tabRow.appendChild(tabs[k]);
      });

      const overlay = el("div", { class: "vc-overlay", role: "dialog", "aria-modal": "true",
                                  "aria-label": "Vitalyn care tools", hidden: "" }, [
        el("div", { class: "vc-head" }, [
          el("div", {}, [
            el("div", { class: "vc-head-title" }, "Care tools"),
            el("div", { class: "vc-head-sub" }, "Medication · Emergency alarm · Reports"),
          ]),
          el("div", { class: "vc-head-spacer" }),
          el("button", { class: "vc-close", "aria-label": "Close care tools",
                         onclick: () => { overlay.hidden = true; launcher.focus(); } }, "\u00d7"),
        ]),
        tabRow,
        el("div", { class: "vc-body vc-stack" }, [panels.meds, panels.sos, panels.reports]),
      ]);

      /* full-screen alarm state, kept outside the overlay so it covers everything */
      const live = el("div", { class: "vc-alarm-live", role: "alertdialog", "aria-label": "Emergency alarm sounding", hidden: "" }, [
        el("div", { class: "vc-alarm-title" }, "ALARM SOUNDING"),
        el("div", { class: "vc-alarm-count" }, "0:00"),
        el("p", { class: "vc-alarm-sub" }, "Your emergency contacts would be notified here, and your location shared."),
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

      launcher.addEventListener("click", () => { overlay.hidden = false; select("meds"); });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (!live.hidden || !bar.hidden) stopAlarm();
        else if (!overlay.hidden) overlay.hidden = true;
      });

      document.body.appendChild(launcher);
      document.body.appendChild(overlay);
      document.body.appendChild(live);
      document.body.appendChild(bar);

      /* only show the launcher once the user is inside the app shell */
      const sync = () => { launcher.style.display = document.querySelector(".app-shell") ? "" : "none"; };
      sync(); setInterval(sync, 800);

      setInterval(() => Meds.check(), 15000);
      Meds.check();
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => Shell.mount());
  else Shell.mount();

  window.VitalynCare = { Meds, Alarm, Reports, Shell };
})();
