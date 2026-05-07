#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════╗
║   Bosch Porosity Inspector — Launcher                ║
║   Porosity Validation Inspection                     ║
╚══════════════════════════════════════════════════════╝

Usage:
    python3 launch.py
    python3 launch.py --port 9000
    python3 launch.py --no-browser
"""
import sys
import subprocess
import importlib
import threading
import time
import webbrowser
import argparse

HOST = "127.0.0.1"
DEFAULT_PORT = 8000
APP_DIR = "pvi_web"

# ── Dependency check / auto-install ────────────────────────────────────────
REQUIRED = {
    "fastapi":        "fastapi",
    "uvicorn":        "uvicorn[standard]",
    "reportlab":      "reportlab",
    "pydantic":       "pydantic",
}

def check_deps():
    missing = []
    for pkg, pip_name in REQUIRED.items():
        try:
            importlib.import_module(pkg)
        except ImportError:
            missing.append(pip_name)
    if missing:
        print(f"\n⚠  Missing packages: {', '.join(missing)}")
        print("   Installing automatically...\n")
        subprocess.check_call([sys.executable, "-m", "pip", "install", *missing])
        print("\n✅  Dependencies installed.\n")

# ── Banner ──────────────────────────────────────────────────────────────────
BANNER = """
╔══════════════════════════════════════════════════════╗
║   BOSCH POROSITY                                      ║
║   Porosity Validation Inspection                      ║
╚══════════════════════════════════════════════════════╝
"""

def main():
    parser = argparse.ArgumentParser(description="Bosch Porosity Inspector Launcher")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"Port to run on (default: {DEFAULT_PORT})")
    parser.add_argument("--no-browser", action="store_true",
                        help="Don't open the browser automatically")
    args = parser.parse_args()

    print(BANNER)
    print("  Checking dependencies...")
    check_deps()
    print("  ✅  All dependencies satisfied.\n")

    url = f"http://{HOST}:{args.port}"

    if not args.no_browser:
        def _open():
            time.sleep(1.8)   # wait for server to be ready
            webbrowser.open(url)
        threading.Thread(target=_open, daemon=True).start()
        print(f"  🌐  Browser will open at: {url}\n")
    else:
        print(f"  🌐  Server will be available at: {url}\n")

    print("  Press Ctrl+C to stop the server.\n")
    print("─" * 54)

    import os
    web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), APP_DIR)
    subprocess.run(
        [sys.executable, "server.py", "--port", str(args.port)],
        cwd=web_dir
    )

if __name__ == "__main__":
    main()
