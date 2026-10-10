#!/usr/bin/env python3
"""Put case folders into cases/ on this machine.

    python3 scripts/fetch_cases.py                    the three open example cases, from Hugging Face
    python3 scripts/fetch_cases.py --from DIR         copy the cases in DIR (a downloaded copy of the full set)
    python3 scripts/fetch_cases.py --repo OWNER/NAME  another Hugging Face dataset laid out the same way

cases/ is where the harness looks when it is used from the command line, and what the site brings
into its library when it starts (the library itself is kept in the site's database and object
storage; see docs/self-hosting.md). With --from, data/ beside the cases is copied too: a few cases
read a dataset kept there.

A case that is already in cases/ is left alone unless --force is given. Standard library only.
A dataset that needs access is read with the token in HF_TOKEN.
"""
import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES = "DeepLethe/FDE-Gym-examples"
HUB = "https://huggingface.co"
NEEDED = ("engagement.json", "npcs.json", "build_world.py", "grader.py")


def fetch(url):
    """-> (body, headers). A dropped connection is tried again; the hub's own answer (404, 401) is not."""
    req = urllib.request.Request(url, headers={"User-Agent": "fde-gym-fetch"})
    if os.environ.get("HF_TOKEN"):
        req.add_header("Authorization", "Bearer " + os.environ["HF_TOKEN"])
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read(), r.headers
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                sys.exit("%s: access refused (HTTP %d). Request access on the dataset's page and set HF_TOKEN." % (url, e.code))
            if e.code < 500:
                sys.exit("%s: HTTP %d" % (url, e.code))
            err = e
        except (urllib.error.URLError, OSError) as e:
            err = e
        time.sleep(2 * (attempt + 1))
    sys.exit("%s: %s" % (url, err))


def listing(repo, path):
    """Every file under `path` of the dataset, following the hub's pages."""
    url = "%s/api/datasets/%s/tree/main/%s?recursive=true&limit=1000" % (HUB, repo, urllib.parse.quote(path))
    out = []
    while url:
        body, headers = fetch(url)
        out += [e["path"] for e in json.loads(body) if e["type"] == "file"]
        nxt = [p for p in (headers.get("Link") or "").split(",") if 'rel="next"' in p]
        url = nxt[0].split(";")[0].strip().strip("<>") if nxt else None
    return out


def from_hub(repo, dest, force):
    files = listing(repo, "cases")
    ids = sorted({f.split("/")[1] for f in files})
    if not ids:
        sys.exit("no cases/ folder in %s" % repo)
    for cid in ids:
        target = os.path.join(dest, cid)
        if os.path.isdir(target) and not force:
            print("%-28s already there" % cid)
            continue
        tmp = target + ".part"
        shutil.rmtree(tmp, ignore_errors=True)
        mine = [f for f in files if f.startswith("cases/%s/" % cid)]
        for f in mine:
            out = os.path.join(tmp, *f.split("/")[2:])
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as fh:
                fh.write(fetch("%s/datasets/%s/resolve/main/%s" % (HUB, repo, urllib.parse.quote(f)))[0])
        shutil.rmtree(target, ignore_errors=True)
        os.rename(tmp, target)
        print("%-28s %d files" % (cid, len(mine)))


def from_dir(src, dest, force):
    src = os.path.abspath(os.path.expanduser(src))
    if os.path.isdir(os.path.join(src, "cases")):
        src = os.path.join(src, "cases")
    ids = sorted(d for d in os.listdir(src) if all(os.path.exists(os.path.join(src, d, f)) for f in NEEDED))
    if not ids:
        sys.exit("no cases in %s" % src)
    for cid in ids:
        target = os.path.join(dest, cid)
        if os.path.isdir(target) and not force:
            print("%-28s already there" % cid)
            continue
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(os.path.join(src, cid), target, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
        print("%-28s copied" % cid)
    # data/ sits beside cases/ in the source, and has to sit beside it here too.
    raw = os.path.join(os.path.dirname(src), "data", "raw")
    here = os.path.join(os.path.dirname(os.path.abspath(dest)), "data", "raw")
    if os.path.isdir(raw) and (force or not os.path.isdir(here)):
        shutil.rmtree(here, ignore_errors=True)
        shutil.copytree(raw, here, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
        print("%-28s copied" % "data/raw")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="src", metavar="DIR", help="copy cases from a local folder instead of downloading")
    ap.add_argument("--repo", default=EXAMPLES, help="Hugging Face dataset to download from (default %s)" % EXAMPLES)
    ap.add_argument("--dest", default=os.environ.get("FDEGYM_ENGAGEMENTS") or os.path.join(ROOT, "cases"))
    ap.add_argument("--force", action="store_true", help="replace cases that are already there")
    a = ap.parse_args()
    os.makedirs(a.dest, exist_ok=True)
    if a.src:
        from_dir(a.src, a.dest, a.force)
    else:
        from_hub(a.repo, a.dest, a.force)
    print("cases are in %s" % a.dest)


if __name__ == "__main__":
    main()
