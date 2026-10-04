#!/usr/bin/env bash
#
# Run the spike experiments against a deployed Worker and save each JSON result.
#
#   SPIKE_KEY=<secret> ./run-spikes.sh https://artifacts-spike.<subdomain>.workers.dev
#   SPIKE_KEY=<secret> ./run-spikes.sh <base url> e3-compare-and-swap e8-raw-pack
#   SPIKE_KEY=<secret> ./run-spikes.sh <base url> cleanup
#
# With no experiment names it runs e1 to e9 in order. It does NOT run cleanup:
# the repos stay in place so they can be inspected. Run "cleanup" when done.
#
# Optional environment:
#   E5_N         number of concurrent forks for e5 (default 10, max 50)
#   E7_K         number of commit+push cycles for e7 (default 100, max 500)
#   E9_MODELS    JSON array of Workers AI model ids for e9 (default: the two built in; max 6)
#   E2_OUTSIDE_CONTROL  set to 1 (read token) or "write" to make e2 return one 60-second
#                token. outside-probe.mjs removes it from the saved file, sends the same
#                requests from this machine, then has e2 probe it from inside once more
#   RESULTS_DIR  where to write results (default: results/ next to this script)
#   MAX_TIME     per-request timeout in seconds (default 900)
#
# The key is passed to curl on stdin, so it never appears in the process list,
# and this script never prints it.

set -u
set -o pipefail

usage() {
  sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'
}

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 2
fi
if [ -z "${SPIKE_KEY:-}" ]; then
  echo "error: SPIKE_KEY is not set in the environment" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "error: curl and node are both required" >&2
  exit 2
fi

BASE="${1%/}"
shift
case "$BASE" in
  http://* | https://*) ;;
  *)
    echo "error: the first argument must be the Worker base URL (http:// or https://)" >&2
    exit 2
    ;;
esac

if [ "$#" -gt 0 ]; then
  EXPERIMENTS=("$@")
else
  EXPERIMENTS=(e1-create-push e2-minted-token e3-compare-and-swap e4-refs e5-fork e6-read-by-ref e7-soak e8-raw-pack e9-workers-ai)
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${RESULTS_DIR:-$SCRIPT_DIR/results}/$RUN_ID"
MAX_TIME="${MAX_TIME:-900}"
mkdir -p "$OUT_DIR"

# curl reads the header from a config "file" on stdin. printf is a shell builtin,
# so the key is never an argument of any process.
key_config() {
  local escaped="${SPIKE_KEY//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf 'header = "x-spike-key: %s"\n' "$escaped"
}

body_for() {
  case "$1" in
    e2-minted-token)
      case "${E2_OUTSIDE_CONTROL:-}" in
        "" | 0) printf '{}' ;;
        write) printf '{"outside_control": "write"}' ;;
        *) printf '{"outside_control": true}' ;;
      esac
      ;;
    e5-fork) printf '{"n": %s}' "${E5_N:-10}" ;;
    e7-soak) printf '{"k": %s}' "${E7_K:-100}" ;;
    e9-workers-ai)
      if [ -n "${E9_MODELS:-}" ]; then printf '{"models": %s}' "$E9_MODELS"; else printf '{}'; fi
      ;;
    *) printf '{}' ;;
  esac
}

# One line per experiment: name, ok, HTTP status, seconds, verdict or error.
summarize() {
  node -e '
    const fs = require("fs");
    const [file, id, http, rawSeconds] = process.argv.slice(1);
    const seconds = Number.isFinite(Number(rawSeconds)) ? Number(rawSeconds).toFixed(1) : rawSeconds;
    let line = id.padEnd(22) + " ";
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);
      line += "ok=" + String(r.ok).padEnd(5) + " http=" + http + " " + seconds + "s";
      if (r.error) line += " error=" + clip(String(r.error), 200);
      const verdict = r.data && r.data.verdict;
      if (verdict && Object.keys(verdict).length > 0) line += " verdict=" + clip(JSON.stringify(verdict), 600);
      process.stdout.write(line + "\n");
      process.exit(r.ok === true ? 0 : 1);
    } catch (e) {
      process.stdout.write(line + "ok=false http=" + http + " " + seconds + "s error=response is not JSON (" + e.message + ")\n");
      process.exit(1);
    }
  ' "$1" "$2" "$3" "$4"
}

