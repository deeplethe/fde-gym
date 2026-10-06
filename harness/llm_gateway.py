#!/usr/bin/env python3
"""The customer's LLM gateway: the only way code in a workspace reaches a model.

One fixed cheap model, a hard cap on calls and spend, every call logged. The key
never leaves this process.

    python3 harness/llm_gateway.py --port 8800 --log runs/x/logs/llm.jsonl \
        --max-calls 400 --max-usd 0.30
"""
import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm  # noqa: E402

MAX_TOKENS_CAP = 800
MAX_INPUT_CHARS = 60000


def make_handler(a):
    state = {"calls": 0, "usd": 0.0}
    lock = threading.Lock()

    class H(BaseHTTPRequestHandler):
        def _send(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._send({"calls": state["calls"], "max_calls": a.max_calls,
                        "usd": round(state["usd"], 5), "max_usd": a.max_usd, "model": a.model})

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            try:
                req = json.loads(self.rfile.read(n).decode("utf-8"))
                messages = req["messages"]
            except (ValueError, KeyError) as e:
                return self._send({"error": "bad request: %s" % e}, 400)
            if sum(len(str(m.get("content", ""))) for m in messages) > MAX_INPUT_CHARS:
                return self._send({"error": "request too large (max %d chars)" % MAX_INPUT_CHARS}, 413)
            with lock:
                if state["calls"] >= a.max_calls or state["usd"] >= a.max_usd:
                    return self._send({"error": "LLM budget exhausted"}, 429)
                state["calls"] += 1
            try:
                text, usage = llm.chat(
                    messages, model=a.model,
                    max_tokens=min(int(req.get("max_tokens", 400)), MAX_TOKENS_CAP),
                    temperature=float(req.get("temperature", 0.0)),
                    json_mode=bool(req.get("json_mode")), log_path=a.log, tag=a.tag,
                )
            except RuntimeError as e:
                return self._send({"error": str(e)}, 502)
            with lock:
                state["usd"] += usage["usd"]
            self._send({"text": text})

        def log_message(self, *args):
            pass

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--model", default=llm.DEFAULT_MODEL)
    ap.add_argument("--max-calls", type=int, default=400)
    ap.add_argument("--max-usd", type=float, default=0.30)
    ap.add_argument("--tag", default="workspace")
    a = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(a)).serve_forever()


if __name__ == "__main__":
    main()
