#!/bin/bash
set -e

# Ensure wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "wasm-pack could not be found. Please install it with:"
    echo "curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh"
    exit 1
fi

echo "Building sui-move-wasm for web..."
wasm-pack build --target web --out-dir pkg

echo "Build successful! Artifacts in sui-move-wasm/pkg"
