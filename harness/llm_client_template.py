"""Client for the company LLM gateway. Copied into each workspace's system/.

    from llm_client import chat
    text = chat([{"role": "user", "content": "..."}], max_tokens=300)

One fixed model sits behind the gateway. Usage is metered: check `budget()`.
The endpoint is read from config/llm.json next to this file; production points
that file at the production gateway, so do not hard-code the URL anywhere else.
"""
import json
import os
import urllib.error
import urllib.request

_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "llm.json")


def _url():
    with open(_CFG) as f:
        return json.load(f)["url"]


class LLMError(RuntimeError):
    pass


def chat(messages, max_tokens=400, temperature=0.0, json_mode=False, timeout=120):
    body = json.dumps({"messages": messages, "max_tokens": max_tokens,
                       "temperature": temperature, "json_mode": json_mode}).encode("utf-8")
    req = urllib.request.Request(_url(), data=body, headers={"Content-Type": "application/json"})
    try:
        # The gateway is local: bypass any system proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise LLMError("gateway %d: %s" % (e.code, e.read().decode("utf-8", "replace")[:200]))
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise LLMError("gateway unreachable: %s" % e)
    if "error" in d:
        raise LLMError(d["error"])
    return d["text"]


def budget():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(_url(), timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))
