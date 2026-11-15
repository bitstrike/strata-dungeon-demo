#!/bin/bash
# tools/make-flame-atlas.sh
#
# Turn the image-model output (assets/torch-flame.png: a 4x2 grid of 384x512
# cells, 8-bit RGB, no alpha, bases at inconsistent heights) into the strip the
# renderer actually wants: one row of 8 equal cells, bottom-anchored, sorted by
# height so the flicker ramps instead of popping, with the flat base softened.
#
#   usage: tools/make-flame-atlas.sh [cellH] [fadeFrac] [colors]
#          defaults: 160  0.06      222
#
# Writes assets/torch-flame-atlas.png and assets/torch-flame.json.
# Needs ImageMagick 6 (/bin/convert). The source file is never modified.
set -euo pipefail

SRC=assets/torch-flame.png
OUT=assets/torch-flame-atlas.png
META=assets/torch-flame.json
CH=${1:-160}
FADE=${2:-0.06}
COLORS=${3:-222}

# source grid, measured from the file (see assets/torch-flame.json)
COLS=4; ROWS=2; CELLW=384; CELLH=512; N=8
# source cells ordered shortest flame -> tallest flame; the loader plays this
# forwards then backwards ("pingpong") so no frame jump is visible
ORDER="5 6 1 3 7 0 4 2"

command -v convert >/dev/null || { echo "convert (ImageMagick 6) not found" >&2; exit 1; }
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# --- 1. slice the grid, then trim each cell down to its flame ---------------
for i in $(seq 0 $((N - 1))); do
  c=$((i % COLS)); r=$((i / COLS))
  convert "$SRC" -crop ${CELLW}x${CELLH}+$((c * CELLW))+$((r * CELLH)) +repage \
          -fuzz 6% -trim +repage "$WORK/cell$i.png"
done

# --- 2. fade the flat base, in source-cell order ----------------------------
# the sprite pass draws with depthMask(false), so a hard-cut base would paint a
# bright horizontal edge straight over the iron rim of the brazier.
for i in $(seq 0 $((N - 1))); do
  W=$(identify -format "%w" "$WORK/cell$i.png")
  H=$(identify -format "%h" "$WORK/cell$i.png")
  F=$(awk -v h="$H" -v f="$FADE" 'BEGIN{printf "%d", h * f + 0.5}'); [ $F -lt 1 ] && F=1
  convert -size ${W}x${H} xc:white \
          \( -size ${W}x${F} gradient:white-black \) -gravity South -composite \
          "$WORK/mask.png"
  convert "$WORK/cell$i.png" "$WORK/mask.png" -compose Multiply -composite \
          "$WORK/f$i.png"
done

# --- 3. one cell width for all frames: every frame scaled to height CH, ------
#      aspect kept, then padded to the widest and pinned to the bottom edge ---
CW=0
for i in $ORDER; do
  w=$(identify -format "%w" "$WORK/cell$i.png")
  h=$(identify -format "%h" "$WORK/cell$i.png")
  s=$(awk -v w="$w" -v h="$h" -v c="$CH" 'BEGIN{printf "%d", w * c / h + 0.5}')
  [ $s -gt $CW ] && CW=$s
done
CW=$(awk -v c="$CW" 'BEGIN{printf "%d", int((c + 3) / 4) * 4}')   # round up to a multiple of 4

LIST=""
n=0
for i in $ORDER; do
  # -background black is NOT optional: -extent pads with the background colour,
  # and the default resolves to white, which additive blending would then paint
  # as bright bars between frames.
  convert "$WORK/f$i.png" -filter Lanczos -resize x${CH} -background black \
          -gravity South -extent ${CW}x${CH} "$WORK/p$n.png"
  LIST="$LIST $WORK/p$n.png"
  n=$((n + 1))
done

# --- 4. one row of 8, palette-quantized ------------------------------------
# additive blending (gl.blendFunc(ONE, ONE)) makes the black background free, so
# no alpha channel is needed; a 222-colour palette is ~2.5x smaller than RGBA
# and the flame is a smooth ramp, so banding is not visible at this size.
convert $LIST +append -colorspace sRGB -dither None -colors "$COLORS" \
        -define png:compression-level=9 "$OUT"

# --- 5. prove the gutters are black -----------------------------------------
# Additive blending has no "background" to hide: padding that is not black
# becomes a lit bar across the scene. Measure each padded frame's own content
# box (authoritative, no re-derived arithmetic) and check exactly those padding
# columns in the finished atlas. A wide flame reaching its cell edge is not
# padding and is not an error.
BAD=""
k=0
n=0
for i in $ORDER; do
  # authoritative content box of the padded frame. Read the offsets from -trim
  # WITHOUT +repage: +repage resets the page origin to +0+0 and the offsets
  # would read as zero, which makes the check probe the flame itself.
  read -r TW TH TX TY <<< "$(convert "$WORK/p$n.png" -fuzz 2% -trim -format '%w %h %X %Y' info:)"
  TX=${TX#+}; TY=${TY#+}
  padL=$TX
  padR=$((CW - TX - TW))
  if [ "$padL" -gt 0 ]; then
    L=$(convert "$OUT" -crop ${padL}x${CH}+$((k * CW))+0 +repage -format "%[fx:maxima]" info:)
    awk -v m="$L" 'BEGIN{exit !(m > 0.02)}' && BAD="$BAD left$k=$L"
  fi
  if [ "$padR" -gt 0 ]; then
    R=$(convert "$OUT" -crop ${padR}x${CH}+$((k * CW + CW - padR))+0 +repage -format "%[fx:maxima]" info:)
    awk -v m="$R" 'BEGIN{exit !(m > 0.02)}' && BAD="$BAD right$k=$R"
  fi
  k=$((k + 1)); n=$((n + 1))
done
[ -n "$BAD" ] && { echo "FAIL: non-black gutter padding:$BAD" >&2; exit 1; }

B=$(stat -c %s "$OUT")
cat > "$META" <<JSON
{
  "source": "torch-flame.png",
  "sourceGeometry": "1536x1024 4x2 grid of ${CELLW}x${CELLH} cells, 8-bit RGB",
  "atlas": "$(basename $OUT)",
  "geometry": "$(identify -format '%wx%h' $OUT) 8-bit palette RGB",
  "frames": $N, "cols": $N, "rows": 1,
  "cellW": $CW, "cellH": $CH,
  "bytes": $B, "base64Chars": $((B * 4 / 3)),
  "order": "row-major, frame 0 = shortest flame",
  "frameOrder": [$(echo $ORDER | tr ' ' ',')],
  "fps": 14, "loop": "pingpong",
  "anchorX": 0.5, "anchorY": 1.0,
  "baseFadeFrac": $FADE,
  "body": "additive",
  "tint": [1.0, 1.0, 1.0],
  "cellHeightsPx": [$(for i in $ORDER; do identify -format "%h " "$WORK/cell$i.png"; done | xargs | tr ' ' ',')]
}
JSON

echo "atlas  $(identify -format '%wx%h %[channels]' $OUT)  cell ${CW}x${CH}  bytes $B  base64 $((B * 4 / 3))"
echo "meta   $META"
