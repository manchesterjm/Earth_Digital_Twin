"""Simple local server for the Earth Digital Twin viewer.

Run:    python serve.py [port]
Default port: 8765
"""
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Adds correct MIME types and basic CORS for local development."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js":   "application/javascript",
        ".mjs":  "application/javascript",
        ".css":  "text/css",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".glb":  "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet — only print errors
        if args and isinstance(args[1], str) and args[1].startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    here = Path(__file__).parent.resolve()
    import os
    os.chdir(here)

    handler = QuietHandler
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://localhost:{port}/"
        print(f"Serving {here}")
        print(f"  -> {url}   (Ctrl+C to stop)")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
