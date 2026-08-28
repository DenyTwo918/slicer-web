# Lychee reference exports

## `benchy-solid-aa-smooth-100um.pm7`

- Slicer: Lychee Slicer 7.6.1
- Printer: Anycubic Photon Mono M7
- Source: `public/models/3DBenchy.stl`
- Source SHA-256: `6AB57F1C3F8E86BC3CBD302C6FA6270ACF06277C6335454E922419C25D42E97E`
- Orientation/scale: original, centered on the build plate
- Layer height: 100 um / 0.1 mm
- Normal exposure: 2.5 s
- Bottom layers: 5
- Bottom exposure: 25 s
- Supports: none
- Hollowing: none
- Raft: none
- Anti-aliasing: Smooth Surfaces, radius 2 px, grey offset 30%, HD AA off
- Mesh repair: not applied (Lychee reported one topology error)
- Layers: 480
- PM7 SHA-256: `F405E8A5BA2A748F4C9759971A1A569648D59D68DB2E4140A26C535552920C4A`
- Validation: ZIP CRC and all 480 PW0 layers pass; successfully opened and
  scrubbed in Anycubic Photon Workshop 4.1.8 (M7, 0.100 mm, 2.500 s detected).

The file is an Anycubic ZIP container. Although its manifest declares `pwszImg`,
Lychee stores the actual layer payloads as `layer_N.pw0Img` RLE4 images at
13,312 x 5,120 pixels.
