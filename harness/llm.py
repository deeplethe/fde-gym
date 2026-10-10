"""Minimal OpenRouter client for the harness (grader, stakeholder matcher, LLM gateway).

The key is read from a file (FDEGYM_OPENROUTER_KEY_FILE, default ~/.fdegym/openrouter_key) and never
written anywhere. It is not taken from the environment: what a process is started with is inherited
by the code an agent delivers and can be read by the agent's own commands. FDEGYM_PROXY sends the
traffic through an HTTP proxy. Every call is appended to a usage log so spend is visible.

FDEGYM_LLM_URL names another chat-completions endpoint that speaks the same protocol, for a machine
that must not hold the key itself: it calls a relay that does, and the file then holds whatever that
relay asks for in place of the key.
"""
import json
import os
import threading
import random
import time
import urllib.error
import urllib.request

KEY_FILE = os.environ.get("FDEGYM_OPENROUTER_KEY_FILE") or os.path.expanduser("~/.fdegym/openrouter_key")
PROXY = os.environ.get("FDEGYM_PROXY", "")
URL = os.environ.get("FDEGYM_LLM_URL") or "https://openrouter.ai/api/v1/chat/completions"

# USD per million tokens (input, output); used only for the local spend estimate.
PRICES = {
    "deepseek/deepseek-v4-flash": (0.042, 0.084),
    "qwen/qwen3.7-flash": (0.030, 0.130),
    "google/gemini-2.5-flash-lite": (0.100, 0.400),
}
DEFAULT_MODEL = os.environ.get("FDEGYM_MODEL", "deepseek/deepseek-v4-flash")

_opener = (urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
           if PROXY else urllib.request.build_opener())
_lock = threading.Lock()


def _key():
    path = os.path.expanduser(KEY_FILE)
    if not os.path.exists(path):
        raise SystemExit("no model key: put an OpenRouter key in %s, or name another file with "
                         "FDEGYM_OPENROUTER_KEY_FILE (keep it outside the repository and the workspaces)" % path)
    with open(path) as f:
        return f.read().strip()


def chat(messages, model=None, max_tokens=600, temperature=0.0, json_mode=False,
         log_path=None, tag="", retries=3, timeout=90):
    """Returns (text, usage_dict). Raises RuntimeError after retries."""
    model = model or DEFAULT_MODEL
    # Reasoning off: these cheap models otherwise spend the whole max_tokens
    # allowance thinking and return empty content (finish_reason "length").
    body = {"model": model, "messages": messages, "max_tokens": max_tokens,
            "temperature": temperature, "reasoning": {"enabled": False}}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": "Bearer " + _key(), "Content-Type": "application/json",
                 "X-Title": "fdegym"},
    )
    last, attempt, held = None, 0, 0
    while attempt < retries:
        try:
            with _opener.open(req, timeout=timeout) as r:
                d = json.loads(r.read().decode("utf-8"))
            if "choices" not in d:
                raise RuntimeError(json.dumps(d)[:300])
            text = d["choices"][0]["message"].get("content") or ""
            if not text.strip():
                raise RuntimeError("empty completion (finish_reason=%s)" % d["choices"][0].get("finish_reason"))
            u = d.get("usage") or {}
            pin, pout = PRICES.get(model, (0.5, 1.5))
            usage = {
                "model": model, "tag": tag, "ts": time.time(),
                "prompt_tokens": u.get("prompt_tokens", 0),
                "completion_tokens": u.get("completion_tokens", 0),
            }
            usage["usd"] = (usage["prompt_tokens"] * pin + usage["completion_tokens"] * pout) / 1e6
            if log_path:
                with _lock, open(log_path, "a") as f:
                    f.write(json.dumps(usage) + "\n")
            return text, usage
        except (urllib.error.URLError, RuntimeError, ValueError, OSError) as e:
            last = e
            if getattr(e, "code", 0) == 402 and held < 20:
                # OpenRouter holding requests back while many are in flight on a low balance: not this
                # call's fault and over in a minute or two, so it does not use up an attempt
                held += 1
                time.sleep(10 + 20 * random.random())
                continue
            attempt += 1
            time.sleep(1.5 * attempt)
    raise RuntimeError("LLM call failed: %s" % last)


class LLMError(RuntimeError):
    """A call that failed. `status` is the HTTP status, or 0 when there was no response."""

    def __init__(self, status, text):
        RuntimeError.__init__(self, "HTTP %s: %s" % (status, text))
        self.status, self.text = status, text


