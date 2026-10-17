# Third-party software in Onyx

Onyx itself is MIT licensed (see LICENSE). It bundles:

- **Mediabunny** — Mozilla Public License 2.0, © Vanilagy. Source: https://github.com/Vanilagy/mediabunny. Used unmodified for writing the saved clips as MP4 files (the video and sound are put in the file as they were recorded, without re-encoding) and for reading the length of clips.
- **Electron / Chromium** — MIT and BSD-style licences, provided by the Crystal Suite launcher.

`OnyxHelper.exe` is compiled from Onyx's own source (`native/` in the Crystal Suite repository) and uses parts of Windows: Windows.Graphics.Capture for capturing game windows, Direct3D 11 and Media Foundation's video processor and H.264 encoders (the graphics card's own encoder — NVIDIA NVENC, AMD AMF or Intel Quick Sync — where there is one), WASAPI for the sound, and Media Foundation's AAC encoder.
