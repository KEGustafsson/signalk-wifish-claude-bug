# Raymarine Wi-Fish / Dragonfly Pro — "Sonar4" network protocol

Derived from static analysis of the Android app `com.raymarine.wi_fish` v0.7.1
(decompiled with jadx). Offsets are byte offsets from the start of the UDP payload.
**All integers are little-endian.** Confidence: ✅ read directly from code,
🟡 inferred from usage, ❓ unknown / needs capture to confirm.

Supported units (unit-type codes): Wi-Fish dv = 63, Dragonfly-4 Pro = 67,
Dragonfly-5 Pro = 66, Dragonfly-7 Pro = 78. Protocol version constant = **116**.

## 1. Transport

| Channel | Addressing | Direction |
|---|---|---|
| Discovery | multicast `224.0.0.1:5800` | device → clients |
| Sonar data | multicast group + port **announced in discovery** | device → clients |
| Control / keepalive | unicast to device IP + control port **announced in discovery**, from an ephemeral local port | client → device |
| Waypoint sync | TCP, address announced in discovery (service 15) | bidirectional (ignore for sonar) |

The app binds to the local interface whose IPv4 starts with `192.` and holds a
Wi-Fi multicast lock. Receive buffer 2048 bytes.

## 2. Discovery (on 224.0.0.1:5800)

### Service announcement — msg id `0`
| Off | Type | Meaning |
|---|---|---|
| 0 | u32 | message id = 0 ✅ |
| 8 | u32 | service id: **39 = sonar data**, 15 = waypoint TCP ✅ |
| 20..23 | 4×u8 | service 39: data multicast group, dotted order `b20.b21.b22.b23` ✅ (service 15: IP in reverse byte order 🟡) |
| 24 | u32 | service port (39: data multicast port) ✅ |
| 28..31 | 4×u8 | device IP, dotted order ✅ |
| 32 | u32 | device control (unicast) port ✅ |

### Unit identification — msg id `1`
| Off | Type | Meaning |
|---|---|---|
| 4 | u32 | unit type (63 = Wi-Fish) ✅ |
| 8 | u32 | shown as hex, probably serial 🟡 |
| 12 | u32 | ❓ |
| 20..51 | char[32] | unit name, NUL-padded ✅ |

## 3. Session sequence ✅

1. Join `224.0.0.1:5800`; wait for **msg 0 / service 39** and **msg 1**.
2. Join the announced data group:port.
3. Every **1 s**, send a keepalive (§4) to device IP : control port.
4. Wait until all "required" messages have arrived at least once: env data
   (0x270104), error status (0x27010D), system status (0x270103), system
   settings (0x270106), per-channel sonar settings (0x270102). Then set
   keepalive byte 16 = 1 ("connected").
5. Stream ping data / results / bottom depth.

## 4. Sonar4 common header (all 0x2701xx messages)

| Off | Type | Meaning |
|---|---|---|
| 0 | u32 | message id ✅ |
| 4 | u32 | total message length ✅ |
| 8 | u32 | protocol version, must be 116 ✅ |
| 12 | u32 | sequence / session value ✅ |
| 16.. | | payload |

### Keepalive — `0x270100` (2556160), client → device, 37 bytes ✅
| Off | Value |
|---|---|
| 0 | 0x270100 |
| 4 | 37 |
| 8 | 116 |
| 12 | 0xDEADBEEF |
| 16 | u8 state: 0 = connecting, 1 = all required messages received |
| 17 | u64 unix time (seconds) |
| 25 | i64 −1 |
| 33 | i32 INT32_MIN (−2³¹, bytes `00 00 00 80`) |

## 5. Device → client messages

| Id | Dec | Name | Min len |
|---|---|---|---|
| 0x270101 | 2556161 | Ping data (sample segments) | 37 |
| 0x270102 | 2556162 | Sonar channel settings (also sent by client) | 94 |
| 0x270103 | 2556163 | System status | 1063 |
| 0x270104 | 2556164 | Environment data | 68 |
| 0x270106 | 2556166 | System settings (also sent by client) | 562 |
| 0x270108 | 2556168 | Master bottom record (**depth**) | 22 |
| 0x270109 / 0x27010A | | ignored by app | |

A message shorter than its minimum length, or shorter than its own header
length field (off 4), is malformed and should be dropped.
| 0x27010B | 2556171 | Ping results (per-ping metadata) | 130 |
| 0x27010D | 2556173 | Error status | 20 |

### Master bottom record — 0x270108 ✅
| Off | Type | Meaning |
|---|---|---|
| 16 | u8 | clamped 0..3 by app ❓ (bottom-lock quality?) |
| 17 | i32 | **depth, cm**; `INT32_MIN` = no bottom lock ✅ |
| 21 | u8 | clamped 0..2 ❓ (channel/source?) |

The app shows this value raw as "bottom" and subtracts the transducer offset
(system settings, off 58, i16 🟡) only when drawing traces. Whether the
reported value is below-transducer or below-surface must be checked against a
known depth. ❓

### Environment data — 0x270104
| Off | Type | Meaning |
|---|---|---|
| 28 | i16 | **water temperature, centi-°C**; `INT16_MIN` = invalid ✅ |
| 16..27, 30..67 | | ~22 further fields, unused in UI ❓ (candidates: supply voltage, speed) |

### Error status — 0x27010D
| Off | Type | Meaning |
|---|---|---|
| 16 | u32 | error flags; bit 0x100 selects one of two UI warnings 🟡 (likely low voltage vs. no transducer) |

### Ping data — 0x270101 ✅ (segmented; reassemble per ping)
| Off | Type | Meaning |
|---|---|---|
| 16 | u32 | error code, must be 0 |
| 20 | u32 | byte offset of this segment in the column |
| 24 | u32 | total column length (≤ 1024) |
| 28 | u32 | ❓ |
| 32 | u8 | data type |
| 33 | u8 | ping sequence (matches Ping results off 16) |
| 34 | u8 | segment index |
| 35 | u8 | segment count |
| 36 | u8 | range/setting index 🟡 |
| 37.. | u8[] | echo samples (1 byte each, 🟡 0 = no return) |

Column complete when `segment == count − 1`. Drop the ping on a gap.

### Ping results — 0x27010B
| Off | Type | Meaning |
|---|---|---|
| 16 | u8 | ping sequence ✅ |
| 21 | u8 | ❓ |
| 95 | u8 | **channel: 0 = CHIRP sonar, 1 = DownVision** ✅ |
| 104 | i32 | 🟡 range start (cm) |
| 108 | i32 | 🟡 range end (cm) |
| 112..129 | | ❓ |

Pair each completed Ping data column with the Ping results of the same
sequence to get channel and vertical scale.

## 6. Settings (client → device)
Both settings messages are **read-modify-write**: the device broadcasts
current state and the app sends back a modified copy (same id and layout).
A passive depth reader never needs to send them.

## 7. Open questions for hardware testing
- Does the unit accept a second client (Jetson + phone at once)?
- Does data flow without a keepalive? How long after the last keepalive does it stop?
- Is depth below-transducer or offset-corrected?
- Semantics of the ❓ fields, especially Environment data and Ping results.