_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _api(api):
    """-> (url, key, opener) for an API described by a dict (url, key_file, proxy, format), or for OpenRouter."""
    if not api:
        return URL, _key(), _opener
    with open(os.path.expanduser(api["key_file"]), encoding="utf-8") as f:   # a key file may hold an address line too
        key = next(t for t in f.read().split() if not t.startswith("http"))
    return api["url"], key, (_opener if api.get("proxy", True) else _direct)


def _read_stream(r):
    """An Anthropic Messages reply sent as events -> the same dict a plain reply would be. A relay
    behind a gateway that drops a silent connection after 100 seconds cannot carry a long reply any
    other way."""
    d, blocks, parts = {"type": "message", "content": [], "usage": {}}, {}, {}
    for line in r:
        line = line.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        try:
            e = json.loads(line[5:])
        except ValueError:
            continue
        t = e.get("type")
        if t == "message_start":
            m = e.get("message") or {}
            d["usage"].update(m.get("usage") or {})
            d.update({k: m[k] for k in ("id", "model", "role") if k in m})
        elif t == "content_block_start":
            blocks[e["index"]] = dict(e.get("content_block") or {})
            parts[e["index"]] = []
        elif t == "content_block_delta":
            b, x = blocks.get(e["index"], {}), e.get("delta") or {}
            if x.get("type") == "text_delta":
                b["text"] = b.get("text", "") + x.get("text", "")
            elif x.get("type") == "thinking_delta":
                b["thinking"] = b.get("thinking", "") + x.get("thinking", "")
            elif x.get("type") == "signature_delta":
                b["signature"] = b.get("signature", "") + x.get("signature", "")
            elif x.get("type") == "input_json_delta":
                parts[e["index"]].append(x.get("partial_json", ""))
        elif t == "content_block_stop":
            b = blocks.get(e["index"], {})
            if b.get("type") == "tool_use":
                b["input"] = json.loads("".join(parts[e["index"]]) or "{}")
        elif t == "message_delta":
            d["usage"].update(e.get("usage") or {})
            d.update({k: v for k, v in (e.get("delta") or {}).items() if v is not None})
        elif t == "message_stop":
            d["content"] = [blocks[i] for i in sorted(blocks)]
            return d
        elif t == "error":
            return {"error": dict(e.get("error") or {}, code=529)}
    raise ValueError("the reply stopped before its end")


def raw(body, timeout=600, retries=4, api=None):
    """POST a chat-completions body as given (tools, usage accounting) -> the response dict.

    For an agent under evaluation, which needs tool calls and the provider's own
    cost figure. A request the provider rejects (4xx other than 408, 429) is raised at once; anything
    else is retried."""
    data = json.dumps(body).encode("utf-8")
    last = LLMError(0, "not tried")
    url, key, opener = _api(api)
    native = (api or {}).get("format") == "anthropic"     # Anthropic's own Messages API
    headers = ({"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"} if native else
               {"Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "fdegym"})
    stream = native and (api or {}).get("stream")
    if stream:
        data = json.dumps(dict(body, stream=True)).encode("utf-8")
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with opener.open(req, timeout=timeout) as r:
                d = _read_stream(r) if stream else json.loads(r.read().decode("utf-8"))
            if d.get("choices") or (native and d.get("type") == "message"):
                return d
            err = d.get("error") or {}
            last = LLMError(int(err.get("code") or 0) if str(err.get("code") or "").isdigit() else 0,
                            json.dumps(d)[:600])
            if 400 <= last.status < 500 and last.status not in (408, 429):
                raise last
        except urllib.error.HTTPError as e:
            last = LLMError(e.code, e.read().decode("utf-8", "replace")[:600])
            if 400 <= e.code < 500 and e.code not in (408, 429):
                raise last
        except (urllib.error.URLError, ValueError, OSError) as e:
            last = LLMError(0, "%s: %s" % (type(e).__name__, e))
        time.sleep(3.0 * 3 ** attempt)
    raise last


def chat_json(messages, **kw):
    """chat() that parses a JSON object out of the reply; {} if unparseable."""
    text, usage = chat(messages, json_mode=True, **kw)
    try:
        return json.loads(text), usage
    except ValueError:
        s, e = text.find("{"), text.rfind("}")
        if s >= 0 and e > s:
            try:
                return json.loads(text[s:e + 1]), usage
            except ValueError:
                pass
    return {}, usage


def spend(log_path):
    if not os.path.exists(log_path):
        return {"calls": 0, "usd": 0.0}
    calls, usd = 0, 0.0
    for line in open(log_path):
        calls += 1
        usd += json.loads(line)["usd"]
    return {"calls": calls, "usd": round(usd, 5)}
