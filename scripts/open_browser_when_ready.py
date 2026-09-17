"""Open CUTTAlogue in the default browser once its HTTP server is ready."""

from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request
import webbrowser


def wait_and_open(url: str, timeout_seconds: float = 60.0) -> bool:
    deadline = time.monotonic() + timeout_seconds

    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 400:
                    webbrowser.open(url)
                    return True
        except (TimeoutError, OSError, urllib.error.URLError):
            pass

        time.sleep(0.25)

    return False


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: open_browser_when_ready.py URL")

    raise SystemExit(0 if wait_and_open(sys.argv[1]) else 1)
