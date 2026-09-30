# Network setup (Jetson + Wi-Fish)

The Wi-Fish is a Wi-Fi access point. Discovery uses `224.0.0.1`, which is
link-local and cannot be routed, so the host running the client must join the
Wi-Fish Wi-Fi directly. Keep Ethernet as the default route and use the WLAN
only for the sonar subnet.

```sh
nmcli dev wifi connect "<Wi-Fish SSID>" password "<key>" name wifish
nmcli con mod wifish \
  ipv4.never-default yes \
  ipv4.ignore-auto-dns yes \
  ipv6.method disabled \
  802-11-wireless.powersave 2 \
  connection.autoconnect-retries 0
nmcli con up wifish
```

- `never-default`: default route stays on eth0.
- `powersave 2`: Wi-Fi power save drops multicast frames.
- `autoconnect-retries 0`: reconnect whenever the sonar powers up.

Verify:

```sh
ip route                     # exactly one default route, via eth0
ip -4 addr show wlan0        # note the WLAN address
ip maddr show dev wlan0      # while the probe runs: 224.0.0.1 + data group
```

Make sure the LAN subnet does not overlap the Wi-Fish subnet.

## Docker

A containerised client needs `network_mode: host` to receive the multicast.
