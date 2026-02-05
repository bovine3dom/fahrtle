#!/bin/bash
for f in *.png; do magick "$f" -quality 80 "${f%.*}.webp"; done
