# Vyz Studio User Guide

### In-Browser Broadcast Studio & Modular Media Pipelines

**Vyz** is a lightweight, zero-install broadcast studio and media recorder running entirely inside your browser. Layer multiple camera, screen, mic, and remote participant feeds in professional layouts, apply MediaPipe-flow visual filters and custom plugins, broadcast the merged program stream over WebRTC, or record high-definition `.webm` video.

---

## 1. Core Studio Architecture

* **Card-Based Media Sources:** Every media feed (webcam, screen share, microphone, remote peer, virtual stream) is managed as an independent card.
* **Independent Audio & Video Toggles:** Toggle video visibility and audio muting separately on any card. When video is muted, Vyz renders an animated avatar pill with live voice rings.
* **Merged Studio Broadcast:** The host can broadcast the merged, mixed canvas and audio stream as a single virtual media source over WebRTC to room peers or viewers.
* **High-Bitrate Recording:** Hardware-accelerated recording (`VP9/Opus`) captures layout transitions, audio mixing, and post-processing filters in real-time.
* **Public & Custom WebRTC (STUN/TURN):** Runs automatically on public STUN servers (Google & Cloudflare) with an in-app configuration dialog to add custom STUN/TURN relays.

---

## 2. Media Source Cards & Controls

Each source card in the studio shelf provides granular controls:

* **Audio Toggle (`Mic`):** Mute or unmute the audio track. Displays real-time audio VU meter levels.
* **Video Toggle (`Camera`):** Blank or unblank the video track. Controllable by either the host or source owner.
* **Fit Mode (`Crop`):** Switch between **Cover** (fills frame, professional crop) and **Contain** (letterboxed, zero crop for code/slides).
* **Pipeline FX (`Tune`):** Open the filter dialog to select visual presets, MediaPipe bokeh blur, or load custom filters.
* **Solo / Focus:** Feature a single source in full-stage view.

---

## 3. MediaPipe-Flow Filters & Custom Plugins

### Built-in Presets
* **MediaPipe Bokeh:** Soft depth-of-field background blur.
* **Studio Vibrant:** Saturated pop for webcams.
* **Cinematic Warm:** Film-style teal and orange grade.
* **Sharpen:** Enhanced high-frequency contrast (ideal for reading text in screen shares).
* **35mm Vintage Film:** Subtle film grain, scanlines, and vignette.
* **Cyberpunk Neon:** Edge-detection neon highlights.

### Custom Filter Importer
Load custom canvas and shader filters at runtime:
1. **From URL:** Provide any hosted ES module or script exporting a `{ id, name, process(ctx, media, opts) }` contract.
2. **From File:** Upload a local `.js` or `.json` filter definition.
3. **Master Output FX:** Apply post-processing filters to the entire merged studio program canvas before broadcast or recording.

---

## 4. Keyboard Shortcuts (Hotkeys)

| Shortcut | Action | Description |
| :--- | :--- | :--- |
| <kbd>Space</kbd> or <kbd>R</kbd> | **Record Studio** | Start or stop local studio recording (`.webm`). |
| <kbd>B</kbd> | **Go Live** | Start or stop broadcasting the merged stream to peers. |
| <kbd>V</kbd> | **Toggle Camera** | Turn the primary video track on or off. |
| <kbd>M</kbd> | **Toggle Mic** | Mute or unmute the primary audio track. |
| <kbd>1</kbd> – <kbd>5</kbd> | **Switch Layouts** | `1`: Grid, `2`: Side-by-side, `3`: Stack, `4`: PiP, `5`: Solo. |
| <kbd>A</kbd> | **Aspect Ratio** | Cycle between `16:9`, `9:16`, `1:1`, and `4:3`. |
| <kbd>F</kbd> | **Fullscreen** | Toggle fullscreen canvas preview. |
| <kbd>?</kbd> | **Hotkeys Help** | Open keyboard shortcuts reference modal. |

---

## 5. WebRTC Multi-Participant Rooms

1. **Host a Room:** Open the studio; click **Invite Peer** in the top bar to copy your room URL.
2. **Join as Participant:** Guests open the link, grant camera/mic permissions, and their sources automatically appear in the host's studio card deck.
3. **Custom Relay Servers:** Click **WebRTC Servers** in the header to enter custom TURN credentials for restricted corporate networks.

---

**Vyz** • *Captured with ❤️ in Islamabad.* [Open Vyz Studio](https://hassaanmaqsood.github.io/vyz/)
