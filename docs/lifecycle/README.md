# FDE Lifecycle presentation

Native static contribution page selected from Design Studio A. No upstream service changes or experiments.

Regenerate the recorded evidence projection: `python3 docs/lifecycle/build.py`; verify with `--check`.
Preview from repository root: `python3 -m http.server 19306 --bind 127.0.0.1`, then open `/docs/lifecycle/`.

Public contribution page: <https://mandu5.github.io/fde-gym/docs/lifecycle/>.
The `gh-pages` branch in `mandu5/fde-gym` contains only the static page, committed
evaluation records, process-lifetime documentation and license. Its `release.json`
pins the source commit on `fix/delivered-process-lifetime-dev`. The repository
root redirects to `/docs/lifecycle/`; the upstream product site is unchanged.

The two committed October 17 comparisons remain separate (26 versus 15 later scenarios). The diagram is schematic, not a timestamp trace. Source links pin contribution commit ea68c1d1a37a3898bf47079d125d4e5b7e144be0. Fonts retain SIL OFL notices, and design reference provenance is preserved alongside this page.
