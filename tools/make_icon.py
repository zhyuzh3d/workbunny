#!/usr/bin/env python3
"""Compatibility launcher for the SVG-based application/menu icon generator."""
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
subprocess.run([str(root / "node_modules/.bin/electron"), str(root / "tools/make-icons.cjs")], cwd=root, env=env, check=True)
