#!/usr/bin/env python3
"""Check that every case in a site's library runs from start to grade, on the site as it is deployed.

    python3 scripts/smoke_cases.py --site http://localhost:8787 --email you@example.com
    python3 scripts/smoke_cases.py --site ... --email ... campus_booking oncall_incident

For each case (all of them, or the ones named) it starts a run as that account, opens it, hands it
over untouched and waits for the grade. An untouched system is the baseline the score is measured
from, so what is checked is not the number but that grading really ran the delivered system: the
run is graded, the result says the system loaded, and no incident says the system failed to load or
to answer (a score that differs from the baseline's is pointed out). That is what goes wrong when a change to how delivered
code is started (the user it runs as, a sandbox, a new runner image) does not suit a case's grader:
the grade quietly becomes the baseline's.

The password is asked for, or read from FDEGYM_SMOKE_PASSWORD. The account needs room for the runs
(FDEGYM_MAX_OPEN_RUNS on the site); runs are handed over at once, so three at a time fit the default.
Each run spends a little of the site's model allowance where its grader calls the model. The runs are
ordinary ones: they show among that account's submissions and count in each case's acceptance rate,
so on a site people use, give this an account of its own.
"""
import argparse, getpass, json, os, sys, threading, time, urllib.error, urllib.request

# Signs that the delivered system could not be started or reached at all. An incident alone is not one:
# in some cases the system as found is unfinished and says so (a report that is "not built yet").
BROKEN = ("failed to load", "timed out", "permission denied", "permissionerror", "calledprocesserror", "no such file")


class Site:
    def __init__(self, base):
        self.base, self.cookie = base.rstrip("/"), ""

    def call(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"cookie": self.cookie, "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                for c in r.headers.get_all("set-cookie") or []:
                    self.cookie = "; ".join(x for x in (self.cookie, c.split(";")[0]) if x)
                got = json.loads(r.read() or b"{}")
                return got if isinstance(got, (dict, list)) else {}
        except urllib.error.HTTPError as e:
            try:
                return {"error": json.loads(e.read() or b"{}").get("error", str(e))}
            except ValueError:
                return {"error": str(e)}


def one(site, case, out, wait):
    t0, said = time.time(), []
    started = site.call("/api/sessions", {"caseId": case})
    if "runId" not in started:
        out[case] = ["could not start: %s" % started.get("error")]
        return
    run = started["runId"]
    view = site.call("/api/sessions/" + run)
    if not view.get("task") or not view.get("files"):
        said.append("the run opens without a brief or without files")
    handed = site.call("/api/sessions/" + run + "/submit", {})
    if handed.get("error"):
        out[case] = said + ["could not hand over: %s" % handed["error"]]
        return
    while time.time() - t0 < wait:
        view = site.call("/api/sessions/" + run)
        if view.get("status") != "grading":
            break
        time.sleep(6)
    if view.get("status") != "graded":
        out[case] = said + ["not graded: %s %s" % (view.get("status"), view.get("gradingError") or "")]
        return
    r = site.call("/api/admin/runs/" + run + "/check")
    if r.get("error"):
        out[case] = said + ["graded, but the result could not be read: %s" % r["error"]]
        return
    if r.get("service_loads") is False:
        said.append("the delivered system did not load")
    # Usually the same number. Not always: a case may declare its baseline (0, say) while the system as
    # found does a little worse than that when it is really run. Worth a look, not a failure.
    note = "" if r.get("kpi") == r.get("kpi_baseline") else "; untouched scored %s against a baseline of %s" % (r.get("kpi"), r.get("kpi_baseline"))
    for inc in r.get("incidents") or []:
        if any(b in str(inc).lower() for b in BROKEN):
            said.append("incident: %s" % str(inc).strip().splitlines()[0][:160])
    out[case] = said + ["ok  (%ds, %s%s)" % (time.time() - t0, r.get("isolation") or "no isolation recorded", note)] if not said else said


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--site", required=True)
    ap.add_argument("--email", required=True, help="an admin account on the site (the detailed result is the admin's to read)")
    ap.add_argument("--wait", type=int, default=1500, help="seconds to wait for one grade")
    ap.add_argument("cases", nargs="*")
    a = ap.parse_args()
    site = Site(a.site)
    password = os.environ.get("FDEGYM_SMOKE_PASSWORD") or getpass.getpass("password for %s: " % a.email)
    who = site.call("/api/auth/login", {"email": a.email, "password": password})
    if not who.get("user"):
        sys.exit("could not sign in: %s" % who.get("error"))
    listed = site.call("/api/cases")
    cases = a.cases or [c["id"] for c in (listed if isinstance(listed, list) else listed.get("cases", []))]
    out, bad = {}, 0
    for i in range(0, len(cases), 3):
        batch = cases[i:i + 3]
        threads = [threading.Thread(target=one, args=(site, c, out, a.wait)) for c in batch]
        [t.start() for t in threads]
        [t.join() for t in threads]
        for c in batch:
            lines = out.get(c) or ["no result"]
            bad += not lines[-1].startswith("ok")
            print("%-24s %s" % (c, ("\n" + " " * 25).join(lines)), flush=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
