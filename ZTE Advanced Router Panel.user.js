// ==UserScript==
// @name         ZTE Advanced Router Panel
// @namespace    Cerix
// @version      2026-v5.3
// @description  ZTE signal monitor: eNodeB, BTS scan, force-connect, band lock, cell lock, bridge mode, DNS, NR CA, traffic stats, device info, GPS
// @author       Cerix
// @match        http://192.168.192.1/*
// @match        http://192.168.0.1/*
// @match        http://192.168.1.1/*
// @match        http://192.168.8.1/*
// @match        http://192.168.254.1/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ─────────────────────────────────────────────
  //  CONFIGURATION
  // ─────────────────────────────────────────────
  var CFG = {
    version: "2026-v5.3",
    bmac: true, // set false to hide the Buy Me a Coffee section
    pollInterval: 1000,
    trafficPollInterval: 2000,
    devicePollInterval: 60000,
    logoutPrevention: 60000,
    initRetryInterval: 250,
    maxInitRetries: 200,
    toastDuration: 4000,
    scanInterval: 3000,
    scanTotalTime: 18000,
    ajaxTimeout: 10000,
  };

  // ─────────────────────────────────────────────
  //  SIGINFO — Router API fields
  // ─────────────────────────────────────────────
  var SIGINFO =
    "wan_active_band,wan_active_channel,wan_lte_ca,wan_apn,wan_ipaddr," +
    "cell_id,dns_mode,prefer_dns_manual,standby_dns_manual,network_type," +
    "network_provider_fullname,rmcc,rmnc,ip_passthrough_enabled,bandwidth,tx_power," +
    "rscp_1,ecio_1,rscp_2,ecio_2,rscp_3,ecio_3,rscp_4,ecio_4," +
    "ngbr_cell_info,lte_multi_ca_scell_info,lte_multi_ca_scell_sig_info," +
    "lte_band,lte_rsrp,lte_rsrq,lte_rssi,lte_snr," +
    "lte_ca_pcell_band,lte_ca_pcell_freq,lte_ca_pcell_bandwidth," +
    "lte_ca_scell_band,lte_ca_scell_bandwidth," +
    "lte_rsrp_1,lte_rsrp_2,lte_rsrp_3,lte_rsrp_4," +
    "lte_snr_1,lte_snr_2,lte_snr_3,lte_snr_4," +
    "lte_pci,lte_pci_lock,lte_earfcn_lock,lte_band_lock," +
    "5g_rx0_rsrp,5g_rx1_rsrp,Z5g_rsrp,Z5g_rsrq,Z5g_SINR," +
    "nr5g_cell_id,nr5g_pci,nr5g_action_channel,nr5g_action_band,nr5g_action_nsa_band," +
    "nr_ca_pcell_band,nr_ca_pcell_freq,nr_multi_ca_scell_info," +
    "nr5g_sa_band_lock,nr5g_nsa_band_lock," +
    "nr5g_nsa_bandwidth,Z5g_rssi," +
    "pm_sensor_ambient,pm_sensor_mdm,pm_sensor_5g,pm_sensor_pa1,wifi_chip_temp";

  var TRAFFICINFO =
    "realtime_tx_thrpt,realtime_rx_thrpt,realtime_tx_bytes,realtime_rx_bytes," +
    "realtime_time,monthly_tx_bytes,monthly_rx_bytes,monthly_time,date_month";

  var DEVICEINFO =
    "modem_main_state,pin_status,imsi,msisdn,imei,wa_inner_version," +
    "hardware_version,web_version,mac_address,lan_ipaddr,ipv6_wan_ipaddr," +
    "opms_wan_mode,pdp_type,lan_domain,gps_lat,gps_lon";

  // ─────────────────────────────────────────────
  //  GLOBAL STATE
  // ─────────────────────────────────────────────
  var S = (window._ZTE_STATE = {
    is_mc888: false,
    is_mc889: false,
    logged_in_as_developer: false,
    hash_fn: null,
    init_done: false,
    signal: {},
    traffic: {},
    device: {},
    init_retry_count: 0,
    scan_running: false,
    scan_results: {},
    scan_timer_id: null,
    scan_stop_id: null,
  });

  // ─────────────────────────────────────────────
  //  UTILITY — eNodeB
  //  In LTE: ECI (28bit) = eNodeB_ID (20bit) << 8 | Cell_ID (8bit)
  //  So: eNodeB = Math.floor(cell_id_dec / 256)
  // ─────────────────────────────────────────────
  function calc_enodeb(cell_id_str) {
    if (!cell_id_str || cell_id_str === "") return null;
    var n =
      /^[0-9a-fA-F]+$/.test(cell_id_str) && !/^\d+$/.test(cell_id_str)
        ? parseInt(cell_id_str, 16)
        : parseInt(cell_id_str, 10);
    if (isNaN(n) || n <= 0) return null;
    return Math.floor(n / 256);
  }

  function cell_id_within_enodeb(cell_id_str) {
    var n = parseInt(cell_id_str, 10);
    if (isNaN(n)) return null;
    return n % 256;
  }

  // ─────────────────────────────────────────────
  //  TOAST NOTIFICATIONS (stacking queue)
  // ─────────────────────────────────────────────
  var toastQueue = [];
  var toastGap = 8;

  function repositionToasts() {
    var top = 18;
    for (var i = 0; i < toastQueue.length; i++) {
      toastQueue[i].style.top = top + "px";
      top += toastQueue[i].offsetHeight + toastGap;
    }
  }

  function removeToast(el) {
    var idx = toastQueue.indexOf(el);
    if (idx > -1) toastQueue.splice(idx, 1);
    if (el.parentNode) el.remove();
    repositionToasts();
  }

  function toast(msg, type) {
    var colors = {
      info: "#1976D2",
      ok: "#388E3C",
      warn: "#F57C00",
      error: "#D32F2F",
    };
    var el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:18px;right:18px;z-index:2147483647;" +
      "background:" +
      colors[type || "info"] +
      ";color:#fff;" +
      "padding:12px 20px;:8px;font-family:Segoe UI,Verdana,sans-serif;" +
      "font-size:13px;box-shadow:0 4px 15px rgba(0,0,0,.25);max-width:360px;" +
      "word-wrap:break-word;transition:opacity .3s, top .3s ease-out;";
    el.textContent = msg;
    document.body.appendChild(el);

    // Add to queue and reposition
    toastQueue.push(el);
    repositionToasts();

    setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () {
        removeToast(el);
      }, 350);
    }, CFG.toastDuration);
  }

  // ─────────────────────────────────────────────
  //  COOKIES
  // ─────────────────────────────────────────────
  var cookies = {
    get: function (n) {
      var b = document.cookie.match("(^|;)\\s*" + n + "\\s*=\\s*([^;]+)");
      return b ? b.pop() : null;
    },
    set: function (n, v) {
      document.cookie =
        n +
        "=" +
        v +
        ";expires=Fri, 31 Dec 9999 23:59:59 GMT;path=/;SameSite=Lax";
    },
    del: function (n) {
      document.cookie = n + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    },
  };

  // ─────────────────────────────────────────────
  //  AJAX with timeout
  // ─────────────────────────────────────────────
  function ajax_get(params, ok, fail) {
    var data = { multi_data: "1" };
    Object.keys(params).forEach(function (k) {
      data[k] = params[k];
    });
    return window.$.ajax({
      type: "GET",
      url: "/goform/goform_get_cmd_process",
      data: data,
      dataType: "json",
      timeout: CFG.ajaxTimeout,
      success: ok,
      error:
        fail ||
        function () {
          zte_set_dot("error");
        },
    });
  }

  function ajax_post(data, ok, fail) {
    return window.$.ajax({
      type: "POST",
      url: "/goform/goform_set_cmd_process",
      data: data,
      timeout: CFG.ajaxTimeout,
      success: ok,
      error:
        fail ||
        function () {
          toast("Router communication error", "error");
        },
    });
  }

  function parse_result(raw) {
    try {
      return typeof raw === "object" ? raw : JSON.parse(raw);
    } catch (e) {
      return { result: "parse_error" };
    }
  }

  function get_ad_token(cb) {
    ajax_get({ cmd: "wa_inner_version,cr_version,RD" }, function (a) {
      if (!a || !a.wa_inner_version) {
        toast("Failed to get AD token", "error");
        return;
      }
      var ad = S.hash_fn(S.hash_fn(a.wa_inner_version + a.cr_version) + a.RD);
      cb(ad, a);
    });
  }

  // ─────────────────────────────────────────────
  //  AUTH
  // ─────────────────────────────────────────────
  function have_hash() {
    return cookies.get("admin_password_hash") !== null;
  }

  function check_login(ok, fail) {
    ajax_get(
      { cmd: "loginfo" },
      function (a) {
        if (a && a.loginfo && a.loginfo.toLowerCase() === "ok") ok && ok();
        else fail && fail();
      },
      fail || null,
    );
  }

  function perform_login(successCb, dev_login, save) {
    dev_login = dev_login || false;
    save = save || false;
    var ph = have_hash() ? cookies.get("admin_password_hash") : "";
    if (!ph) {
      var pw = prompt("Router Password:");
      if (!pw) return;
      ph = window.SHA256
        ? window.SHA256(pw)
        : window.hex_md5
          ? window.hex_md5(pw)
          : pw;
    }
    ajax_get({ cmd: "wa_inner_version,cr_version,RD,LD" }, function (a) {
      var ad = S.hash_fn(S.hash_fn(a.wa_inner_version + a.cr_version) + a.RD);
      ajax_post(
        {
          isTest: "false",
          goformId: dev_login ? "DEVELOPER_OPTION_LOGIN" : "LOGIN",
          password: window.SHA256(ph + a.LD),
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "0") {
            if (save) cookies.set("admin_password_hash", ph);
            toast("Login successful!", "ok");
            successCb && successCb();
          } else {
            var r = "Unknown error";
            if (j.result === "1") r = "Please retry in a few seconds";
            if (j.result === "3") {
              r = "Wrong password";
              if (have_hash()) cookies.del("admin_password_hash");
            }
            toast(
              (dev_login ? "Developer login" : "Login") + " failed: " + r,
              "error",
            );
          }
        },
      );
    });
  }

  window.zte_enable_auto_login = function () {
    if (
      !confirm("Save password as SHA256 hash in a cookie for automatic login?")
    )
      return;
    cookies.del("admin_password_hash");
    perform_login(
      function () {
        toast("Password saved!", "ok");
      },
      false,
      true,
    );
  };

  function prevent_logout() {
    window.$.ajax({
      type: "GET",
      url: "/tmpl/network/apn_setting.html?v=" + Math.round(+new Date() / 1000),
      timeout: 5000,
    });
  }

  // ─────────────────────────────────────────────
  //  CELL INFO CLASSES
  // ─────────────────────────────────────────────
  function LteCaCellInfo(
    pci,
    band,
    earfcn,
    bw,
    rssi,
    rsrp1,
    rsrp2,
    rsrp3,
    rsrp4,
    rsrq,
    sinr1,
    sinr2,
    sinr3,
    sinr4,
  ) {
    this.pci = pci;
    this.band = band;
    this.earfcn = earfcn;
    this.bandwidth = bw;
    this.rssi = rssi;
    this.rsrp1 = rsrp1;
    this.rsrp2 = rsrp2;
    this.rsrp3 = rsrp3;
    this.rsrp4 = rsrp4;
    this.rsrq = rsrq;
    this.sinr1 = sinr1;
    this.sinr2 = sinr2;
    this.sinr3 = sinr3;
    this.sinr4 = sinr4;
  }

  function NrCaCellInfo(pci, band, arfcn, bw, rsrp1, rsrp2, rsrq, sinr) {
    this.pci = pci;
    this.band = band;
    this.arfcn = arfcn;
    this.bandwidth = bw;
    this.rsrp1 = rsrp1;
    this.rsrp2 = rsrp2;
    this.rsrq = rsrq;
    this.sinr = sinr;
    this.info_text = "";
  }

  // ─────────────────────────────────────────────
  //  PARSE LTE CELLS
  // ─────────────────────────────────────────────
  function parse_lte_cells() {
    var d = S.signal;
    if (!d.is_lte) return [];
    var cells = [];
    var mb = d.lte_ca_pcell_band || d.lte_band || "??";
    cells.push(
      new LteCaCellInfo(
        parseInt(d.lte_pci || "0", 16),
        "B" + mb,
        d.lte_ca_pcell_freq || d.wan_active_channel || "",
        (d.lte_ca_pcell_bandwidth || d.bandwidth || "")
          .replace("MHz", "")
          .replace(".0", ""),
        d.lte_rssi || "",
        d.lte_rsrp_1 || "",
        d.lte_rsrp_2 || "",
        d.lte_rsrp_3 || "",
        d.lte_rsrp_4 || "",
        d.lte_rsrq || "",
        d.lte_snr_1 || "",
        d.lte_snr_2 || "",
        d.lte_snr_3 || "",
        d.lte_snr_4 || "",
      ),
    );
    var si = (d.lte_multi_ca_scell_info || "").split(";").filter(Boolean);
    var ss = (d.lte_multi_ca_scell_sig_info || "").split(";").filter(Boolean);
    for (var i = 0; i < si.length; i++) {
      var info = si[i].split(",");
      if (info.length < 6) continue;
      var hs = ss.length > i;
      var sp = hs ? ss[i].split(",") : [];
      if (hs && sp.length < 3) continue;
      cells.push(
        new LteCaCellInfo(
          parseInt(info[1] || "0", 16),
          "B" + info[3],
          info[4],
          (info[5] || "").replace(".0", ""),
          "",
          (hs ? sp[0] : "").replace("-44.0", "?????"),
          "",
          "",
          "",
          hs ? sp[1] : "",
          hs ? sp[2] : "",
          "",
          "",
          "",
        ),
      );
    }
    return cells;
  }

  // ─────────────────────────────────────────────
  //  PARSE NR CELLS
  //  Handles both single 5G cell and NR Carrier Aggregation (NR-CA).
  //  nr_multi_ca_scell_info format: "idx,pci,?,band,arfcn,bw,?,rsrp1,rsrq,sinr,..." per SCell separated by ";"
  // ─────────────────────────────────────────────
  function parse_nr_cells() {
    var d = S.signal;
    if (!d.is_5g) return [];
    if (d.is_5g_nsa && !d.is_5g_nsa_active) return [];

    var rx0 = d._5g_rx0_rsrp || d.Z5g_rsrp || "";
    var rx1 = d._5g_rx1_rsrp || "";
    var cells = [];

    // Determine if NR-CA is active: router sets nr_ca_pcell_freq when aggregating
    // multiple NR component carriers.
    var has_nr_ca_info = !!(d.nr_ca_pcell_freq && d.nr_ca_pcell_freq !== "");
    var nr_multi_raw = (d.nr_multi_ca_scell_info || "").trim();
    var nr_scells_raw = nr_multi_raw
      ? nr_multi_raw.split(";").filter(Boolean)
      : [];

    // Only treat as NR-CA if pcell info is present OR there are actual scell entries
    var is_nr_ca = has_nr_ca_info || nr_scells_raw.length > 0;

    if (!is_nr_ca) {
      // ── Single NR cell (no CA) ──
      var nb = d.is_5g_nsa
        ? "n" + (d.nr5g_action_nsa_band || d.nr5g_action_band || "")
        : d.nr5g_action_band || "";
      if (nb === "n" || nb === "n-1" || nb === "") nb = "n??";
      // Normalise: ensure prefix "n" for NSA bands
      if (d.is_5g_nsa && !/^n/i.test(nb)) nb = "n" + nb;
      var bw = d.is_5g_nsa
        ? (d.nr5g_nsa_bandwidth || "").replace("MHz", "")
        : (d.bandwidth || "").replace("MHz", "");
      cells.push(
        new NrCaCellInfo(
          parseInt(d.nr5g_pci || "0", 16),
          nb,
          d.nr5g_action_channel || "",
          bw,
          rx0,
          rx1,
          d.Z5g_rsrq || "",
          (d.Z5g_SINR || "")
            .replace("-20.0", "?????")
            .replace("-3276.8", "?????"),
        ),
      );
      return cells;
    }

    // ── NR Carrier Aggregation ──
    // Primary cell (PCell)
    var pb =
      d.nr_ca_pcell_band ||
      (d.nr5g_action_band
        ? /^[nN]/.test(d.nr5g_action_band)
          ? d.nr5g_action_band
          : "n" + d.nr5g_action_band
        : "n??");
    if (!/^[nN]/.test(pb)) pb = "n" + pb;
    var pf = d.nr_ca_pcell_freq || d.nr5g_action_channel || "??";
    var pcell_bw = d.is_5g_nsa
      ? (d.nr5g_nsa_bandwidth || d.bandwidth || "").replace("MHz", "")
      : (d.bandwidth || "").replace("MHz", "");

    cells.push(
      new NrCaCellInfo(
        parseInt(d.nr5g_pci || "0", 16),
        pb,
        pf,
        pcell_bw,
        rx0,
        rx1,
        d.Z5g_rsrq || "",
        (d.Z5g_SINR || "")
          .replace("-20.0", "?????")
          .replace("-3276.8", "?????"),
      ),
    );

    // Secondary cells (SCells) from nr_multi_ca_scell_info
    // Band lock filter: only apply if lock is actually configured (non-empty)
    var band_lock_str = (
      (d.is_5g_nsa ? d.nr5g_nsa_band_lock : d.nr5g_sa_band_lock) || ""
    ).trim();
    var locked_bands =
      band_lock_str && band_lock_str !== "0"
        ? band_lock_str
            .split(",")
            .map(function (b) {
              return b.trim().replace(/^[nN]/, "");
            })
            .filter(Boolean)
        : null; // null = no lock active → show all scells

    nr_scells_raw.forEach(function (c) {
      if (!c) return;
      var p = c.split(",");
      if (p.length < 6) return;
      var bn = (p[3] || "").replace(/^[nN]/, "");
      // Only skip if a band lock IS active and this band is not in the locked list
      if (locked_bands && locked_bands.indexOf(bn) === -1) return;
      var sc_band = /^[nN]/.test(p[3] || "") ? p[3] : "n" + bn;
      cells.push(
        new NrCaCellInfo(
          p[1],
          sc_band,
          p[4],
          (p[5] || "").replace("MHz", ""),
          p.length > 7 ? p[7] || "" : "",
          "",
          p.length > 8 ? p[8] || "" : "",
          p.length > 9 ? (p[9] || "").replace("0.0", "?????") : "",
        ),
      );
    });

    return cells;
  }

  // Returns whether NR Carrier Aggregation is active (2+ NR component carriers)
  function is_nr_ca_active() {
    var nc = parse_nr_cells();
    return nc.length > 1;
  }

  function get_band_info(cells) {
    return cells
      .map(function (c) {
        return c.band + (c.bandwidth ? "(" + c.bandwidth + "MHz)" : "");
      })
      .join(" + ");
  }

  // ─────────────────────────────────────────────
  //  PARSE NEIGHBOR CELLS — ZTE format:
  //  "earfcn,pci,rsrq,rsrp,rssi;..."  (LTE)
  // ─────────────────────────────────────────────
  function parse_ngbr_cells(raw_str, is_lte) {
    var cells = [];
    if (!raw_str) return cells;
    raw_str
      .split(";")
      .filter(Boolean)
      .forEach(function (entry) {
        var p = entry.split(",");
        if (is_lte) {
          var earfcn = p[0] || "";
          var pci_hex = p[1] || "";
          var rsrq = p[2] || "";
          var rsrp = p[3] || "";
          var pci_dec = parseInt(pci_hex, 16);
          var enb = calc_enodeb_from_pci_earfcn(pci_dec, parseInt(earfcn));
          cells.push({
            earfcn: earfcn,
            pci: isNaN(pci_dec) ? pci_hex : pci_dec,
            pci_raw: pci_hex,
            rsrp: rsrp,
            rsrq: rsrq,
            enodeb: enb,
            type: "LTE",
          });
        } else {
          cells.push({ raw: entry, type: "other" });
        }
      });
    return cells;
  }

  /*
   * Note: eNodeB cannot be derived from PCI+EARFCN alone.
   * PCI (0-503) identifies the cell physically, but eNodeB
   * is only derived from cell_id (ECI). For neighbor cells
   * the router doesn't provide full ECI, only PCI and EARFCN.
   * We show PCI and EARFCN and, when possible, estimate eNodeB
   * from main cell's cell_id if it has the same EARFCN (same tower, different sector).
   */
  function calc_enodeb_from_pci_earfcn(pci, earfcn) {
    var d = S.signal;
    var main_earfcn = parseInt(d.wan_active_channel || "0");
    if (!isNaN(earfcn) && !isNaN(main_earfcn) && earfcn === main_earfcn) {
      var enb = calc_enodeb(d.cell_id || "");
      if (enb !== null) return enb;
    }
    return null;
  }

  // ─────────────────────────────────────────────
  //  BTS SCAN
  //  Collects ngbr_cell_info data for CFG.scanTotalTime ms
  //  aggregating all observed cells (router rotates neighbors)
  // ─────────────────────────────────────────────
  window.zte_bts_scan = function () {
    if (S.scan_running) {
      toast("Scan already running...", "warn");
      return;
    }
    S.scan_running = true;
    S.scan_results = {};
    var d = S.signal;
    var is_lte = !!d.is_lte;

    // Always add main cell
    var main_enb = calc_enodeb(d.cell_id || "");
    var main_pci = parseInt(d.lte_pci || "0", 16);
    var main_earfcn = parseInt(d.wan_active_channel || "0");
    if (main_pci && main_earfcn) {
      var mk = main_pci + ":" + main_earfcn;
      S.scan_results[mk] = {
        pci: main_pci,
        earfcn: main_earfcn,
        rsrp: d.lte_rsrp_1 || d.lte_rsrp || "",
        rsrq: d.lte_rsrq || "",
        enodeb: main_enb,
        seen: 1,
        is_main: true,
        type: "LTE",
      };
    }

    render_scan_ui("Scanning... 0%", []);
    ztoggle("zte_scan_panel", true);

    var elapsed = 0;
    toast(
      "BTS Scan started — " + CFG.scanTotalTime / 1000 + " seconds",
      "info",
    );

    S.scan_timer_id = setInterval(function () {
      elapsed += CFG.scanInterval;
      var pct = Math.min(100, Math.round((elapsed / CFG.scanTotalTime) * 100));

      ajax_get(
        {
          cmd: "ngbr_cell_info,cell_id,wan_active_channel,lte_pci,lte_rsrp_1,lte_rsrq,network_type",
        },
        function (a) {
          var raw = a.ngbr_cell_info || "";
          var cur_is_lte = /LTE|ENDC|EN-DC|LTE-NSA/.test(a.network_type || "");
          var ngbr = parse_ngbr_cells(raw, cur_is_lte);

          ngbr.forEach(function (c) {
            if (!c.earfcn && !c.pci) return;
            var key = c.pci + ":" + c.earfcn;
            if (!S.scan_results[key]) {
              S.scan_results[key] = {
                pci: c.pci,
                earfcn: c.earfcn,
                rsrp: c.rsrp,
                rsrq: c.rsrq,
                enodeb: c.enodeb,
                seen: 1,
                is_main: false,
                type: c.type,
              };
            } else {
              var ex = S.scan_results[key];
              ex.rsrp = c.rsrp || ex.rsrp;
              ex.rsrq = c.rsrq || ex.rsrq;
              ex.seen++;
              if (!ex.enodeb && c.enodeb) ex.enodeb = c.enodeb;
            }
          });

          // Update main with fresh data
          var mp2 = parseInt(a.lte_pci || "0", 16);
          var me2 = parseInt(a.wan_active_channel || "0");
          var mk2 = mp2 + ":" + me2;
          if (mp2 && me2 && S.scan_results[mk2]) {
            S.scan_results[mk2].rsrp = a.lte_rsrp_1 || S.scan_results[mk2].rsrp;
            S.scan_results[mk2].rsrq = a.lte_rsrq || S.scan_results[mk2].rsrq;
            S.scan_results[mk2].enodeb =
              calc_enodeb(a.cell_id || "") || S.scan_results[mk2].enodeb;
          }

          var cells_arr = Object.values(S.scan_results).sort(function (a, b) {
            var ra = parseFloat(a.rsrp) || -999,
              rb = parseFloat(b.rsrp) || -999;
            return rb - ra;
          });
          render_scan_ui("Scanning... " + pct + "%", cells_arr);
        },
        function () {
          // On error, stop scan gracefully
          toast("Scan interrupted: connection error", "error");
          zte_stop_scan(true);
        },
      );
    }, CFG.scanInterval);

    S.scan_stop_id = setTimeout(function () {
      zte_stop_scan(true);
    }, CFG.scanTotalTime);
  };

  window.zte_stop_scan = function (auto) {
    if (!S.scan_running && !auto) return;
    clearInterval(S.scan_timer_id);
    clearTimeout(S.scan_stop_id);
    S.scan_running = false;
    S.scan_timer_id = null;
    S.scan_stop_id = null;
    var cells_arr = Object.values(S.scan_results).sort(function (a, b) {
      var ra = parseFloat(a.rsrp) || -999,
        rb = parseFloat(b.rsrp) || -999;
      return rb - ra;
    });
    render_scan_ui(
      "Scan complete — " + cells_arr.length + " BTS found",
      cells_arr,
    );
    toast("Scan complete: " + cells_arr.length + " BTS found", "ok");
  };

  function render_scan_ui(status_text, cells) {
    var el = document.getElementById("zte_scan_status");
    if (el) el.textContent = status_text;

    var tb = document.getElementById("zte_scan_tbody");
    if (!tb) return;
    tb.innerHTML = "";

    var d = S.signal;
    var main_earfcn = parseInt(d.wan_active_channel || "0");
    var main_pci = parseInt(d.lte_pci || "0", 16);

    cells.forEach(function (c) {
      var tr = document.createElement("tr");
      var is_main =
        c.is_main || (c.pci === main_pci && parseInt(c.earfcn) === main_earfcn);
      var rsrp_f = parseFloat(c.rsrp);
      var rsrp_color = isNaN(rsrp_f)
        ? "#37474F"
        : rsrp_f >= -80
          ? "#2E7D32"
          : rsrp_f >= -100
            ? "#F57C00"
            : "#C62828";
      var enb_txt =
        c.enodeb !== null && c.enodeb !== undefined ? c.enodeb : "—";

      tr.style.background = is_main ? "#E3F2FD" : "";
      tr.innerHTML =
        '<td style="color:' +
        rsrp_color +
        ';font-weight:700;padding:4px 6px;">' +
        (c.rsrp || "—") +
        "</td>" +
        '<td style="padding:4px 6px;color:#1565C0;">' +
        enb_txt +
        "</td>" +
        '<td style="padding:4px 6px;">' +
        c.pci +
        "</td>" +
        '<td style="padding:4px 6px;color:#1976D2;">' +
        c.earfcn +
        "</td>" +
        '<td style="padding:4px 6px;">' +
        (c.rsrq || "—") +
        "</td>" +
        '<td style="padding:4px 6px;">' +
        (is_main ? '<span style="color:#2E7D32">★ Connected</span>' : "") +
        "</td>" +
        '<td style="padding:4px 2px;">' +
        '<button class="zte_btn" style="padding:2px 7px;font-size:10px;" ' +
        'onclick="window.zte_force_connect_pci_earfcn(' +
        c.pci +
        "," +
        c.earfcn +
        "," +
        (c.enodeb !== null && c.enodeb !== undefined ? c.enodeb : "null") +
        ')">' +
        (is_main
          ? "Reconnect"
          : c.enodeb !== null && c.enodeb !== undefined
            ? "▶ Force"
            : "⚠ Force") +
        "</button>" +
        "</td>";
      tb.appendChild(tr);
    });

    if (cells.length === 0) {
      var tr2 = document.createElement("tr");
      tr2.innerHTML =
        '<td colspan="7" style="text-align:center;color:#78909C;padding:10px;">No BTS detected yet...</td>';
      tb.appendChild(tr2);
    }
  }

  // ─────────────────────────────────────────────
  //  FORCE CONNECT via eNodeB
  // ─────────────────────────────────────────────
  window.zte_force_connect_enodeb = function () {
    var enb_input = prompt(
      "Enter eNodeB ID to force connection to:\n\n" +
        'The eNodeB is shown in the "Network" section of the panel\n' +
        "or in the eNodeB column of the BTS Scan.",
      "",
    );
    if (!enb_input || !enb_input.trim()) return;
    var enb_target = parseInt(enb_input.trim());
    if (isNaN(enb_target)) {
      toast("Invalid eNodeB", "error");
      return;
    }

    var found = null;
    Object.values(S.scan_results).forEach(function (c) {
      if (c.enodeb === enb_target) {
        if (
          !found ||
          (parseFloat(c.rsrp) || -999) > (parseFloat(found.rsrp) || -999)
        ) {
          found = c;
        }
      }
    });

    if (!found) {
      toast(
        "eNodeB " + enb_target + " not found in scan.\nRun a BTS Scan first.",
        "warn",
      );
      return;
    }

    window.zte_force_connect_pci_earfcn(found.pci, found.earfcn, enb_target);
  };

  window.zte_force_connect_pci_earfcn = function (pci, earfcn, enb_hint) {
    var enb_label = enb_hint !== undefined ? " (eNodeB: " + enb_hint + ")" : "";
    var warning = "";

    // Warning if eNodeB is unknown
    if (enb_hint === undefined || enb_hint === null) {
      warning =
        "\n⚠️ WARNING: eNodeB unknown!\n" +
        "This cell might belong to a DIFFERENT OPERATOR.\n" +
        "If so, the router will go into NO SERVICE.\n" +
        "You'll need to remove cell lock to recover.\n";
    }

    var ok = confirm(
      "Force connection to:\n" +
        "  PCI:    " +
        pci +
        "\n" +
        "  EARFCN: " +
        earfcn +
        enb_label +
        warning +
        "\n" +
        "The router will reboot to apply cell lock.\n" +
        "Continue?",
    );
    if (!ok) return;

    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "LTE_LOCK_CELL_SET",
          lte_pci_lock: pci,
          lte_earfcn_lock: earfcn,
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") {
            toast(
              "Cell lock set on PCI " +
                pci +
                " EARFCN " +
                earfcn +
                ". Rebooting...",
              "ok",
            );
            setTimeout(function () {
              window.zte_reboot(true);
            }, 1000);
          } else {
            toast("Cell lock error: " + JSON.stringify(j), "error");
          }
        },
      );
    });
  };

  // ─────────────────────────────────────────────
  //  REMOVE CELL LOCK (Quick unlock)
  // ─────────────────────────────────────────────
  window.zte_remove_cell_lock = function () {
    if (!confirm("Remove cell lock and reboot router?")) return;
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "LTE_LOCK_CELL_SET",
          lte_pci_lock: "",
          lte_earfcn_lock: "",
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") {
            toast("Cell lock removed. Rebooting...", "ok");
            setTimeout(function () {
              window.zte_reboot(true);
            }, 1000);
          } else {
            toast("Error removing cell lock: " + JSON.stringify(j), "error");
          }
        },
      );
    });
  };

  // ─────────────────────────────────────────────
  //  GET STATUS
  // ─────────────────────────────────────────────
  function get_status() {
    ajax_get(
      { cmd: SIGINFO },
      function (a) {
        if (!a) return;
        var d = S.signal;
        SIGINFO.split(",").forEach(function (v) {
          var k = (!isNaN(v[0]) ? "_" : "") + v;
          d[k] = a[v] !== undefined ? a[v] : "";
          d[v] = d[k];
        });
        var nt = d.network_type || "";
        d.is_umts =
          /HSPA|HSDPA|HSUPA|HSPA\+|DC-HSPA\+|UMTS|CDMA|CDMA_EVDO|EVDO_EHRPD|TDSCDMA/.test(
            nt,
          );
        d.is_lte = /^(LTE|ENDC|EN-DC|LTE-NSA)$/.test(nt);
        d.is_lte_plus = !!(
          d.wan_lte_ca &&
          (d.wan_lte_ca === "ca_activated" || d.wan_lte_ca === "ca_deactivated")
        );
        d.is_5g_sa = nt === "SA";
        d.is_5g_nsa = /ENDC|EN-DC|LTE-NSA/.test(nt);
        d.is_5g_nsa_active = d.is_5g_nsa && nt !== "LTE-NSA";
        d.is_5g = d.is_5g_sa || d.is_5g_nsa;
        // NR CA: active when router reports nr_ca_pcell_freq OR multiple NR scells
        d.is_nr_ca =
          d.is_5g &&
          !!(
            (d.nr_ca_pcell_freq && d.nr_ca_pcell_freq !== "") ||
            (d.nr_multi_ca_scell_info &&
              d.nr_multi_ca_scell_info.indexOf(";") !== -1)
          );
        zte_set_dot("ok");
        update_ui(d);
      },
      function () {
        zte_set_dot("error");
      },
    );
  }

  // ─────────────────────────────────────────────
  //  UPDATE UI
  // ─────────────────────────────────────────────
  function zte_set_dot(st) {
    var e = zel("zte_status_dot");
    if (!e) return;
    e.style.background =
      { ok: "#4CAF50", error: "#D32F2F", warn: "#F57C00", idle: "#78909C" }[
        st
      ] || "#78909C";
    if (st === "ok") e.title = "Connected — " + new Date().toLocaleTimeString();
  }

  function zel(id) {
    return document.getElementById(id);
  }

  function zset(id, t) {
    var e = zel(id);
    if (e) e.textContent = t !== undefined && t !== null ? t : "";
  }

  function zhtml(id, h) {
    var e = zel(id);
    if (e) e.innerHTML = h;
  }

  function ztoggle(id, show) {
    var e = zel(id);
    if (e) e.style.display = show ? "" : "none";
  }

  function rsrp_cls(v) {
    var n = parseFloat(v);
    if (isNaN(n)) return "";
    return n >= -80 ? "good" : n >= -100 ? "warn" : "bad";
  }

  function sinr_cls(v) {
    var n = parseFloat(v);
    if (isNaN(n)) return "";
    return n >= 20 ? "good" : n >= 10 ? "warn" : "bad";
  }

  function scv(id, val, cls_fn) {
    var e = zel(id);
    if (!e) return;
    e.textContent = val || "";
    e.className =
      "zte_value" + (cls_fn && val && val !== "?????" ? " " + cls_fn(val) : "");
  }

  function update_lte(cells) {
    for (var i = 0; i < 6; i++) {
      var n = i + 1;
      if (S.signal.is_lte && cells.length > i) {
        var c = cells[i];
        var hr = c.rsrp1 !== "";
        ztoggle("lte_" + n + "_rsrp", hr);
        ztoggle("lte_" + n + "_sinr", hr);
        ztoggle("lte_" + n + "_rsrq", hr);
        zset("__lte_signal_" + i + "_band", c.band);
        scv("__lte_signal_" + i + "_rsrp1", c.rsrp1, rsrp_cls);
        zset("__lte_signal_" + i + "_rsrp2", c.rsrp2);
        zset("__lte_signal_" + i + "_rsrp3", c.rsrp3);
        zset("__lte_signal_" + i + "_rsrp4", c.rsrp4);
        scv("__lte_signal_" + i + "_sinr1", c.sinr1, sinr_cls);
        zset("__lte_signal_" + i + "_sinr2", c.sinr2);
        zset("__lte_signal_" + i + "_sinr3", c.sinr3);
        zset("__lte_signal_" + i + "_sinr4", c.sinr4);
        zset("__lte_signal_" + i + "_rsrq", c.rsrq);
        zset("__lte_signal_" + i + "_rssi", c.rssi);
        zset("__lte_signal_" + i + "_earfcn", c.earfcn);
        zset("__lte_signal_" + i + "_pci", c.pci);
        zset("__lte_signal_" + i + "_bandwidth", c.bandwidth);
        ztoggle("lte_" + n, true);
      } else {
        ztoggle("lte_" + n, false);
      }
    }
  }

  function update_nr(cells) {
    for (var i = 0; i < 6; i++) {
      var show = !!(S.signal.is_5g && cells.length > i);
      ztoggle("5g_" + (i + 1), show);
      if (show) {
        var c = cells[i];
        // Mark NR CA SCells (index > 0) with a visual badge
        var card = zel("5g_" + (i + 1));
        if (card) {
          if (i === 0) {
            card.style.borderLeftColor =
              cells.length > 1 ? "#7B1FA2" : "#2E7D32";
          } else {
            card.style.borderLeftColor = "#9C27B0";
          }
        }
        zset("__nr_signal_" + i + "_band", c.band);
        zset(
          "__nr_signal_" + i + "_info_text",
          c.info_text || (i > 0 ? "[NR-CA SCell]" : ""),
        );
        scv("__nr_signal_" + i + "_rsrp1", c.rsrp1, rsrp_cls);
        zset("__nr_signal_" + i + "_rsrp2", c.rsrp2);
        scv("__nr_signal_" + i + "_sinr", c.sinr, sinr_cls);
        zset("__nr_signal_" + i + "_rsrq", c.rsrq);
        zset("__nr_signal_" + i + "_arfcn", c.arfcn);
        zset("__nr_signal_" + i + "_pci", c.pci);
        zset("__nr_signal_" + i + "_bandwidth", c.bandwidth);
      }
    }
    if (cells.length > 0) {
      ztoggle("5g_1_rsrp2", cells[0].rsrp2 !== "");
      ztoggle("5g_1_bandwidth", cells[0].bandwidth !== "");
    }
  }

  function update_ui(d) {
    var lc = parse_lte_cells();
    update_lte(lc);
    var nc = parse_nr_cells();
    update_nr(nc);

    // eNodeB — connected cell
    var enb = calc_enodeb(d.cell_id || "");
    var cid_within = cell_id_within_enodeb(d.cell_id || "");
    if (enb !== null) {
      zset("zte_enodeb_val", enb);
      zset("zte_cellid_local", cid_within !== null ? cid_within : "");
      ztoggle("zte_enodeb_row", true);
    } else {
      ztoggle("zte_enodeb_row", false);
    }

    ztoggle("umts_signal_container", !!d.is_umts);
    if (d.is_umts && d.lte_ca_pcell_band)
      zset("umts_signal_table_main_band", " (" + d.lte_ca_pcell_band + ")");
    [
      "rscp_1",
      "ecio_1",
      "rscp_2",
      "ecio_2",
      "rscp_3",
      "ecio_3",
      "rscp_4",
      "ecio_4",
    ].forEach(function (k) {
      zset(k, d[k] || "");
    });

    zset("network_type", d.network_type || "—");
    zset("network_provider_fullname", d.network_provider_fullname || "—");
    zset("wan_ipaddr", d.wan_ipaddr || "—");
    zset("cell_id", d.cell_id || "—");
    zset("nr5g_cell_id", d.nr5g_cell_id || "—");
    ztoggle("lte_ca_active_tr", !!d.is_lte_plus);
    zhtml(
      "ca_active",
      d.wan_lte_ca === "ca_activated" ? "&#10003;" : "&#10005;",
    );

    // NR CA status
    var nc_all = parse_nr_cells();
    var nr_ca_on = d.is_5g && nc_all.length > 1;
    ztoggle("nr_ca_active_tr", !!d.is_5g);
    if (d.is_5g) {
      var nr_ca_bands = nc_all
        .map(function (c) {
          return c.band;
        })
        .join(" + ");
      zhtml(
        "nr_ca_active",
        nr_ca_on
          ? '<span style="color:#7B1FA2;font-weight:700">&#10003; ' +
              nc_all.length +
              "× NR (" +
              nr_ca_bands +
              ")</span>"
          : '<span style="color:#78909C;">&#10005; (' +
              (nc_all[0] ? nc_all[0].band : "—") +
              ")</span>",
      );
    }
    ztoggle("5g_cell", !!(d.is_5g && d.nr5g_cell_id));
    ztoggle("wanipinfo", !!d.wan_ipaddr);
    ztoggle("cell", !!d.cell_id);

    if (d.tx_power && d.tx_power !== "" && d.is_lte && !d.is_5g_nsa) {
      var mw = Math.pow(10, parseFloat(d.tx_power) / 10).toFixed(3);
      zset("tx_power", d.tx_power + " dBm (" + mw + " mW)");
      ztoggle("txp", true);
    } else {
      ztoggle("txp", false);
    }

    var lb = get_band_info(lc);
    var nb2 = get_band_info(nc);
    zset("__bandinfo", [lb, nb2].filter(Boolean).join(" + ") || "—");

    // 5G signal section — active bands header
    if (d.is_5g && nc.length > 0) {
      var nr_bands_str = nc
        .map(function (c, idx) {
          return (idx === 0 ? "PCell " : "SCell #" + idx + " ") + c.band;
        })
        .join(" + ");
      zhtml(
        "zte_5g_active_bands",
        '<span style="color:#7B1FA2;font-weight:700;">' +
          nr_bands_str +
          "</span>",
      );
      ztoggle("zte_5g_bands_row", true);
    } else {
      ztoggle("zte_5g_bands_row", false);
    }

    if (d.rmcc && d.rmnc) {
      zset("zte_mccmnc", d.rmcc + "-" + d.rmnc);
      ztoggle("zte_mccmnc_row", true);
    } else ztoggle("zte_mccmnc_row", false);

    // Cell lock status
    var lte_locked = d.lte_pci_lock && d.lte_pci_lock !== "0";
    if (lte_locked) {
      zhtml(
        "zte_lock_status",
        '<span style="color:#D32F2F;">🔒 PCI: ' +
          d.lte_pci_lock +
          ", EARFCN: " +
          d.lte_earfcn_lock +
          "</span>",
      );
      ztoggle("zte_lock_row", true);
    } else {
      ztoggle("zte_lock_row", false);
    }

    // ── LTE Band Lock status ──────────────────────
    var lte_band_lock_raw = (d.lte_band_lock || "").trim();
    // A lock is active when the field is non-empty and not "0"
    var lte_band_lock_active =
      lte_band_lock_raw !== "" &&
      lte_band_lock_raw !== "0" &&
      lte_band_lock_raw !== "0x0";
    if (lte_band_lock_active) {
      var lte_locked_bands = decode_lte_band_mask(lte_band_lock_raw);
      var lte_lock_label =
        lte_locked_bands.length > 0
          ? lte_locked_bands
              .map(function (b) {
                return "B" + b;
              })
              .join(" + ")
          : lte_band_lock_raw;
      zhtml(
        "zte_lte_band_lock_status",
        '<span style="color:#E65100;">🔒 ' + lte_lock_label + "</span>",
      );
    } else {
      zhtml(
        "zte_lte_band_lock_status",
        '<span style="color:#78909C;">Unlocked</span>',
      );
    }

    // ── NR Band Lock status ───────────────────────
    var nr_band_lock_raw = (
      (d.is_5g_nsa ? d.nr5g_nsa_band_lock : d.nr5g_sa_band_lock) || ""
    ).trim();
    var nr_band_lock_active =
      nr_band_lock_raw !== "" && nr_band_lock_raw !== "0";
    if (d.is_5g || nr_band_lock_active) {
      if (nr_band_lock_active) {
        var nr_lock_bands = nr_band_lock_raw
          .split(",")
          .filter(Boolean)
          .map(function (b) {
            return "N" + b.trim().replace(/^[nN]/, "");
          })
          .join(" + ");
        zhtml(
          "zte_nr_band_lock_status",
          '<span style="color:#E65100;">🔒 ' + nr_lock_bands + "</span>",
        );
      } else {
        zhtml(
          "zte_nr_band_lock_status",
          '<span style="color:#78909C;">Unlocked</span>',
        );
      }
      ztoggle("zte_nr_band_lock_row", true);
    } else {
      ztoggle("zte_nr_band_lock_row", false);
    }

    // Neighbor cells
    if (d.ngbr_cell_info) {
      var ngbr = parse_ngbr_cells(d.ngbr_cell_info, d.is_lte);
      var nh = "";
      if (d.is_lte && ngbr.length) {
        nh =
          "<table style='width:100%;font-size:11px;border-collapse:collapse;'>" +
          "<tr style='color:#78909C;font-size:10px;'><td>RSRP</td><td>eNodeB</td><td>PCI</td><td>EARFCN</td><td>RSRQ</td></tr>";
        ngbr.forEach(function (c) {
          var rc = parseFloat(c.rsrp);
          var col = isNaN(rc)
            ? "#37474F"
            : rc >= -80
              ? "#2E7D32"
              : rc >= -100
                ? "#F57C00"
                : "#C62828";
          nh +=
            "<tr>" +
            '<td style="color:' +
            col +
            ';padding:2px 4px;font-weight:700">' +
            c.rsrp +
            "</td>" +
            '<td style="padding:2px 4px;color:#1565C0">' +
            (c.enodeb !== null && c.enodeb !== undefined ? c.enodeb : "—") +
            "</td>" +
            '<td style="padding:2px 4px">' +
            c.pci +
            "</td>" +
            '<td style="padding:2px 4px;color:#1976D2">' +
            c.earfcn +
            "</td>" +
            '<td style="padding:2px 4px">' +
            c.rsrq +
            "</td>" +
            "</tr>";
        });
        nh += "</table>";
      } else {
        nh = d.ngbr_cell_info.replace(/;/g, "<br>");
      }
      zhtml("ngbr_cell_info_content", nh);
      ztoggle("ngbr_cells", true);
    } else {
      ztoggle("ngbr_cells", false);
    }

    // Temperatures
    var tp = [];
    if (d.pm_sensor_ambient && d.pm_sensor_ambient > -40)
      tp.push("A: " + d.pm_sensor_ambient + "°C");
    if (d.pm_sensor_mdm && d.pm_sensor_mdm > -40)
      tp.push("M: " + d.pm_sensor_mdm + "°C");
    if (d.pm_sensor_5g && d.pm_sensor_5g > -40)
      tp.push("5G: " + d.pm_sensor_5g + "°C");
    if (d.pm_sensor_pa1 && d.pm_sensor_pa1 > -40)
      tp.push("PA: " + d.pm_sensor_pa1 + "°C");
    if (d.wifi_chip_temp && d.wifi_chip_temp > -40)
      tp.push("WiFi: " + d.wifi_chip_temp + "°C");
    if (tp.length) {
      zset("temps", tp.join("  "));
      ztoggle("temperature", true);
    } else ztoggle("temperature", false);
  }

  // ─────────────────────────────────────────────
  //  ROUTER COMMANDS
  // ─────────────────────────────────────────────
  window.zte_set_net_mode = function (mode) {
    if (!mode) {
      var ms =
        "Only_GSM,Only_WCDMA,Only_LTE,WCDMA_AND_GSM,WCDMA_preferred,WCDMA_AND_LTE,GSM_AND_LTE,CDMA_EVDO_LTE,Only_TDSCDMA,TDSCDMA_AND_WCDMA,TDSCDMA_AND_LTE,TDSCDMA_WCDMA_HDR_CDMA_GSM_LTE,TDSCDMA_WCDMA_GSM_LTE,GSM_WCDMA_LTE,Only_5G,LTE_AND_5G,GWL_5G,TCHGWL_5G,WL_AND_5G,TGWL_AND_5G,4G_AND_5G";
      mode = prompt("Network mode:\n" + ms.replace(/,/g, ", "), "WL_AND_5G");
    }
    if (!mode) return;
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "SET_BEARER_PREFERENCE",
          BearerPreference: mode,
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") toast("Mode: " + mode, "ok");
          else toast("Mode error: " + JSON.stringify(j), "error");
        },
      );
    });
  };

  window.zte_lte_band = function (bands, _dev) {
    if (!bands)
      bands = prompt(
        "LTE Bands (e.g., 1+3+20)\nType AUTO to remove all band locks.",
        "AUTO",
      );
    if (!bands) return;
    var low = bands.trim().toLowerCase();
    // AUTO → remove band lock entirely
    if (low === "auto") {
      window.zte_lte_band_unlock();
      return;
    }
    var n = 0;
    low.split("+").forEach(function (b) {
      var bn = parseInt(b);
      if (!isNaN(bn) && bn >= 1 && bn <= 85) {
        n += Math.pow(2, bn - 1);
      }
    });
    if (n === 0) {
      toast("Invalid band input — use format: 1+3+7 or AUTO", "error");
      return;
    }
    var mask = "0x" + ("00000000000" + n.toString(16)).slice(-11);
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "BAND_SELECT",
          is_gw_band: 0,
          gw_band_mask: 0,
          is_lte_band: 1,
          lte_band_mask: mask,
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") {
            toast("LTE Bands locked: " + bands.toUpperCase(), "ok");
          } else if (!_dev && !S.logged_in_as_developer) {
            toast("Band lock failed, trying developer login...", "warn");
            perform_login(function () {
              S.logged_in_as_developer = true;
              window.zte_lte_band(bands, true);
            }, true);
          } else {
            toast("LTE Band lock failed.", "error");
          }
        },
      );
    });
  };

  window.zte_nr_band = function (bands) {
    if (!bands)
      bands = prompt(
        "5G NR Bands (e.g., 78+28)\nType AUTO to remove all NR band locks.",
        "AUTO",
      );
    if (!bands) return;
    var trimmed = bands.trim();
    // AUTO → remove NR band lock entirely
    if (trimmed.toUpperCase() === "AUTO") {
      window.zte_nr_band_unlock();
      return;
    }
    var mask = trimmed.split("+").join(",");
    var nr_type = S.signal.is_5g_nsa ? "1" : "0"; // 0=SA, 1=NSA
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "WAN_PERFORM_NR5G_SANSA_BAND_LOCK",
          nr5g_band_mask: mask,
          type: nr_type,
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success")
            toast("5G Bands locked: " + trimmed.toUpperCase(), "ok");
          else toast("5G Band error: " + JSON.stringify(j), "error");
        },
      );
    });
  };

  // ─────────────────────────────────────────────
  //  DECODE LTE BAND MASK → band list
  //  The router stores the active LTE band lock as a hex bitmask.
  //  Bit n-1 set → band Bn enabled.
  // ─────────────────────────────────────────────
  function decode_lte_band_mask(hex_mask) {
    if (!hex_mask || hex_mask === "" || hex_mask === "0" || hex_mask === "0x0")
      return [];
    var clean = hex_mask.replace(/^0x/i, "");
    var bands = [];
    try {
      var mask = BigInt("0x" + clean);
      for (var i = 0; i < 85; i++) {
        if ((mask >> BigInt(i)) & BigInt(1)) bands.push(i + 1);
      }
    } catch (e) {
      // BigInt not available — fallback for 32-bit portion only
      var n = parseInt(clean.slice(-8), 16) || 0;
      for (var i = 0; i < 32; i++) {
        if ((n >> i) & 1) bands.push(i + 1);
      }
    }
    return bands;
  }

  // ─────────────────────────────────────────────
  //  BAND LOCK REMOVAL
  //  Unlike "AUTO" (which still sets a specific mask),
  //  these functions fully disable the band filter.
  // ─────────────────────────────────────────────
  window.zte_lte_band_unlock = function () {
    if (
      !confirm(
        "Remove LTE band lock?\n\n" +
          "This will allow the router to use ALL available LTE bands\n" +
          "without any mask restriction.",
      )
    )
      return;
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "BAND_SELECT",
          is_gw_band: "0",
          gw_band_mask: "0",
          is_lte_band: "1",
          lte_band_mask: "0xA3E2AB0908DF",
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") {
            toast("LTE band lock removed — all bands allowed", "ok");
          } else if (!S.logged_in_as_developer) {
            toast("LTE unlock failed, trying developer login...", "warn");
            perform_login(function () {
              S.logged_in_as_developer = true;
              window.zte_lte_band_unlock();
            }, true);
          } else {
            toast("LTE band unlock failed: " + JSON.stringify(j), "error");
          }
        },
      );
    });
  };

  window.zte_nr_band_unlock = function () {
    if (
      !confirm(
        "Remove NR (5G) band lock?\n\n" +
          "This will allow the router to use ALL available 5G bands\n" +
          "without any restriction.",
      )
    )
      return;
    var nr_type = S.signal.is_5g_nsa ? "1" : "0";
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "WAN_PERFORM_NR5G_SANSA_BAND_LOCK",
          nr5g_band_mask: "",
          type: nr_type,
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success")
            toast("NR band lock removed — all 5G bands allowed", "ok");
          else toast("NR band unlock failed: " + JSON.stringify(j), "error");
        },
      );
    });
  };

  window.zte_unlock_all_bands = function () {
    if (
      !confirm(
        "Remove ALL band locks (LTE + 5G NR)?\n\n" +
          "Both LTE and NR band filters will be cleared.\n" +
          "The router will be free to use any available band.",
      )
    )
      return;
    var nr_type = S.signal.is_5g_nsa ? "1" : "0";
    // Chain: LTE unlock → NR unlock
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "BAND_SELECT",
          is_gw_band: "0",
          gw_band_mask: "0",
          is_lte_band: "1",
          lte_band_mask: "0xA3E2AB0908DF",
          AD: ad,
        },
        function (raw_lte) {
          var jl = parse_result(raw_lte);
          get_ad_token(function (ad2) {
            ajax_post(
              {
                isTest: "false",
                goformId: "WAN_PERFORM_NR5G_SANSA_BAND_LOCK",
                nr5g_band_mask: "",
                type: nr_type,
                AD: ad2,
              },
              function (raw_nr) {
                var jn = parse_result(raw_nr);
                var lte_ok = jl.result === "success";
                var nr_ok = jn.result === "success";
                if (lte_ok && nr_ok) {
                  toast("All band locks removed (LTE + NR)", "ok");
                } else {
                  toast(
                    "Partial: LTE=" +
                      (lte_ok ? "OK" : "FAIL") +
                      " NR=" +
                      (nr_ok ? "OK" : "FAIL"),
                    lte_ok || nr_ok ? "warn" : "error",
                  );
                }
              },
            );
          });
        },
      );
    });
  };

  window.zte_lte_cell_lock = function (reset) {
    var params;
    if (reset) {
      params = ["", ""];
    } else {
      var dp = parseInt(S.signal.lte_pci || "0", 16);
      var de = S.signal.wan_active_channel || "";
      var inp = prompt(
        "PCI,EARFCN (e.g., 116,3350)\nDefault = current cell",
        dp + "," + de,
      );
      if (!inp || !inp.trim()) return;
      params = inp.split(",");
      if (params.length < 2 || isNaN(params[0]) || isNaN(params[1])) {
        toast("Invalid input", "error");
        return;
      }
      // Validate PCI range (0-503)
      var pci_val = parseInt(params[0]);
      if (pci_val < 0 || pci_val > 503) {
        toast("PCI must be between 0 and 503", "error");
        return;
      }
    }
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "LTE_LOCK_CELL_SET",
          lte_pci_lock: params[0],
          lte_earfcn_lock: params[1],
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") {
            var msg = reset ? "LTE Cell lock removed." : "LTE Cell lock set.";
            if (confirm(msg + "\nReboot now?")) window.zte_reboot(true);
            else toast(msg, "ok");
          } else toast("LTE Cell lock error", "error");
        },
      );
    });
  };

  window.zte_nr_cell_lock = function (reset) {
    var lv;
    if (reset) {
      lv = "";
    } else {
      var nc = parse_nr_cells();
      var df = "";
      if (nc.length > 0) {
        var c = nc[0];
        df =
          c.pci + "," + c.arfcn + "," + (c.band || "").replace("n", "") + ",30";
      }
      lv = prompt("PCI,ARFCN,BAND,SCS (e.g., 202,639936,78,30)", df);
      if (!lv || !lv.trim()) return;
      var p = lv.split(",");
      if (
        p.length < 4 ||
        isNaN(p[0]) ||
        isNaN(p[1]) ||
        isNaN(p[2]) ||
        ["15", "30", "60", "120", "240"].indexOf((p[3] || "").trim()) === -1
      ) {
        toast("Invalid input. SCS: 15/30/60/120/240", "error");
        return;
      }
    }
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "NR5G_LOCK_CELL_SET",
          nr5g_cell_lock: lv,
          AD: ad,
        },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") {
            var msg = reset ? "5G Cell lock removed." : "5G Cell lock set.";
            if (confirm(msg + "\nReboot now?")) window.zte_reboot(true);
            else toast(msg, "ok");
          } else toast("5G Cell lock error", "error");
        },
      );
    });
  };

  window.zte_bridge_mode = function (en) {
    if (!confirm((en ? "Enable" : "Disable") + " bridge mode and reboot?"))
      return;
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "OPERATION_MODE",
          opMode: en ? "LTE_BRIDGE" : "PPP",
          ethernet_port_specified: "1",
          AD: ad,
        },
        function () {
          toast(
            "Bridge mode " + (en ? "enabled" : "disabled") + ". Rebooting...",
            "ok",
          );
          window.zte_reboot(true);
        },
      );
    });
  };

  window.zte_arp_proxy = function (en) {
    if (!confirm((en ? "Enable" : "Disable") + " ARP proxy and reboot?"))
      return;
    get_ad_token(function (ad) {
      ajax_post(
        {
          isTest: "false",
          goformId: "ARP_PROXY_SWITCH",
          arp_proxy_switch: en ? 1 : 0,
          AD: ad,
        },
        function () {
          toast("ARP proxy " + (en ? "enabled" : "disabled"), "ok");
          window.zte_reboot(true);
        },
      );
    });
  };

  // ─────────────────────────────────────────────
  //  APN + DNS
  //  Navigates to the router's APN settings page and
  //  auto-reveals hidden DNS fields (prefer_dns_manual /
  //  standby_dns_manual) which are present in the page
  //  but hidden by default in the stock firmware UI.
  // ─────────────────────────────────────────────
  window.zte_open_apn_dns = function () {
    // Navigate to the APN settings hash
    window.location.hash = "apn_setting";

    // Poll until the page renders, then unhide DNS rows
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var found = false;

      // Try to show any element whose id or name contains "dns"
      document
        .querySelectorAll(
          "[id*='dns'],[name*='dns'],[id*='DNS'],[name*='DNS']," +
            ".dns_row,.dns-row,[class*='dns']",
        )
        .forEach(function (el) {
          el.style.display = "";
          el.style.visibility = "visible";
          // also show parent tr/div if hidden
          var p = el.parentElement;
          if (
            p &&
            (p.style.display === "none" ||
              getComputedStyle(p).display === "none")
          ) {
            p.style.display = "";
          }
          found = true;
        });

      // Also generically unhide rows/divs that contain the word "DNS" in their text
      document
        .querySelectorAll("tr,div.form-group,div.row,li")
        .forEach(function (el) {
          if (
            el.textContent &&
            /dns/i.test(el.textContent) &&
            (el.style.display === "none" ||
              el.classList.contains("hide") ||
              el.classList.contains("hidden"))
          ) {
            el.style.display = "";
            el.classList.remove("hide", "hidden");
            found = true;
          }
        });

      if (found || tries >= 40) {
        clearInterval(t);
        if (found) toast("APN settings open — DNS fields revealed", "ok");
        else
          toast(
            "APN page open — DNS fields not found (may already be visible)",
            "info",
          );
      }
    }, 250);
  };

  // ─────────────────────────────────────────────
  //  FORCE BTS HOP — Disconnect + Reconnect WAN
  //  Does NOT reboot the router. Sends DISCONNECT_NETWORK
  //  then CONNECT_NETWORK after a short delay, causing the
  //  modem to re-attach and potentially land on a different BTS.
  // ─────────────────────────────────────────────
  window.zte_bts_hop = function () {
    if (
      !confirm(
        "Force BTS Hop?\n\n" +
          "The modem will disconnect and reconnect to the network.\n" +
          "This is NOT a reboot — connection will resume in 10-20 seconds.\n" +
          "It may attach to a different BTS.",
      )
    )
      return;

    get_ad_token(function (ad) {
      ajax_post(
        { isTest: "false", goformId: "DISCONNECT_NETWORK", AD: ad },
        function () {
          toast("WAN disconnecting... reconnecting in 8s", "warn");
          setTimeout(function () {
            get_ad_token(function (ad2) {
              ajax_post(
                { isTest: "false", goformId: "CONNECT_NETWORK", AD: ad2 },
                function () {
                  toast("WAN reconnect sent", "ok");
                },
                function () {
                  toast("Reconnect error — try manually", "error");
                },
              );
            });
          }, 8000);
        },
        function () {
          toast("WAN disconnect error", "error");
        },
      );
    });
  };

  window.zte_reboot = function (force) {
    if (!force && !confirm("Reboot the router?")) return;
    get_ad_token(function (ad) {
      ajax_post(
        { isTest: "false", goformId: "REBOOT_DEVICE", AD: ad },
        function () {
          toast("Router rebooting...", "warn");
        },
      );
    });
  };

  window.zte_version_info = function () {
    ajax_get(
      { cmd: "hardware_version,web_version,wa_inner_version,cr_version" },
      function (a) {
        alert(
          "HW: " +
            a.hardware_version +
            "\nWEB: " +
            a.web_version +
            "\nWA INNER: " +
            a.wa_inner_version +
            "\nCR: " +
            a.cr_version,
        );
      },
    );
  };

  window.zte_show_hidden = function () {
    toast("Hidden settings revealed", "info");
    var cnt = 0;
    var t = setInterval(function () {
      document.querySelectorAll(".hide").forEach(function (el) {
        if (!el.dataset.zteUnhidden) {
          el.classList.remove("hide");
          el.dataset.zteUnhidden = "1";
          var tag = document.createElement("span");
          tag.style.cssText = "font-size:10px;color:#888;margin-left:4px;";
          tag.textContent = "[hidden]";
          el.appendChild(tag);
        }
      });
      if (document.getElementById("ipv4_section"))
        document.querySelectorAll("#ipv4_section .row").forEach(function (r) {
          r.style.display = "block";
        });
      if (++cnt >= 30) clearInterval(t);
    }, 1000);
  };

  window.zte_test_connection = function () {
    var s = Date.now();
    ajax_get(
      { cmd: "loginfo" },
      function () {
        toast("Router OK — " + (Date.now() - s) + " ms", "ok");
      },
      function () {
        toast("Router unreachable!", "error");
      },
    );
  };

  window.zte_copy_signal = function () {
    var d = S.signal;
    var lc = parse_lte_cells();
    var nc = parse_nr_cells();
    var enb = calc_enodeb(d.cell_id || "");
    var lines = [
      "=== ZTE Signal Report — " + new Date().toLocaleString() + " ===",
      "Provider: " + (d.network_provider_fullname || "N/A"),
      "Network Type: " + (d.network_type || "N/A"),
      "Bands: " +
        ([get_band_info(lc), get_band_info(nc)].filter(Boolean).join(" + ") ||
          "N/A"),
      "eNodeB: " + (enb !== null ? enb : "N/A"),
      "Cell ID: " + (d.cell_id || "N/A"),
      "WAN IP: " + (d.wan_ipaddr || "N/A"),
      "MCC-MNC: " + (d.rmcc && d.rmnc ? d.rmcc + "-" + d.rmnc : "N/A"),
    ];
    if (lc.length > 0) {
      var c = lc[0];
      lines.push(
        "LTE RSRP1: " +
          c.rsrp1 +
          " dBm | RSRQ: " +
          c.rsrq +
          " dB | SINR1: " +
          c.sinr1 +
          " dB | BW: " +
          c.bandwidth +
          " MHz | EARFCN: " +
          c.earfcn +
          " | PCI: " +
          c.pci,
      );
    }
    if (nc.length > 0) {
      var c2 = nc[0];
      lines.push(
        "5G  RSRP1: " +
          c2.rsrp1 +
          " dBm | RSRQ: " +
          c2.rsrq +
          " dB | SINR: " +
          c2.sinr +
          " dB | BW: " +
          c2.bandwidth +
          " MHz | ARFCN: " +
          c2.arfcn +
          " | PCI: " +
          c2.pci,
      );
      if (nc.length > 1) {
        lines.push("5G NR CA: " + nc.length + " component carriers aggregated");
        for (var nri = 1; nri < nc.length; nri++) {
          var sc = nc[nri];
          lines.push(
            "  NR SCell #" +
              nri +
              ": " +
              sc.band +
              " | RSRP: " +
              (sc.rsrp1 || "—") +
              " dBm | RSRQ: " +
              (sc.rsrq || "—") +
              " dB | SINR: " +
              (sc.sinr || "—") +
              " dB | BW: " +
              (sc.bandwidth || "—") +
              " MHz | ARFCN: " +
              (sc.arfcn || "—") +
              " | PCI: " +
              (sc.pci || "—"),
          );
        }
      }
    }
    var text = lines.join("\n");
    if (navigator.clipboard)
      navigator.clipboard.writeText(text).then(function () {
        toast("Signal copied!", "ok");
      });
    else prompt("Copy:", text);
  };

  // ─────────────────────────────────────────────
  //  TRAFFIC & DEVICE — FORMAT HELPERS
  // ─────────────────────────────────────────────
  function fmt_bytes(bytes) {
    var b = parseInt(bytes) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + " MB";
    return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function fmt_speed(bps) {
    var b = parseInt(bps) || 0;
    if (b < 1024) return b + " B/s";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB/s";
    return (b / 1024 / 1024).toFixed(2) + " MB/s";
  }

  function fmt_time(secs) {
    var s = parseInt(secs) || 0;
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(sec).padStart(2, "0")
    );
  }

  // ─────────────────────────────────────────────
  //  TRAFFIC POLLING
  // ─────────────────────────────────────────────
  function get_traffic() {
    ajax_get({ cmd: TRAFFICINFO }, function (a) {
      if (!a) return;
      var t = S.traffic;
      TRAFFICINFO.split(",").forEach(function (k) {
        t[k] = a[k] !== undefined ? a[k] : "";
      });
      update_traffic(t);
    });
  }

  function update_traffic(t) {
    // Speeds
    scv("zte_tx_speed", fmt_speed(t.realtime_tx_thrpt));
    scv("zte_rx_speed", fmt_speed(t.realtime_rx_thrpt));
    // Session
    zset("zte_sess_time", fmt_time(t.realtime_time));
    zset("zte_sess_tx", fmt_bytes(t.realtime_tx_bytes));
    zset("zte_sess_rx", fmt_bytes(t.realtime_rx_bytes));
    var sess_tot =
      (parseInt(t.realtime_tx_bytes) || 0) +
      (parseInt(t.realtime_rx_bytes) || 0);
    zset("zte_sess_total", fmt_bytes(sess_tot));
    // Monthly
    if (t.date_month) zset("zte_month_label", "Month: " + t.date_month);
    zset("zte_month_tx", fmt_bytes(t.monthly_tx_bytes));
    zset("zte_month_rx", fmt_bytes(t.monthly_rx_bytes));
    var month_tot =
      (parseInt(t.monthly_tx_bytes) || 0) + (parseInt(t.monthly_rx_bytes) || 0);
    zset("zte_month_total", fmt_bytes(month_tot));
    zset("zte_month_time", fmt_time(t.monthly_time));
  }

  window.zte_reset_traffic = function () {
    if (
      !confirm(
        "Reset traffic counters?\n\nThis will clear session and monthly statistics.",
      )
    )
      return;
    get_ad_token(function (ad) {
      ajax_post(
        { isTest: "false", goformId: "RESET_DATA_COUNTER", AD: ad },
        function (raw) {
          var j = parse_result(raw);
          if (j.result === "success") toast("Traffic counters reset", "ok");
          else toast("Reset failed: " + JSON.stringify(j), "error");
        },
      );
    });
  };

  // ─────────────────────────────────────────────
  //  DEVICE INFO POLLING
  // ─────────────────────────────────────────────
  function get_device_info() {
    ajax_get({ cmd: DEVICEINFO }, function (a) {
      if (!a) return;
      var d = S.device;
      DEVICEINFO.split(",").forEach(function (k) {
        d[k] = a[k] !== undefined ? a[k] : "";
      });
      update_device(d);
    });
  }

  function update_device(d) {
    // SIM
    zset("zte_dev_modem_state", d.modem_main_state || "—");
    zset("zte_dev_pin_status", d.pin_status !== "" ? d.pin_status : "—");
    zset("zte_dev_imsi", d.imsi || "—");
    zset("zte_dev_msisdn", d.msisdn || "—");
    // Hardware
    zset("zte_dev_imei", d.imei || "—");
    zset("zte_dev_firmware", d.wa_inner_version || "—");
    zset("zte_dev_hw_version", d.hardware_version || "—");
    zset("zte_dev_web_version", d.web_version || "—");
    zset("zte_dev_mac", d.mac_address || "—");
    // Network
    zset("zte_dev_lan_ip", d.lan_ipaddr || "—");
    zset("zte_dev_wan_ipv6", d.ipv6_wan_ipaddr || "—");
    zset("zte_dev_wan_mode", d.opms_wan_mode || "—");
    zset("zte_dev_pdp_type", d.pdp_type || "—");
    zset("zte_dev_lan_domain", d.lan_domain || "—");
    // GPS
    var lat = d.gps_lat || "";
    var lon = d.gps_lon || "";
    if (lat && lon && lat !== "" && lon !== "") {
      zset("zte_dev_gps_lat", lat);
      zset("zte_dev_gps_lon", lon);
      var mapUrl = "https://www.google.com/maps?q=" + lat + "," + lon;
      var el = zel("zte_dev_gps_map");
      if (el) {
        el.href = mapUrl;
        el.style.display = "";
      }
      ztoggle("zte_dev_gps_row", true);
    } else {
      ztoggle("zte_dev_gps_row", false);
    }
  }

  // ─────────────────────────────────────────────
  //  CSS — LIGHT BLUE THEME
  // ─────────────────────────────────────────────
  function inject_css() {
    if (zel("zte_tm_style")) return;
    var s = document.createElement("style");
    s.id = "zte_tm_style";
    s.textContent = [
      "#zte_panel{position:fixed;top:12px;left:12px;z-index:2147483646;width:440px;max-height:94vh;",
      "background:#FFFFFF;color:#37474F;border-radius:12px 12px 0px 0px;box-shadow:0 8px 32px rgba(0,0,0,.15);",
      'font-family:"Segoe UI",Verdana,sans-serif;font-size:12px;border:1px solid #B0BEC5;',
      "display:flex;flex-direction:column;}",
      "#zte_panel *{box-sizing:border-box;}",
      "#zte_hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;",
      "background:linear-gradient(135deg,#1976D2,#1565C0);border-radius:12px 12px 0px 0px;cursor:move;user-select:none;border-bottom:1px solid #1565C0;",
      "position:sticky;top:0;z-index:10;flex-shrink:0;}",
      "#zte_hdr h2{margin:0;font-size:13px;font-weight:700;color:#FFFFFF;letter-spacing:.5px;}",
      "#zte_status_dot{width:10px;height:10px;border-radius:50%;background:#78909C;display:inline-block;margin-right:6px;transition:background .5s;}",
      ".zte_hdr_btns{display:flex;gap:4px;}",
      ".zte_icon_btn{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:#FFFFFF;cursor:pointer;font-size:13px;",
      "padding:2px 7px;border-radius:5px;line-height:1;font-family:inherit;}",
      ".zte_icon_btn:hover{background:rgba(255,255,255,.3);}",
      "#zte_body{padding:10px;background:#FAFAFA;overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:#90A4AE #E3F2FD;}",
      "#zte_body::-webkit-scrollbar{width:8px;}",
      "#zte_body::-webkit-scrollbar-track{background:#E3F2FD;border-radius:4px;}",
      "#zte_body::-webkit-scrollbar-thumb{background:#90A4AE;border-radius:4px;}",
      "#zte_body::-webkit-scrollbar-thumb:hover{background:#78909C;}",
      "#zte_panel .zte_value,#zte_panel td,#zte_panel .zte_label{user-select:text;-webkit-user-select:text;-moz-user-select:text;cursor:text;}",
      "#zte_panel .zte_value::selection,#zte_panel td::selection{background:#1976D2;color:#fff;}",
      ".zte_sec{background:#FFFFFF;border-radius:8px;padding:8px 10px;margin-bottom:8px;border:1px solid #E0E0E0;box-shadow:0 1px 3px rgba(0,0,0,.05);}",
      ".zte_sec_title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#1976D2;margin-bottom:6px;font-weight:700;}",
      ".zte_row{display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #ECEFF1;}",
      ".zte_row:last-child{border-bottom:none;}",
      ".zte_label{color:#78909C;font-size:11px;flex-shrink:0;}",
      ".zte_value{color:#37474F;font-weight:600;font-size:11px;text-align:right;word-break:break-all;}",
      ".zte_value.good{color:#2E7D32!important;}",
      ".zte_value.warn{color:#F57C00!important;}",
      ".zte_value.bad{color:#C62828!important;}",
      ".zte_enodeb{color:#7B1FA2!important;font-size:14px!important;font-weight:900!important;}",
      ".zte_cell_card{background:#F5F5F5;border-radius:6px;padding:7px 9px;margin-bottom:6px;border-left:3px solid #1976D2;}",
      ".zte_cell_card.lte{border-left-color:#1976D2;}",
      ".zte_cell_card.nr{border-left-color:#2E7D32;}",
      ".zte_cell_card.nr.nr_ca_scell{border-left-color:#9C27B0;}",
      ".zte_cell_card.umts{border-left-color:#F57C00;}",
      ".zte_cell_card h4{margin:0 0 5px;font-size:11px;color:#1565C0;font-weight:700;}",
      ".zte_grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 8px;}",
      ".zte_btn_grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:5px;}",
      ".zte_btn{background:#FFFFFF;border:1px solid #B0BEC5;color:#37474F;border-radius:6px;padding:6px 8px;",
      "cursor:pointer;font-size:11px;text-align:center;transition:background .2s,border-color .2s;font-family:inherit;}",
      ".zte_btn:hover{background:#E3F2FD;border-color:#1976D2;color:#1976D2;}",
      ".zte_btn.danger:hover{border-color:#C62828;color:#C62828;background:#FFEBEE;}",
      ".zte_btn.ok:hover{border-color:#2E7D32;color:#2E7D32;background:#E8F5E9;}",
      ".zte_btn.warn:hover{border-color:#E65100;color:#E65100;background:#FFF3E0;}",
      ".zte_btn.scan_active{background:#E8F5E9;border-color:#2E7D32;color:#2E7D32;}",
      ".zte_btn.full{grid-column:1/-1;}",
      ".zte_bandrow{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;}",
      ".zte_chip{background:#E3F2FD;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;",
      "border:1px solid #BBDEFB;transition:all .2s;color:#1565C0;}",
      ".zte_chip:hover{background:#1976D2;border-color:#1976D2;color:#FFFFFF;}",
      "#zte_scan_panel{background:#F5F5F5;border-radius:8px;padding:10px;margin-top:8px;border:1px solid #E0E0E0;}",
      "#zte_scan_panel table{width:100%;border-collapse:collapse;font-size:11px;}",
      "#zte_scan_panel th{color:#78909C;font-size:10px;font-weight:600;padding:3px 6px;border-bottom:1px solid #E0E0E0;text-align:left;}",
      "#zte_scan_panel td{padding:3px 6px;border-bottom:1px solid #ECEFF1;}",
      "#zte_scan_panel tr:hover td{background:#E3F2FD;}",
      "#zte_footer{text-align:center;color:#90A4AE;font-size:10px;padding:6px 0 4px;background:#FAFAFA;flex-shrink:0;}",
    ].join("");
    document.head.appendChild(s);
  }

  // ─────────────────────────────────────────────
  //  HTML PANEL
  // ─────────────────────────────────────────────
  function inject_html() {
    if (zel("zte_panel")) return;
    inject_css();

    var lte_cards = "";
    for (var i = 0; i < 6; i++) {
      lte_cards +=
        '<div class="zte_cell_card lte" id="lte_' +
        (i + 1) +
        '" style="display:none">' +
        "<h4>LTE #" +
        (i + 1) +
        ' — <span id="__lte_signal_' +
        i +
        '_band">—</span></h4>' +
        '<div class="zte_grid2">' +
        "<div>" +
        '<div class="zte_row" id="lte_' +
        (i + 1) +
        '_rsrp"><span class="zte_label">RSRP1</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_rsrp1">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">RSRP2</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_rsrp2">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">RSRP3</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_rsrp3">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">RSRP4</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_rsrp4">—</span></div>' +
        '<div class="zte_row" id="lte_' +
        (i + 1) +
        '_rsrq"><span class="zte_label">RSRQ</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_rsrq">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">RSSI</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_rssi">—</span></div>' +
        "</div>" +
        "<div>" +
        '<div class="zte_row" id="lte_' +
        (i + 1) +
        '_sinr"><span class="zte_label">SINR1</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_sinr1">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">SINR2</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_sinr2">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">SINR3</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_sinr3">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">SINR4</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_sinr4">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">EARFCN</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_earfcn">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">PCI</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_pci">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">BW</span><span class="zte_value" id="__lte_signal_' +
        i +
        '_bandwidth">—</span></div>' +
        "</div>" +
        "</div></div>";
    }

    var nr_cards = "";
    for (var j = 0; j < 6; j++) {
      nr_cards +=
        '<div class="zte_cell_card nr" id="5g_' +
        (j + 1) +
        '" style="display:none">' +
        "<h4>" +
        (j === 0 ? "5G PCell" : "5G SCell #" + j) +
        ' — <span id="__nr_signal_' +
        j +
        '_band">—</span>' +
        ' <span id="__nr_signal_' +
        j +
        '_info_text" style="font-size:10px;color:#F57C00"></span></h4>' +
        '<div class="zte_grid2">' +
        '<div class="zte_row"><span class="zte_label">RSRP1</span><span class="zte_value" id="__nr_signal_' +
        j +
        '_rsrp1">—</span></div>' +
        '<div class="zte_row" id="' +
        (j === 0 ? "5g_1_rsrp2" : "") +
        '"><span class="zte_label">RSRP2</span><span class="zte_value" id="__nr_signal_' +
        j +
        '_rsrp2">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">SINR</span><span class="zte_value" id="__nr_signal_' +
        j +
        '_sinr">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">RSRQ</span><span class="zte_value" id="__nr_signal_' +
        j +
        '_rsrq">—</span></div>' +
        '<div class="zte_row" id="' +
        (j === 0 ? "5g_1_arfcn" : "") +
        '"><span class="zte_label">ARFCN</span><span class="zte_value" id="__nr_signal_' +
        j +
        '_arfcn">—</span></div>' +
        '<div class="zte_row"><span class="zte_label">PCI</span><span class="zte_value" id="__nr_signal_' +
        j +
        '_pci">—</span></div>' +
        '<div class="zte_row" id="' +
        (j === 0 ? "5g_1_bandwidth" : "") +
        '"><span class="zte_label">BW</span><span class="zte_value" id="__nr_signal_' +
        j +
        '_bandwidth">—</span></div>' +
        "</div></div>";
    }

    var panel = document.createElement("div");
    panel.id = "zte_panel";
    panel.innerHTML =
      '<div id="zte_hdr">' +
      '<h2><span id="zte_status_dot"></span>ZTE Advanced Router Panel</h2>' +
      '<div class="zte_hdr_btns">' +
      '<button class="zte_icon_btn" onclick="window.zte_test_connection()" title="Test Connection">⚡</button>' +
      '<button class="zte_icon_btn" id="zte_min_btn" title="Minimize">−</button>' +
      "</div>" +
      "</div>" +
      '<div id="zte_body">' +
      // ── NETWORK ──────────────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">Network</div>' +
      '<div class="zte_row"><span class="zte_label">Provider</span><span class="zte_value" id="network_provider_fullname">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Type</span><span class="zte_value" id="network_type">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Bands</span><span class="zte_value" id="__bandinfo">—</span></div>' +
      '<div class="zte_row" id="lte_ca_active_tr"><span class="zte_label">LTE CA</span><span class="zte_value" id="ca_active">—</span></div>' +
      '<div class="zte_row" id="nr_ca_active_tr" style="display:none"><span class="zte_label">5G NR CA</span><span class="zte_value" id="nr_ca_active">—</span></div>' +
      '<div class="zte_row" id="zte_enodeb_row">' +
      '<span class="zte_label">eNodeB (BTS)</span>' +
      '<span class="zte_value zte_enodeb" id="zte_enodeb_val" title="eNodeB ID = Cell ID >> 8">—</span>' +
      "</div>" +
      '<div class="zte_row" id="cell"><span class="zte_label">Cell ID / Sector</span><span class="zte_value" id="cell_id">—</span></div>' +
      '<div class="zte_row" id="5g_cell"><span class="zte_label">5G Cell ID</span><span class="zte_value" id="nr5g_cell_id">—</span></div>' +
      '<div class="zte_row" id="wanipinfo"><span class="zte_label">WAN IP</span><span class="zte_value" id="wan_ipaddr">—</span></div>' +
      '<div class="zte_row" id="txp"><span class="zte_label">TX Power</span><span class="zte_value" id="tx_power">—</span></div>' +
      '<div class="zte_row" id="temperature"><span class="zte_label">Temp</span><span class="zte_value" id="temps">—</span></div>' +
      '<div class="zte_row" id="zte_mccmnc_row"><span class="zte_label">MCC-MNC</span><span class="zte_value" id="zte_mccmnc">—</span></div>' +
      '<div class="zte_row" id="zte_lock_row" style="display:none;"><span class="zte_label">Cell Lock</span><span class="zte_value" id="zte_lock_status">—</span></div>' +
      "</div>" +
      // ── LTE SIGNAL ────────────────────────────
      '<div class="zte_sec"><div class="zte_sec_title">LTE Signal</div>' +
      lte_cards +
      "</div>" +
      // ── 5G SIGNAL ─────────────────────────────
      '<div class="zte_sec">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
      '<span class="zte_sec_title" style="margin-bottom:0">5G Signal (NR)</span>' +
      '<span id="zte_5g_bands_row" style="font-size:10px;display:none;"><span id="zte_5g_active_bands">—</span></span>' +
      "</div>" +
      nr_cards +
      "</div>" +
      // ── UMTS ───────────────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_cell_card umts" id="umts_signal_container" style="display:none">' +
      '<h4>UMTS<span id="umts_signal_table_main_band"></span></h4>' +
      '<div class="zte_grid2">' +
      '<div class="zte_row"><span class="zte_label">RSCP1</span><span class="zte_value" id="rscp_1">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">ECIO1</span><span class="zte_value" id="ecio_1">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">RSCP2</span><span class="zte_value" id="rscp_2">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">ECIO2</span><span class="zte_value" id="ecio_2">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">RSCP3</span><span class="zte_value" id="rscp_3">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">ECIO3</span><span class="zte_value" id="ecio_3">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">RSCP4</span><span class="zte_value" id="rscp_4">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">ECIO4</span><span class="zte_value" id="ecio_4">—</span></div>' +
      "</div>" +
      "</div>" +
      "</div>" +
      // ── NEIGHBOR CELLS ───────────────────────────
      '<div class="zte_sec" id="ngbr_cells" style="display:none">' +
      '<div class="zte_sec_title">Neighbor Cells</div>' +
      '<div id="ngbr_cell_info_content"></div>' +
      "</div>" +
      // ── BTS SCAN ───────────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">BTS Scan & Force Connect</div>' +
      '<div style="font-size:10px;color:#78909C;margin-bottom:6px;">' +
      "Scan collects neighbor cells for " +
      CFG.scanTotalTime / 1000 +
      "s. " +
      '"Force Connect" applies cell lock on PCI+EARFCN and reboots router.' +
      "</div>" +
      '<div class="zte_btn_grid">' +
      '<button class="zte_btn ok" id="zte_scan_btn" onclick="window.zte_bts_scan()">🔍 Start Scan</button>' +
      '<button class="zte_btn danger" onclick="window.zte_stop_scan(false)">⏹ Stop Scan</button>' +
      '<button class="zte_btn full" onclick="window.zte_force_connect_enodeb()">📡 Force Connect via eNodeB...</button>' +
      '<button class="zte_btn danger full" onclick="window.zte_remove_cell_lock()">🔓 Remove Cell Lock</button>' +
      '<button class="zte_btn warn full" onclick="window.zte_bts_hop()">🔀 Force BTS Hop (disconnect/reconnect WAN)</button>' +
      "</div>" +
      '<div id="zte_scan_panel" style="display:none;margin-top:8px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<span id="zte_scan_status" style="color:#1976D2;font-size:11px;">—</span>' +
      '<span style="font-size:10px;color:#78909C;">RSRP | eNodeB | PCI | EARFCN | RSRQ</span>' +
      "</div>" +
      "<table><thead><tr>" +
      "<th>RSRP</th><th>eNodeB</th><th>PCI</th><th>EARFCN</th><th>RSRQ</th><th>Status</th><th></th>" +
      '</tr></thead><tbody id="zte_scan_tbody"></tbody></table>' +
      "</div>" +
      "</div>" +
      // ── NETWORK MODE ──────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">Network Mode</div>' +
      '<div class="zte_btn_grid">' +
      '<button class="zte_btn" onclick="window.zte_set_net_mode(\'WL_AND_5G\')">Auto</button>' +
      '<button class="zte_btn" onclick="window.zte_set_net_mode(\'Only_5G\')">5G SA</button>' +
      '<button class="zte_btn" onclick="window.zte_set_net_mode(\'LTE_AND_5G\')">5G NSA</button>' +
      '<button class="zte_btn" onclick="window.zte_set_net_mode(\'4G_AND_5G\')">5G+LTE</button>' +
      '<button class="zte_btn" onclick="window.zte_set_net_mode(\'Only_LTE\')">LTE Only</button>' +
      '<button class="zte_btn" onclick="window.zte_set_net_mode(\'Only_WCDMA\')">3G Only</button>' +
      '<button class="zte_btn full" onclick="window.zte_set_net_mode(null)">✏ Custom...</button>' +
      "</div>" +
      "</div>" +
      // ── LTE BANDS ───────────────────────────────
      '<div class="zte_sec">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<span class="zte_sec_title" style="margin-bottom:0">LTE Bands</span>' +
      '<span style="font-size:10px;">Lock: <span id="zte_lte_band_lock_status" style="font-weight:700">—</span></span>' +
      "</div>" +
      '<div class="zte_bandrow">' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'1\')">B1</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'3\')">B3</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'7\')">B7</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'8\')">B8</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'20\')">B20</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'28\')">B28</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'1+3\')">B1+3</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'1+3+7\')">B1+3+7</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'1+3+20\')">B1+3+20</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'1+3+7+20\')">B1+3+7+20</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(\'3+20\')">B3+20</span>' +
      '<span class="zte_chip" onclick="window.zte_lte_band(null)">✏ Custom</span>' +
      "</div>" +
      '<button class="zte_btn danger" style="width:100%;margin-top:7px;" onclick="window.zte_lte_band_unlock()">🔓 Remove LTE Band Lock</button>' +
      "</div>" +
      // ── 5G BANDS ────────────────────────────────
      '<div class="zte_sec">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<span class="zte_sec_title" style="margin-bottom:0">5G Bands (NR)</span>' +
      '<span id="zte_nr_band_lock_row" style="font-size:10px;display:none;">Lock: <span id="zte_nr_band_lock_status" style="font-weight:700">—</span></span>' +
      "</div>" +
      '<div class="zte_bandrow">' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'1\')">N1</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'3\')">N3</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'7\')">N7</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'28\')">N28</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'38\')">N38</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'75\')">N75</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'78\')">N78</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'38+78\')">N38+78</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'3+38+78\')">N3+38+78</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(\'28+78\')">N28+78</span>' +
      '<span class="zte_chip" onclick="window.zte_nr_band(null)">✏ Custom</span>' +
      "</div>" +
      '<button class="zte_btn danger" style="width:100%;margin-top:7px;" onclick="window.zte_nr_band_unlock()">🔓 Remove NR Band Lock</button>' +
      "</div>" +
      // ── REMOVE ALL BAND LOCKS ───────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">Band Lock — Global Reset</div>' +
      '<div style="font-size:10px;color:#78909C;margin-bottom:7px;">' +
      "Removes ALL band restrictions (LTE + NR). The router will freely choose any available band." +
      "</div>" +
      '<button class="zte_btn danger" style="width:100%;" onclick="window.zte_unlock_all_bands()">🔓 Remove ALL Band Locks (LTE + NR)</button>' +
      "</div>" +
      // ── CELL LOCK ──────────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">Manual Cell Lock</div>' +
      '<div class="zte_btn_grid">' +
      '<button class="zte_btn" onclick="window.zte_lte_cell_lock(false)">🔒 LTE Lock</button>' +
      '<button class="zte_btn danger" onclick="window.zte_lte_cell_lock(true)">🔓 LTE Unlock</button>' +
      '<button class="zte_btn" onclick="window.zte_nr_cell_lock(false)">🔒 5G Lock</button>' +
      '<button class="zte_btn danger" onclick="window.zte_nr_cell_lock(true)">🔓 5G Unlock</button>' +
      "</div>" +
      "</div>" +
      // ── APN + DNS ──────────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">APN + DNS</div>' +
      '<div style="font-size:10px;color:#78909C;margin-bottom:8px;">' +
      "Opens the router APN settings page and reveals the hidden DNS fields." +
      "</div>" +
      '<button class="zte_btn ok" style="width:100%;" onclick="window.zte_open_apn_dns()">⚙️ Open APN Settings &amp; Reveal DNS Fields</button>' +
      "</div>" +
      // ── TRAFFIC STATISTICS ─────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">Traffic Statistics</div>' +
      '<div class="zte_row"><span class="zte_label">⬆ Upload</span><span class="zte_value" id="zte_tx_speed">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">⬇ Download</span><span class="zte_value" id="zte_rx_speed">—</span></div>' +
      '<div style="font-size:10px;color:#1976D2;font-weight:700;margin:6px 0 3px;">Current Session</div>' +
      '<div class="zte_row"><span class="zte_label">Duration</span><span class="zte_value" id="zte_sess_time">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Sent</span><span class="zte_value" id="zte_sess_tx">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Received</span><span class="zte_value" id="zte_sess_rx">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Total session</span><span class="zte_value" id="zte_sess_total">—</span></div>' +
      '<div style="font-size:10px;color:#1976D2;font-weight:700;margin:6px 0 3px;" id="zte_month_label">Monthly</div>' +
      '<div class="zte_row"><span class="zte_label">Sent</span><span class="zte_value" id="zte_month_tx">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Received</span><span class="zte_value" id="zte_month_rx">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Total month</span><span class="zte_value" id="zte_month_total">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Connected time</span><span class="zte_value" id="zte_month_time">—</span></div>' +
      '<button class="zte_btn danger" style="width:100%;margin-top:8px;" onclick="window.zte_reset_traffic()">↺ Reset Counters</button>' +
      "</div>" +
      // ── DEVICE INFO ────────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">Device Info</div>' +
      '<div style="font-size:10px;color:#1976D2;font-weight:700;margin-bottom:3px;">SIM</div>' +
      '<div class="zte_row"><span class="zte_label">SIM Status</span><span class="zte_value" id="zte_dev_modem_state">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">PIN Status</span><span class="zte_value" id="zte_dev_pin_status">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">IMSI</span><span class="zte_value" id="zte_dev_imsi">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">MSISDN</span><span class="zte_value" id="zte_dev_msisdn">—</span></div>' +
      '<div style="font-size:10px;color:#1976D2;font-weight:700;margin:6px 0 3px;">Hardware</div>' +
      '<div class="zte_row"><span class="zte_label">IMEI</span><span class="zte_value" id="zte_dev_imei">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Firmware</span><span class="zte_value" id="zte_dev_firmware" style="font-size:10px;">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">HW Version</span><span class="zte_value" id="zte_dev_hw_version">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Web Version</span><span class="zte_value" id="zte_dev_web_version" style="font-size:10px;">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">MAC Address</span><span class="zte_value" id="zte_dev_mac">—</span></div>' +
      '<div style="font-size:10px;color:#1976D2;font-weight:700;margin:6px 0 3px;">Network</div>' +
      '<div class="zte_row"><span class="zte_label">LAN IP</span><span class="zte_value" id="zte_dev_lan_ip">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">WAN IPv6</span><span class="zte_value" id="zte_dev_wan_ipv6" style="font-size:10px;word-break:break-all;">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">WAN Mode</span><span class="zte_value" id="zte_dev_wan_mode">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">PDP Type</span><span class="zte_value" id="zte_dev_pdp_type">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">LAN Domain</span><span class="zte_value" id="zte_dev_lan_domain">—</span></div>' +
      '<div id="zte_dev_gps_row" style="display:none;">' +
      '<div style="font-size:10px;color:#1976D2;font-weight:700;margin:6px 0 3px;">GPS</div>' +
      '<div class="zte_row"><span class="zte_label">Latitude</span><span class="zte_value" id="zte_dev_gps_lat">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">Longitude</span><span class="zte_value" id="zte_dev_gps_lon">—</span></div>' +
      '<div class="zte_row"><span class="zte_label">📍 Map</span><span class="zte_value"><a id="zte_dev_gps_map" href="#" target="_blank" style="color:#1976D2;">Open in Maps</a></span></div>' +
      "</div>" +
      "</div>" +
      // ── ADVANCED ───────────────────────────────
      '<div class="zte_sec">' +
      '<div class="zte_sec_title">Advanced</div>' +
      '<div class="zte_btn_grid">' +
      '<button class="zte_btn" onclick="window.zte_bridge_mode(true)">Bridge ON</button>' +
      '<button class="zte_btn danger" onclick="window.zte_bridge_mode(false)">Bridge OFF</button>' +
      '<button class="zte_btn" onclick="window.zte_arp_proxy(true)">ARP Proxy ON</button>' +
      '<button class="zte_btn danger" onclick="window.zte_arp_proxy(false)">ARP Proxy OFF</button>' +
      '<button class="zte_btn" onclick="window.zte_show_hidden()">👁 Show Hidden Menus</button>' +
      '<button class="zte_btn" onclick="window.zte_enable_auto_login()">🔑 Auto Login</button>' +
      '<button class="zte_btn ok" onclick="window.zte_copy_signal()">📋 Copy Signal</button>' +
      '<button class="zte_btn" onclick="window.zte_version_info()">ℹ️ Version</button>' +
      '<button class="zte_btn danger full" onclick="window.zte_reboot(false)">🔄 Reboot Router</button>' +
      "</div>" +
      "</div>" +
      "</div>" +
      // ── BUY ME A COFFEE ────────────────────────
      (CFG.bmac
        ? '<div class="zte_sec" style="text-align:center;background:#FFF8E1;border-color:#FFE082;">' +
          '<div style="font-size:11px;color:#78909C;margin-bottom:8px;">If this panel was helpful to you, consider a small tip ☕</div>' +
          '<a href="https://buymeacoffee.com/cerix" target="_blank" rel="noopener noreferrer" ' +
          'style="display:inline-block;background:#FFDD00;color:#000000;font-weight:700;font-size:13px;' +
          "padding:9px 22px;border-radius:8px;text-decoration:none;border:2px solid #F0C800;" +
          'transition:background .2s,transform .1s;" ' +
          "onmouseover=\"this.style.background='#FFE84D'\" onmouseout=\"this.style.background='#FFDD00'\">" +
          "☕ Buy Me a Coffee — Cerix" +
          "</a>" +
          "</div>"
        : "") +
      "</div>" +
      '<div id="zte_footer">ZTE Panel v' +
      CFG.version +
      " · by Cerix · drag header to move</div>";

    document.body.appendChild(panel);
    make_draggable(panel);
    make_minimizable(panel);
  }

  // ─────────────────────────────────────────────
  //  DRAG & MINIMIZE
  // ─────────────────────────────────────────────
  function make_draggable(panel) {
    var h = panel.querySelector("#zte_hdr");
    if (!h) return;
    var ox = 0,
      oy = 0,
      mx = 0,
      my = 0;
    h.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      e.preventDefault();
      mx = e.clientX;
      my = e.clientY;
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", mu);
    });
    function mv(e) {
      ox = mx - e.clientX;
      oy = my - e.clientY;
      mx = e.clientX;
      my = e.clientY;
      panel.style.top = panel.offsetTop - oy + "px";
      panel.style.left = panel.offsetLeft - ox + "px";
    }
    function mu() {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", mu);
    }
  }

  function make_minimizable(panel) {
    var btn = panel.querySelector("#zte_min_btn");
    var body = panel.querySelector("#zte_body");
    if (!btn || !body) return;
    var col = false;
    btn.addEventListener("click", function () {
      col = !col;
      body.style.display = col ? "none" : "";
      btn.textContent = col ? "+" : "−";
      var hdr = panel.querySelector("#zte_hdr");
      if (hdr) hdr.style.borderRadius = col ? "12px" : "12px 12px 0 0";
    });
  }

  // ─────────────────────────────────────────────
  //  INIT
  // ─────────────────────────────────────────────
  function start_polling() {
    if (S.init_done) return;
    S.init_done = true;
    inject_html();
    get_status();
    setInterval(get_status, CFG.pollInterval);
    get_traffic();
    setInterval(get_traffic, CFG.trafficPollInterval);
    get_device_info();
    setInterval(get_device_info, CFG.devicePollInterval);
    setInterval(prevent_logout, CFG.logoutPrevention);
    toast("ZTE Panel v" + CFG.version + " active", "ok");
    console.log("[ZTE] Polling started every", CFG.pollInterval, "ms");
  }

  function auto_login_then_start() {
    if (have_hash()) {
      check_login(
        function () {
          console.log("[ZTE] Already logged in.");
          start_polling();
        },
        function () {
          console.log("[ZTE] Auto-login...");
          perform_login(function () {
            start_polling();
            var n = 0;
            var t = setInterval(function () {
              window.location.hash = "home";
              if (++n >= 10) clearInterval(t);
            }, 100);
          });
        },
      );
    } else {
      var t = setInterval(function () {
        if (++S.init_retry_count > CFG.maxInitRetries) {
          clearInterval(t);
          console.warn("[ZTE] Login timeout.");
          return;
        }
        check_login(function () {
          clearInterval(t);
          start_polling();
        });
      }, CFG.initRetryInterval);
    }
  }

  // SHA256 polyfill inline (MIT — geraintluff)
  function inject_sha256() {
    if (window.SHA256) return;
    window.SHA256 = (function () {
      function r(n, t) {
        return (n >>> t) | (n << (32 - t));
      }
      function t(n, t) {
        return n >>> t;
      }
      var e = [
        1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993,
        2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987,
        1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774,
        264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986,
        2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711,
        113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291,
        1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411,
        3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344,
        430227734, 506948616, 659060556, 883997877, 958139571, 1322822218,
        1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424,
        2428436474, 2756734187, 3204031479, 3329325298,
      ];
      return function (n) {
        var o,
          h,
          u,
          a,
          f,
          i,
          c,
          s,
          v,
          l,
          y,
          p,
          w = [];
        n = unescape(encodeURIComponent(n));
        var d = n.length,
          g = [
            (o = 1779033703),
            (h = 3144134277),
            (u = 1013904242),
            (a = 2773480762),
            (f = 1359893119),
            (i = 2600822924),
            (c = 528734635),
            (s = 1541325730),
          ],
          b = [];
        for (var m = 0; m < d; m++)
          b[m >> 2] |= n.charCodeAt(m) << ((3 - (m % 4)) * 8);
        b[d >> 2] |= 128 << ((3 - (d % 4)) * 8);
        b[14 + (((16 + d) >> 6) << 4)] = 8 * d;
        for (var m = 0; m < b.length; m += 16) {
          for (var j = w, q = 0; q < 16; q++) j[q] = b[m + q];
          for (var q = 16; q < 64; q++)
            j[q] =
              (r(j[q - 2], 17) ^ r(j[q - 2], 19) ^ t(j[q - 2], 10)) +
              j[q - 7] +
              (r(j[q - 15], 7) ^ r(j[q - 15], 18) ^ t(j[q - 15], 3)) +
              j[q - 16];
          var x = o,
            E = h,
            S = u,
            B = a,
            C = f,
            D = i,
            F = c,
            G = s;
          for (var q = 0; q < 64; q++) {
            var H =
                G +
                (r(C, 6) ^ r(C, 11) ^ r(C, 25)) +
                ((C & D) ^ (~C & F)) +
                e[q] +
                j[q],
              I =
                (r(x, 2) ^ r(x, 13) ^ r(x, 22)) + ((x & E) ^ (x & S) ^ (E & S));
            ((G = F),
              (F = D),
              (D = C),
              (C = (B + H) | 0),
              (B = S),
              (S = E),
              (E = x),
              (x = (H + I) | 0));
          }
          ((o = (o + x) | 0),
            (h = (h + E) | 0),
            (u = (u + S) | 0),
            (a = (a + B) | 0),
            (f = (f + C) | 0),
            (i = (i + D) | 0),
            (c = (c + F) | 0),
            (s = (s + G) | 0));
        }
        var J = "";
        for (var m = 0; m < 8; m++) {
          var K = g[m];
          J +=
            ((K >>> 28) & 15).toString(16) +
            ((K >>> 24) & 15).toString(16) +
            ((K >>> 20) & 15).toString(16) +
            ((K >>> 16) & 15).toString(16) +
            ((K >>> 12) & 15).toString(16) +
            ((K >>> 8) & 15).toString(16) +
            ((K >>> 4) & 15).toString(16) +
            (K & 15).toString(16);
        }
        return J;
      };
    })();
    if (!window.hex_md5) window.hex_md5 = window.SHA256;
    console.log("[ZTE] SHA256 polyfill injected.");
  }

  function setup_hash() {
    if (window.SHA256) {
      S.hash_fn = window.SHA256;
      return true;
    }
    if (window.hex_md5) {
      S.hash_fn = window.hex_md5;
      return true;
    }
    return false;
  }

  function ensure_jquery(cb) {
    if (window.jQuery) {
      window.$ = window.$ || window.jQuery;
      return cb();
    }
    console.log("[ZTE] Loading jQuery...");
    var s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js";
    s.onload = function () {
      window.$ = window.jQuery;
      console.log("[ZTE] jQuery ready.");
      cb();
    };
    s.onerror = function () {
      toast("jQuery could not be loaded from CDN!", "error");
    };
    document.head.appendChild(s);
  }

  function bootstrap() {
    ensure_jquery(function () {
      var tries = 0;
      function try_init() {
        tries++;
        if (setup_hash()) {
          ajax_get(
            { cmd: "wa_inner_version" },
            function (a) {
              if (a && a.wa_inner_version) {
                S.is_mc888 = a.wa_inner_version.indexOf("MC888") > -1;
                S.is_mc889 = a.wa_inner_version.indexOf("MC889") > -1;
                if ((S.is_mc888 || S.is_mc889) && window.SHA256)
                  S.hash_fn = window.SHA256;
              }
              auto_login_then_start();
            },
            function () {
              auto_login_then_start();
            },
          );
          return;
        }
        ajax_get(
          { cmd: "wa_inner_version" },
          function (a) {
            if (a && a.wa_inner_version) {
              S.is_mc888 = a.wa_inner_version.indexOf("MC888") > -1;
              S.is_mc889 = a.wa_inner_version.indexOf("MC889") > -1;
            }
            inject_sha256();
            if (setup_hash()) {
              auto_login_then_start();
            } else if (tries < CFG.maxInitRetries) {
              setTimeout(try_init, CFG.initRetryInterval);
            } else {
              toast("Init error: hash functions not found.", "error");
            }
          },
          function () {
            if (tries < CFG.maxInitRetries)
              setTimeout(try_init, CFG.initRetryInterval);
          },
        );
      }
      try_init();
    });
  }

  // ─────────────────────────────────────────────
  //  GO
  // ─────────────────────────────────────────────
  console.log("[ZTE] Script v" + CFG.version + " loaded");
  bootstrap();
})();
