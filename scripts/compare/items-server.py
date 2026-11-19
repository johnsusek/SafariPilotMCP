# Serves testpage-items on 127.0.0.1:8766, each laptop's page at /laptops/<id> held back 1.5 s like a real site's page load, so opening results
# one by one costs what it would on the web. Nothing is cacheable, so every run pays it.
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

folder = Path(__file__).resolve().parents[2] / "testpage-items"


class SlowItems(BaseHTTPRequestHandler):
  def do_GET(self):
    path = self.path.split("?")[0]

    if path.startswith("/laptops/"):
      time.sleep(1.5)
      self.send_file(folder / "item.html", "text/html")
      return

    if path == "/laptops.js":
      self.send_file(folder / "laptops.js", "text/javascript")
      return

    self.send_error(404)

  def send_file(self, file, kind):
    body = file.read_bytes()
    self.send_response(200)
    self.send_header("Content-Type", f"{kind}; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", 8766), SlowItems).serve_forever()
