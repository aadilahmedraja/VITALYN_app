/* ============================================================================
   Vitalyn — Bluetooth LE wearable link

   Connects to a real BLE wristband over Web Bluetooth and streams standard
   GATT health characteristics into the app: heart rate, SpO2, temperature,
   battery and connection state.

   Uses the adopted Bluetooth SIG profiles, so this works with any compliant
   band (Polar, Wahoo, most chest straps, many generic fitness bands) rather
   than one vendor's proprietary protocol.

   Web Bluetooth runs in Chrome/Edge on Android, Windows, macOS and Linux.
   It is NOT available in Safari or on iOS at all, and it requires HTTPS.
   Where it is unavailable the panel says so and offers a simulated band so
   the rest of the app can still be demonstrated.
   ========================================================================= */
(function () {
  "use strict";

  const UUID = {
    heartRate: 0x180d, heartRateMeas: 0x2a37,
    battery: 0x180f, batteryLevel: 0x2a19,
    thermometer: 0x1809, tempMeas: 0x2a1c,
    pulseOx: 0x1822, plxContinuous: 0x2a5f,
    deviceInfo: 0x180a, manufacturer: 0x2a29, model: 0x2a24, firmware: 0x2a26,
  };

  /* ----------------------------------------------------------- parsers ---- */
  /* Kept pure and exported so they can be unit tested without hardware. */
  const Parse = {
    /** Heart Rate Measurement, 0x2A37. */
    heartRate(dv) {
      const flags = dv.getUint8(0);
      const wide = flags & 0x01;
      let i = 1;
      const bpm = wide ? dv.getUint16(i, true) : dv.getUint8(i);
      i += wide ? 2 : 1;
      const out = { bpm, contact: null, rr: [] };
      // bits 1-2: sensor contact status (bit2 = supported, bit1 = detected)
      if (flags & 0x04) out.contact = !!(flags & 0x02);
      if (flags & 0x08) i += 2;                       // energy expended, skipped
      if (flags & 0x10) {
        for (; i + 1 < dv.byteLength; i += 2) {
          out.rr.push(+(dv.getUint16(i, true) / 1024).toFixed(4)); // 1/1024 s -> s
        }
      }
      return out;
    },

    /** Battery Level, 0x2A19 — a single percentage byte. */
    battery(dv) { return dv.getUint8(0); },

    /** IEEE-11073 32-bit FLOAT: 24-bit signed mantissa, 8-bit signed exponent. */
    float32(dv, off) {
      const raw = dv.getUint32(off, true);
      let mantissa = raw & 0x00ffffff;
      const exponent = (raw >> 24) & 0xff;
      if (mantissa === 0x007fffff) return NaN;        // reserved: NaN
      if (mantissa & 0x00800000) mantissa = -((0x01000000 - mantissa) & 0x00ffffff);
      const exp = exponent > 127 ? exponent - 256 : exponent;
      return mantissa * Math.pow(10, exp);
    },

    /** IEEE-11073 16-bit SFLOAT: 12-bit signed mantissa, 4-bit signed exponent. */
    sfloat(dv, off) {
      const raw = dv.getUint16(off, true);
      let mantissa = raw & 0x0fff;
      const exponent = (raw >> 12) & 0x0f;
      if (mantissa === 0x07ff) return NaN;            // reserved: NaN
      if (mantissa & 0x0800) mantissa = -((0x1000 - mantissa) & 0x0fff);
      const exp = exponent > 7 ? exponent - 16 : exponent;
      return mantissa * Math.pow(10, exp);
    },

    /** Temperature Measurement, 0x2A1C. Returns degrees Celsius. */
    temperature(dv) {
      const flags = dv.getUint8(0);
      let v = Parse.float32(dv, 1);
      if (flags & 0x01) v = (v - 32) * 5 / 9;         // reported in Fahrenheit
      return v;
    },

    /** PLX Continuous Measurement, 0x2A5F. SpO2 % and pulse rate. */
    plx(dv) {
      // flags byte, then SpO2 SFLOAT, then PR SFLOAT
      return { spo2: Parse.sfloat(dv, 1), pulse: Parse.sfloat(dv, 3) };
    },
  };

  /* -------------------------------------------------------------- link ---- */
  const Link = {
    device: null, server: null,
    status: "idle",            // idle | connecting | connected | reconnecting | error
    info: {},                  // manufacturer / model / firmware
    data: { bpm: null, spo2: null, temp: null, battery: null, rr: [], hrv: null },
    lastSeen: null,
    sim: null,                 // interval handle when simulating
    retries: 0,
    listeners: [],

    on(fn) { this.listeners.push(fn); },
    emit() { this.listeners.forEach((f) => { try { f(this); } catch (e) { /* keep going */ } }); },

    /** True when the Android shell's native Bluetooth bridge is present. */
    hasNative() {
      return typeof window !== "undefined" && !!window.VitalynNativeBLE
             && window.VitalynNativeBLE.isAvailable();
    },

    supported() {
      if (this.hasNative()) return true;
      return typeof navigator !== "undefined" && !!navigator.bluetooth;
    },

    /* ---------------- native (Android APK) path ---------------------------
       The WebView has no Web Bluetooth, so the Java bridge scans and streams
       raw characteristic bytes here as hex. Parsing stays in JS so there is
       one tested implementation rather than two. */
    nativeDevices: [],

    /* A sideloaded APK cannot be attached to a debugger, so the app keeps its
       own log and shows it in the Wearable panel. */
    log: [],
    note(text) {
      const t = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      this.log.push(`${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}  ${text}`);
      if (this.log.length > 60) this.log.shift();
    },

    /** Names whichever precondition is blocking a scan, in plain language. */
    checkReadiness() {
      if (!this.hasNative()) return { ok: true, message: "Ready" };
      let d;
      try { d = JSON.parse(window.VitalynNativeBLE.diagnose()); }
      catch (e) { return { ok: true, message: "Ready" }; }
      this.diag = d;
      if (!d.adapter) return { ok: false, message: "This phone reports no Bluetooth hardware" };
      if (!d.bluetoothOn) return { ok: false, message: "Bluetooth is switched off \u2014 turn it on in Settings" };
      if (!d.locationPermission) {
        return { ok: false, fix: "permission",
                 message: "Android needs Location permission before it will return Bluetooth scan results. Vitalyn never reads your location." };
      }
      if (!d.locationServices) {
        return { ok: false, message: "Location services are switched off. Android returns no Bluetooth devices until you turn them on in Settings." };
      }
      return { ok: true, message: "Ready" };
    },

    requestPermissions() {
      if (this.hasNative() && window.VitalynNativeBLE.requestPermissions) {
        window.VitalynNativeBLE.requestPermissions();
      }
    },

    hexToView(hex) {
      const n = hex.length / 2;
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
      return new DataView(b.buffer);
    },

    handleNative(ev) {
      const N = window.VitalynNativeBLE;
      if (ev.type === "scanning") this.note("Scan started");
      else if (ev.type === "device") this.note(`Found: ${ev.name} (${ev.rssi} dBm)`);
      else if (ev.type === "scanEnded") this.note(`Scan finished \u2014 ${this.nativeDevices.length} device(s)`);
      else if (ev.type === "connecting") this.note("Connecting\u2026");
      else if (ev.type === "connected") this.note("Connected \u2014 discovering services");
      else if (ev.type === "services") this.note("Services: " + ((ev.found && ev.found.length) ? ev.found.join(", ") : "none usable"));
      else if (ev.type === "disconnected") this.note("Disconnected");
      else if (ev.type === "error") this.note("Error: " + (ev.message || "unknown"));
      switch (ev.type) {
        case "scanning":
          this.nativeDevices = [];
          this.set("connecting");
          break;
        case "device": {
          if (!this.nativeDevices.some((d) => d.address === ev.address)) {
            this.nativeDevices.push({ address: ev.address, name: ev.name, rssi: ev.rssi });
          }
          this.emit();
          break;
        }
        case "scanEnded":
          if (this.status === "connecting" && !this.device) this.set("idle");
          this.emit();
          break;
        case "connecting":
          this.set("connecting");
          break;
        case "connected":
          this.device = this.device || { name: "Wearable" };
          this.retries = 0;
          this.lastSeen = Date.now();
          this.set("connected");
          break;
        case "disconnected":
          if (this.status !== "idle") this.set("reconnecting");
          break;
        case "services":
          this.found = ev.found || [];
          this.set("connected");
          break;
        case "value": {
          const dv = this.hexToView(ev.hex || "");
          if (!dv.byteLength) break;
          try {
            if (ev.uuid === "2a37") {
              const r = Parse.heartRate(dv);
              this.data.bpm = r.bpm;
              if (r.rr.length) {
                this.data.rr = this.data.rr.concat(r.rr).slice(-60);
                this.data.hrv = this.rmssd(this.data.rr);
              }
            } else if (ev.uuid === "2a19") {
              this.data.battery = Parse.battery(dv);
            } else if (ev.uuid === "2a1c") {
              const v = Parse.temperature(dv);
              if (!isNaN(v)) this.data.temp = v;
            } else if (ev.uuid === "2a5f") {
              const r = Parse.plx(dv);
              if (!isNaN(r.spo2)) this.data.spo2 = r.spo2;
              if (!isNaN(r.pulse) && !this.data.bpm) this.data.bpm = Math.round(r.pulse);
            } else if (ev.uuid === "2a29" || ev.uuid === "2a24" || ev.uuid === "2a26") {
              let txt = "";
              for (let i = 0; i < dv.byteLength; i++) {
                const c = dv.getUint8(i);
                if (c >= 32 && c < 127) txt += String.fromCharCode(c);
              }
              const key = ev.uuid === "2a29" ? "manufacturer"
                        : ev.uuid === "2a24" ? "model" : "firmware";
              this.info[key] = txt.trim();
            }
          } catch (e) { /* malformed packet, skip */ }
          this.lastSeen = Date.now();
          this.emit();
          break;
        }
        case "error":
          this.lastError = ev.message || "Bluetooth error";
          if (!this.device) this.set("error");
          break;
        default:
          this.emit();
      }
    },

    nativeScan() {
      if (!this.hasNative()) return false;
      if (!window.VitalynNativeBLE.isEnabled()) {
        this.lastError = "Bluetooth is switched off on this phone";
        this.set("error");
        return false;
      }
      const ready = this.checkReadiness();
      if (!ready.ok) {
        this.note("Cannot scan: " + ready.message);
        this.lastError = ready.message;
        this.set("error");
        if (ready.fix === "permission") this.requestPermissions();
        return false;
      }
      this.stopSim();
      this.nativeDevices = [];
      window.VitalynNativeBLE.startScan();
      return true;
    },

    nativeConnect(address, name) {
      if (!this.hasNative()) return;
      this.device = { name: name || "Wearable" };
      window.VitalynNativeBLE.connect(address);
    },

    set(status) { this.status = status; this.emit(); },

    /**
     * Opens the browser's device chooser, then subscribes to what it finds.
     * @param {boolean} showAll list every BLE device instead of only those
     *   advertising a health service. Some watches have the services but do
     *   not put them in the advertising packet, so they never appear in the
     *   filtered list.
     */
    async connect(showAll) {
      if (!this.supported()) throw new Error("unsupported");
      this.stopSim();
      this.set("connecting");
      this.found = [];
      try {
        const wanted = [UUID.battery, UUID.deviceInfo, UUID.thermometer,
                        UUID.pulseOx, UUID.heartRate];
        const device = await navigator.bluetooth.requestDevice(
          showAll
            ? { acceptAllDevices: true, optionalServices: wanted }
            : {
                filters: [
                  { services: [UUID.heartRate] },
                  { services: [UUID.pulseOx] },
                  { services: [UUID.thermometer] },
                ],
                optionalServices: wanted,
              });
        this.device = device;
        device.addEventListener("gattserverdisconnected", () => this.onDrop());
        await this.attach();
        this.retries = 0;
      } catch (e) {
        // user closing the chooser is not an error worth shouting about
        this.set(e && e.name === "NotFoundError" ? "idle" : "error");
        throw e;
      }
    },

    async attach() {
      this.server = await this.device.gatt.connect();
      this.found = [];
      await this.readInfo();
      if (await this.subBattery()) this.found.push("Battery");
      if (await this.subHeartRate()) this.found.push("Heart Rate");
      if (await this.subTemp()) this.found.push("Temperature");
      if (await this.subPulseOx()) this.found.push("SpO\u2082");
      this.lastSeen = Date.now();
      this.set("connected");
    },

    /** What the connected device actually offered. Empty means paired but mute. */
    found: [],

    async readInfo() {
      try {
        const s = await this.server.getPrimaryService(UUID.deviceInfo);
        const dec = new TextDecoder();
        for (const [key, uuid] of [["manufacturer", UUID.manufacturer],
                                   ["model", UUID.model], ["firmware", UUID.firmware]]) {
          try { this.info[key] = dec.decode(await (await s.getCharacteristic(uuid)).readValue()).trim(); }
          catch (e) { /* optional */ }
        }
      } catch (e) { /* service absent */ }
    },

    async subBattery() {
      try {
        const s = await this.server.getPrimaryService(UUID.battery);
        const c = await s.getCharacteristic(UUID.batteryLevel);
        this.data.battery = Parse.battery(await c.readValue());
        try {
          await c.startNotifications();
          c.addEventListener("characteristicvaluechanged", (e) => {
            this.data.battery = Parse.battery(e.target.value);
            this.lastSeen = Date.now(); this.emit();
          });
        } catch (e) { /* read-only battery is fine */ }
        return true;
      } catch (e) { return false; }
    },

    async subHeartRate() {
      try {
        const s = await this.server.getPrimaryService(UUID.heartRate);
        const c = await s.getCharacteristic(UUID.heartRateMeas);
        await c.startNotifications();
        c.addEventListener("characteristicvaluechanged", (e) => {
          const r = Parse.heartRate(e.target.value);
          this.data.bpm = r.bpm;
          if (r.rr.length) {
            this.data.rr = this.data.rr.concat(r.rr).slice(-60);
            this.data.hrv = this.rmssd(this.data.rr);
          }
          this.lastSeen = Date.now(); this.emit();
        });
        return true;
      } catch (e) { return false; }
    },

    async subTemp() {
      try {
        const s = await this.server.getPrimaryService(UUID.thermometer);
        const c = await s.getCharacteristic(UUID.tempMeas);
        await c.startNotifications();
        c.addEventListener("characteristicvaluechanged", (e) => {
          const v = Parse.temperature(e.target.value);
          if (!isNaN(v)) this.data.temp = v;
          this.lastSeen = Date.now(); this.emit();
        });
        return true;
      } catch (e) { return false; }
    },

    async subPulseOx() {
      try {
        const s = await this.server.getPrimaryService(UUID.pulseOx);
        const c = await s.getCharacteristic(UUID.plxContinuous);
        await c.startNotifications();
        c.addEventListener("characteristicvaluechanged", (e) => {
          const r = Parse.plx(e.target.value);
          if (!isNaN(r.spo2)) this.data.spo2 = r.spo2;
          if (!isNaN(r.pulse) && !this.data.bpm) this.data.bpm = Math.round(r.pulse);
          this.lastSeen = Date.now(); this.emit();
        });
        return true;
      } catch (e) { return false; }
    },

    /** RMSSD in ms — the standard short-term HRV measure. */
    rmssd(rr) {
      if (rr.length < 3) return null;
      let sum = 0;
      for (let i = 1; i < rr.length; i++) {
        const d = (rr[i] - rr[i - 1]) * 1000;
        sum += d * d;
      }
      return Math.round(Math.sqrt(sum / (rr.length - 1)));
    },

    /** A band going out of range should recover on its own, with backoff. */
    onDrop() {
      if (this.sim) return;
      this.set("reconnecting");
      const delay = Math.min(30000, 1000 * Math.pow(2, this.retries++));
      setTimeout(async () => {
        if (!this.device || this.status === "idle") return;
        try { await this.attach(); }
        catch (e) { this.retries < 6 ? this.onDrop() : this.set("error"); }
      }, delay);
    },

    disconnect() {
      this.stopSim();
      if (this.hasNative()) {
        try { window.VitalynNativeBLE.stopScan(); window.VitalynNativeBLE.disconnect(); }
        catch (e) { /* bridge gone */ }
      }
      this.nativeDevices = [];
      this.retries = 0;
      try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) {}
      this.device = null; this.server = null; this.found = [];
      this.data = { bpm: null, spo2: null, temp: null, battery: null, rr: [], hrv: null };
      this.info = {};
      this.set("idle");
    },

    /* ---- simulated band, for iOS/Safari and for demoing without hardware -- */
    startSim() {
      this.stopSim();
      this.device = { name: "Vitalyn Band (simulated)" };
      this.info = { manufacturer: "Vitalyn", model: "VB-1 Demo", firmware: "1.0.0" };
      this.data.battery = 87;
      let bpm = 74, spo2 = 97.5, temp = 36.8, tick = 0;
      const step = () => {
        tick++;
        bpm = Math.max(52, Math.min(150, bpm + (Math.random() - 0.5) * 5));
        spo2 = Math.max(90, Math.min(100, spo2 + (Math.random() - 0.5) * 0.6));
        temp = Math.max(36, Math.min(38.6, temp + (Math.random() - 0.5) * 0.08));
        this.data.bpm = Math.round(bpm);
        this.data.spo2 = +spo2.toFixed(1);
        this.data.temp = +temp.toFixed(1);
        // plausible beat-to-beat intervals so the HRV figure means something
        const base = 60 / this.data.bpm;
        this.data.rr = this.data.rr.concat([+(base + (Math.random() - 0.5) * 0.05).toFixed(4)]).slice(-60);
        this.data.hrv = this.rmssd(this.data.rr);
        if (tick % 30 === 0 && this.data.battery > 1) this.data.battery--;
        this.lastSeen = Date.now();
        this.emit();
      };
      step();
      this.sim = setInterval(step, 1000);
      this.set("connected");
    },

    stopSim() { if (this.sim) { clearInterval(this.sim); this.sim = null; } },
    isSim() { return !!this.sim; },
  };

  /* The Java bridge calls this. */
  window.VitalynNativeEvent = function (ev) {
    try { Link.handleNative(ev || {}); } catch (e) { /* never throw into Java */ }
  };

  window.VitalynBLE = { Link, Parse, UUID };
})();
