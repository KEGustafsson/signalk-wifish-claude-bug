# Changelog

## 0.2.0

- Signal K server plugin (TypeScript): discovers a Wi-Fish / Dragonfly Pro on the
  Wi-Fi, keeps the session alive and publishes `environment.depth.belowTransducer`
  (plus `belowSurface` / `belowKeel` when a transducer offset is set) and
  `environment.water.temperature`.
- "Wi-Fish Sonar" web app with the Android app's sonar screen: scrolling CHIRP sonar
  and DownVision echograms (split or single), depth ruler, depth and water
  temperature readout, pause and history scrolling, pinch/wheel zoom with zoom box,
  A-scope, depth lines, the app's nine palettes, snapshots, and trace point details.
- Sonar settings like the app (Sensitivity: gain, contrast, noise filter with Auto;
  Range: auto, shallow, deep; Options: palette, depth lines, A-scope) and main
  settings (transducer depth, depth and temperature units, simulator), sent to the
  sonar as read-modify-write settings messages.
- Built-in demo sonar and raw-capture replay for trying the app without hardware.
- Protocol notes extended with the channel and system settings layouts, vertical
  scale of ping columns, low-voltage flag and software version.
- Signal K plugin CI workflow; tests moved to vitest.

## 0.1.0

- Protocol documentation, probe and raw-capture tools.
