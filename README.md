# signalk-wifish

Open interface to the Raymarine **Wi-Fish** (and Dragonfly-4/5/7 Pro) Wi-Fi
sonar. Goal: publish depth and water temperature to [Signal K](https://signalk.org)
and stream echogram data to a custom sonar UI.

**Status:** protocol documented from static analysis; hardware validation in progress.

## Contents

| Path | What |
|---|---|
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | "Sonar4" network protocol: discovery, keepalive, message layouts |
| [`docs/network-setup.md`](docs/network-setup.md) | Jetson dual-homing: Ethernet default route + WLAN to the sonar |
| [`tools/wifish-probe.mjs`](tools/wifish-probe.mjs) | Test client: discovery, keepalive, depth/temp decode, raw logging, optional Signal K UDP output |
| [`tools/dump-raw.mjs`](tools/dump-raw.mjs) | Inspect raw captures from the probe |

## Quick start

Requires Node.js 18+, no dependencies. The host must be joined to the Wi-Fish Wi-Fi.

```sh
node tools/wifish-probe.mjs --iface <wlan IP> --log raw.bin
node tools/wifish-probe.mjs --iface <wlan IP> --sk 127.0.0.1:<signalk udp port>
node tools/wifish-probe.mjs --iface <wlan IP> --no-keepalive   # passive test
node tools/dump-raw.mjs raw.bin --id 0x270104 --hex
```

Signal K paths emitted: `environment.depth.belowTransducer` (m),
`environment.water.temperature` (K).

## Roadmap

- [ ] Validate on hardware; resolve ❓ fields in the protocol doc
- [ ] Confirm depth reference (below transducer vs. offset-corrected)
- [ ] Signal K server plugin (TypeScript, vitest)
- [ ] Echogram WebSocket stream + web UI

## Legal

Independent interoperability work, not affiliated with or endorsed by
Raymarine. This repository contains no Raymarine code; the protocol was
documented for interoperability with hardware the author owns.
Raymarine, Wi-Fish and Dragonfly are trademarks of their respective owners.
