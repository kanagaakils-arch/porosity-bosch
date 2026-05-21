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
import os

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

STREAMLIT_REQUIRED = {
    "streamlit":      "streamlit",
    "cv2":            "opencv-python-headless",
    "PIL":            "pillow",
    "plotly":         "plotly",
}

def check_deps(streamlit_mode=False):
    deps = REQUIRED.copy()
    if streamlit_mode:
        deps.update(STREAMLIT_REQUIRED)
    missing = []
    for pkg, pip_name in deps.items():
        try:
            importlib.import_module(pkg)
        except ImportError:
            missing.append(pip_name)
    if missing:
        print(f"\n⚠  Missing packages: {', '.join(missing)}")
        print("   Installing automatically...\n")
        cmd = [sys.executable, "-m", "pip", "install", *missing]
        try:
            subprocess.check_call(cmd)
        except subprocess.CalledProcessError:
            try:
                print("   Retrying with system package flags...")
                subprocess.check_call(cmd + ["--break-system-packages"])
            except subprocess.CalledProcessError as e:
                print(f"❌ Failed to install dependencies: {e}")
                print("Please install manually:")
                print(f"pip3 install {' '.join(missing)}")
                sys.exit(1)
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
    parser.add_argument("--streamlit", action="store_true",
                        help="Launch the Streamlit version of the Porosity Inspector")
    args = parser.parse_args()

    print(BANNER)
    print("  Checking dependencies...")
    check_deps(streamlit_mode=args.streamlit)
    print("  ✅  All dependencies satisfied.\n")

    if args.streamlit:
        url = f"http://{HOST}:{args.port}"
        if not args.no_browser:
            def _open():
                time.sleep(2.5)   # wait for Streamlit to start
                webbrowser.open(url)
            threading.Thread(target=_open, daemon=True).start()
            print(f"  🌐  Browser will open at: {url}\n")
        else:
            print(f"  🌐  Streamlit will be available at: {url}\n")

        print("  Press Ctrl+C to stop the Streamlit app.\n")
        print("─" * 54)

        root_dir = os.path.dirname(os.path.abspath(__file__))
        subprocess.run(
            [sys.executable, "-m", "streamlit", "run", "app_streamlit.py", "--server.port", str(args.port)],
            cwd=root_dir
        )
    else:
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

        web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), APP_DIR)
        subprocess.run(
            [sys.executable, "server.py", "--port", str(args.port)],
            cwd=web_dir
        )

if __name__ == "__main__":
    main()
