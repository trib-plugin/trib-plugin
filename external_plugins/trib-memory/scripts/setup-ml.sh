#!/bin/bash
# Optional ML dependencies for reranker + tokenizer
VENV_DIR="$(dirname "$0")/../services/.venv"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install -q torch transformers kiwipiepy dateparser
echo "ML dependencies installed."
