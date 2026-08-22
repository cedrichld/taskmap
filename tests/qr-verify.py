#!/usr/bin/env python3
"""Decode src/qr.js output with an independent decoder (OpenCV) and compare.

src/qr.js is a from-scratch QR encoder, so "it looks like a QR code" is not
evidence. This renders its matrix to an image and asks cv2.QRCodeDetector what
it says. Skips (exit 0) when OpenCV or numpy is missing, so smoke.sh can call it
unconditionally.

    python3 tests/qr-verify.py
"""
import json
import os
import random
import string
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
QR_JS = os.path.join(HERE, "..", "src", "qr.js")

try:
    import numpy as np
    import cv2
except ImportError as e:  # pragma: no cover - environment dependent
    print(f"skip qr-verify: {e}")
    sys.exit(0)


def encode(texts):
    script = (
        "const qr = require(process.argv[1]);"
        "console.log(JSON.stringify(process.argv.slice(2).map((t) => {"
        "  const r = qr.encode(t);"
        "  return { text: t, size: r.size, version: r.version, level: r.level,"
        "           grid: r.grid.map((row) => row.map((v) => (v ? 1 : 0)).join('')) };"
        "})));"
    )
    raw = subprocess.check_output(["node", "-e", script, QR_JS] + texts)
    return json.loads(raw.decode())


def decode(entry):
    """Try increasingly generous renders: OpenCV's detector is the weak link."""
    size = entry["size"]
    grid = np.array(
        [[0 if c == "1" else 255 for c in row] for row in entry["grid"]], dtype=np.uint8
    )
    det = cv2.QRCodeDetector()
    for quiet, scale in ((4, 8), (6, 14), (10, 30)):
        padded = np.full((size + 2 * quiet, size + 2 * quiet), 255, dtype=np.uint8)
        padded[quiet:quiet + size, quiet:quiet + size] = grid
        img = np.kron(padded, np.ones((scale, scale), dtype=np.uint8))
        value, _, _ = det.detectAndDecode(img)
        if value == entry["text"]:
            return True
    return False


def main():
    rnd = random.Random(20260822)
    alphabet = string.ascii_letters + string.digits + "-_./:"
    texts = [
        "x",
        "http://127.0.0.1:4242/",
        "https://calm-forest-1234.trycloudflare.com/?t=" + "A" * 43,
        "https://a-longer-tunnel-name-here.trycloudflare.com/p/portfolio-website-3f9a1c?t="
        + "z9_-" * 10 + "abc",
    ]
    # every version this encoder supports, both error-correction levels
    texts += ["".join(rnd.choice(alphabet) for _ in range(n))
              for n in (10, 30, 50, 70, 100, 125, 155, 185, 230, 271)]

    entries = encode(texts)
    failed = []
    for entry in entries:
        if decode(entry):
            print(f"ok   v{entry['version']}-{entry['level']} {entry['size']}x{entry['size']} "
                  f"{len(entry['text'])} bytes")
        else:
            failed.append(entry)
            print(f"FAIL v{entry['version']}-{entry['level']} {entry['size']}x{entry['size']} "
                  f"{len(entry['text'])} bytes did not decode")
    print(f"{len(entries) - len(failed)}/{len(entries)} QR codes decoded correctly")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
