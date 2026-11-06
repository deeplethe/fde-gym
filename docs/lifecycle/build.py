"""Regenerate the presentation data from committed evidence; never executes a probe."""
import json
from pathlib import Path
import sys
root = Path(__file__).resolve().parent
payload = {key: json.loads((root.parent / "evaluation" / filename).read_text()) for key, filename in (("original", "2026-10-17-process-lifetime.json"), ("dev", "2026-10-17-process-lifetime-dev.json"))}
text = "window.LIFECYCLE_EVIDENCE=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
target = root / "evidence.js"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != text:
        raise SystemExit("Evidence projection differs; run python3 docs/lifecycle/build.py")
    print("Evidence projection matches both committed records")
else:
    target.write_text(text)
    print("Generated evidence.js from existing records only")