echo "Worker:  $BASE"
echo "Results: $OUT_DIR"

# Check the URL and the key before running anything.
check="$(key_config | curl --silent --show-error --config - --max-time 30 --output "$OUT_DIR/_index.json" --write-out '%{http_code}' "$BASE/" 2>"$OUT_DIR/_index.stderr")"
check_exit=$?
if [ "$check_exit" -ne 0 ] || [ "$check" != "200" ]; then
  echo "error: GET $BASE/ failed (curl exit $check_exit, HTTP ${check:-none})." >&2
  echo "       401 means the key is wrong; 503 means the Worker has no SPIKE_KEY secret." >&2
  [ -s "$OUT_DIR/_index.json" ] && head -c 500 "$OUT_DIR/_index.json" >&2 && echo >&2
  [ -s "$OUT_DIR/_index.stderr" ] && head -c 500 "$OUT_DIR/_index.stderr" >&2
  exit 1
fi
[ -e "$OUT_DIR/_index.stderr" ] && rm "$OUT_DIR/_index.stderr"

failed=0
for id in "${EXPERIMENTS[@]}"; do
  out="$OUT_DIR/$id.json"
  stats="$(key_config | curl --silent --show-error --config - \
    --request POST \
    --header 'content-type: application/json' \
    --data "$(body_for "$id")" \
    --max-time "$MAX_TIME" \
    --output "$out" \
    --write-out '%{http_code} %{time_total}' \
    "$BASE/run/$id" 2>"$out.stderr")"
  curl_exit=$?
  http_code="${stats%% *}"
  seconds="${stats##* }"
  if [ "$curl_exit" -ne 0 ]; then
    # Keep a JSON file for every experiment, even when the request itself failed.
    node -e '
      const [id, code, file, errFile] = process.argv.slice(1);
      const fs = require("fs");
      const detail = fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8").trim() : "";
      const result = { experiment: id, ok: false, observations: ["curl failed before a response was saved"], timings_ms: {}, http: [], error: "curl exit " + code + (detail ? ": " + detail : "") };
      fs.writeFileSync(file, JSON.stringify(result, null, 2));
    ' "$id" "$curl_exit" "$out" "$out.stderr"
  fi
  [ -e "$out.stderr" ] && rm "$out.stderr"
  summarize "$out" "$id" "${http_code:-000}" "${seconds:-?}" || failed=$((failed + 1))
  # e2 with E2_OUTSIDE_CONTROL returned a 60-second token: repeat its requests from this
  # machine now, remove the token from the saved file, then ask the Worker (same key, from
  # the environment) to probe the token from inside again. The token is never printed.
  if [ "$id" = "e2-minted-token" ] && [ "$curl_exit" -eq 0 ]; then
    case "${E2_OUTSIDE_CONTROL:-}" in
      "" | 0) ;;
      *) node "$SCRIPT_DIR/outside-probe.mjs" "$out" "$BASE" || echo "  outside control: not completed (see the message above)" ;;
    esac
  fi
done

echo
if [ "$failed" -eq 0 ]; then
  echo "All ${#EXPERIMENTS[@]} experiments reported ok=true."
else
  echo "$failed of ${#EXPERIMENTS[@]} experiments reported ok=false. Read the observations in $OUT_DIR."
fi
case " ${EXPERIMENTS[*]} " in
  *" cleanup "*) ;;
  *) echo "The spike-* repos are still there. To delete them, run this script again with: cleanup" ;;
esac
[ "$failed" -eq 0 ]
