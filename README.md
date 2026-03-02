# ZTE Advanced Router Panel

**Userscript for ZTE MC888 / MC889 **  
Version 2026-v5.3 — by [Cerix](https://buymeacoffee.com/cerix)

A floating control panel injected directly into the router's web UI that exposes signal data, band locking, cell locking, traffic statistics and device info that the stock firmware deliberately hides or makes hard to reach.

---

## Features

| Section | What it does |
|---|---|
| **Network** | Provider, network type, active bands, LTE CA status, NR CA status, eNodeB ID, Cell ID, WAN IP, TX Power, temperature |
| **LTE Signal** | Per-component-carrier cards: RSRP ×4, RSRQ, RSSI, SINR ×4, EARFCN, PCI, bandwidth |
| **5G Signal (NR)** | PCell + SCell cards with active band header — lets you see NR carrier aggregation at a glance |
| **BTS Scan & Force Connect** | Scans neighbor cells for 18 s, shows RSRP / eNodeB / PCI / EARFCN, lets you hard-lock to any cell with one click |
| **Network Mode** | One-click buttons: Auto, 5G SA, 5G NSA, 5G+LTE, LTE Only, 3G Only + custom |
| **LTE Bands** | Quick-lock to B1/B3/B7/B8/B20/B28 or any combination, with live lock status and one-click unlock |
| **5G Bands (NR)** | Quick-lock to N1/N3/N7/N28/N38/N75/N78 or any combination, with live lock status and one-click unlock |
| **Band Lock — Global Reset** | Removes all LTE + NR band restrictions in a single click |
| **Manual Cell Lock** | Lock/unlock LTE cell (PCI + EARFCN) and 5G cell (PCI + ARFCN + Band + SCS) |
| **Traffic Statistics** | Real-time upload/download speed, session duration/sent/received, monthly totals + reset button |
| **Device Info** | SIM state, PIN status, IMSI, IMEI, firmware/HW/Web versions, LAN IP, WAN IPv6, WAN mode, PDP type, GPS with Google Maps link |
| **APN + DNS** | Opens the APN settings page and automatically reveals the hidden DNS fields |
| **Advanced** | Bridge mode, ARP proxy, show hidden menus, auto-login, copy signal report, reboot |

---

## Requirements

- Router: **ZTE MC889** (or MC888)  
  *(may work on other ZTE CPE devices with the same firmware structure)*
- A userscript manager installed in your browser:
  - [Tampermonkey](https://www.tampermonkey.net/) ← recommended
  - [Violentmonkey](https://violentmonkey.github.io/)

---

## Installation

1. Install **Tampermonkey** from your browser's extension store.
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Delete the default template, paste the entire content of `ZTE_Router_Enhanced_Panel.user.js` and save.
4. Navigate to your router IP: [http://192.168.192.1](http://192.168.192.1).
5. Log in — the panel appears automatically in the top-left corner.

> **Tip:** use the **🔑 Auto Login** button in the Advanced section to save your password hash in a cookie so the panel logs in automatically on every visit.

---

## Configuration 
At the top of the script change @match Ip with your custom one.

That's the only setting most users will want to touch.

These are already set by default:

| IP | Router |
|---|---|
| `192.168.192.1` | Generic ZTE |
| `192.168.0.1` | Generic ZTE |
| `192.168.1.1` | Generic ZTE |
| `192.168.8.1` | Generic ZTE |
| `192.168.254.1` | Generic ZTE |




## Notes

- All communication is over HTTP on the local network — never exposed to the internet.
- The script does not collect or transmit any data externally.
- Band locking and cell locking changes persist after reboot.  
  Always note your original band lock value before experimenting.
- Tested on firmware `BD_WINDTREITMC889V1.0.0B10` / Web UI `WEB_WINDTREITMC889V1.0.0B08`.

---

## Support the project

If this panel was helpful to you, consider a small tip ☕ 
[buymeacoffee.com/cerix](https://buymeacoffee.com/cerix)

There is a small `CFG` block you can edit:

```js
var CFG = {
  bmac: true,   // set to false to hide the Buy Me a Coffee banner
  ...
};
```
