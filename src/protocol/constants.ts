// Every platform constant. This module imports nothing: `src/host/**` and every other part of the system
// may read it.
// Sources: 01-core Appendix C (with DEFAULT_GLOBALS of 10.1), 02-tidepool Appendix B, 03-floor Appendix A,
// and the rows of 05-agent Appendix A that name one constant each (AGENT_SPEC and GUIDE_PATH live in
// agent-prompt.ts; the rows answered by the model plan live in src/config/model-plan.ts).

// ---- 01-core Appendix C ----

export const TICK_MS = 250;
export const MAX_BATCH = 64;
export const MAX_PACK_BYTES = 8 * 1024 * 1024;
export const MAX_PATH_LEN = 120;
export const MAX_FILE_BYTES = 32_768;
/** `06-repos.md` IR4: an imported repository larger than this is refused. */
export const IMPORT_MAX_ENTRIES = 5_000;
/** `06-repos.md` IR4: the bytes of the blobs of at most MAX_FILE_BYTES that an imported pool stores. */
export const IMPORT_MAX_TEXT_BYTES = 24_000_000;
export const MAX_POOL_FILES = 2_000;
export const MAX_POOL_BYTES = 8 * 1024 * 1024;
export const MAX_QUERY_LEN = 128;
export const MAX_SEARCH_LINES = 50;
export const MAX_LIST_ENTRIES = 500;
export const MAX_OPS = 128;
export const MAX_PATHS = 64;
export const MAX_CHANGE_BYTES = 98_304;
export const MAX_PREMISES = 256;
export const MAX_STATEMENT_CHARS = 500;
export const MAX_INTENT_CHARS = 500;
export const NOTE_MAX_BYTES = 262_144;
export const NOTE_RESERVE_BYTES = 16_384;
export const HEADS_UP_MAX_BYTES = 262_144;
export const MAX_HEADS_UPS_PER_RESPONSE = 8;
export const RESPONSE_HEADS_UP_MAX_BYTES = 524_288;
export const REEXPORT_DEPTH = 8;

export const TOOL_TIMEOUT_MS = 10_000;
export const MODEL_TIMEOUT_MS = 60_000;
export const MODEL_RETRIES = 2;
export const AGENT_WATCHDOG_MS = 30_000;
export const MAX_STEPS = 40;
export const MAX_MODEL_CALLS = 30;
export const MAX_ATTEMPT_TOKENS = 400_000;
export const MAX_ATTEMPT_USD = 1;
export const RESUME_STEPS = 15;
export const RESUME_MODEL_CALLS = 12;
export const RESUME_TIMEOUT_MS = 300_000;
export const MAX_REVISIONS = 3;
export const RESUME_ACK_TIMEOUT_MS = 30_000;
export const RESERVATION_MARGIN_MS = 10_000;
export const REGISTER_TIMEOUT_MS = 30_000;
export const ATTEMPT_TIMEOUT_MS = 600_000;

export const GO_AROUND_LIMIT = 3;
export const STARVATION_AFTER = 2;
export const RIGHT_OF_WAY_MS = 120_000;
export const HEADS_UP_REPUSH_MS = 5_000;

export const T_REPAIR = 0.7;
export const T_CONFIRM = 0.2;
export const T_INTENT_MIN = 0.5;
export const T_UNRELATED_MAX = 0.5;
export const T_SHARED_MAX = 0.5;
export const T_CONTRADICT = 0.8;

export const CLEF_TIMEOUT_MS = 2_000;
export const CLEF_STATE_MAX_CHARS = 60_000;
export const CLEF_MAX_QUESTIONS = 64;
export const CLEF_INPUT_TOKEN_LIMIT = 60_000;

// The switches (01-core Appendix C): `"off"` or the Clef model id.
export const CLEF_TRIAGE = "off";
export const CLEF_RISK = "off";
export const CLEF_CONTRADICTION = "off";
export const CLEF_TRIAGE_MODEL_ID = "@cf/cloudflare/clef";
export const CLEF_TRIAGE_MODEL = "clef";
export const CLEF_RISK_MODEL_ID = "@cf/cloudflare/clef";
export const CLEF_RISK_MODEL = "clef";

/** The allow list of PO4 (01-core 10.1): used when the pool's policy file carries no `globals`. */
export const DEFAULT_GLOBALS: readonly string[] = [
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "Map",
  "Set",
  "Infinity",
  "NaN",
  "undefined",
  "isFinite",
  "isNaN",
  "parseInt",
  "parseFloat",
];

export const PUSH_BACKOFF_BASE_MS = 250;
export const PUSH_BACKOFF_MAX_MS = 30_000;
export const PUSH_STALL_MS = 5_000;
export const PUSH_TIMEOUT_MS = 20_000;
export const PUSH_REJECT_LIMIT = 5;
export const TICK_CPU_BUDGET_MS = 100;
export const REBUILD_CALLS_PER_RUN = 200;
export const UNDO_WINDOW = 200;
export const RACE_SIZE = 3;
export const GREEN_MIN_INTERVAL_MS = 2_000;
export const GREEN_TIMEOUT_MS = 60_000;
export const GREEN_LOG_MAX_CHARS = 4_000;
export const GREEN_CPU_MS = 5_000;
export const MAX_FORKS_IN_FLIGHT = 4;
export const FORK_RETRIES = 3;
export const FORK_BACKOFF_BASE_MS = 2_000;
export const PREVIEW_REF_PREFIX = "refs/previews/";

export const METRICS_WINDOW_MS = 10_000;
export const METRICS_EVERY_MS = 1_000;
export const LIMITS_EVERY_MS = 1_000;
export const FLOOR_KEEP_LANDINGS = 200;
export const FALSE_ABORT_TARGET = 0.05;
export const ESCAPE_TARGET = 0;
export const SPEND_CAP_USD = 40;

/** MAX_REAL_AGENTS (the value "from S5", settled in 05-agent MG2): the starting per-minute of `max_real_agents`. */
export const MAX_REAL_AGENTS = 6;

export const PUBLIC_RATE_PER_MIN = 120;
export const APP_FILE_RATE_PER_MIN = 1_200;
export const MAX_SOCKETS_PER_ADDR = 8;
export const UNLOCK_FAILS_PER_MIN = 10;
export const READ_TOKEN_TTL_S = 3_600;
export const SESSION_TTL_S = 43_200;

// ---- 02-tidepool Appendix B ----
// (APP_FILE_RATE_PER_MIN is above: both appendices name it once.)

export const HOST_SEED = 7;
export const HOST_MAX_CATCH_UP = 5;
export const HOST_MAX_REACH = 200;
export const HOST_MAX_OPS = 256;
export const STATS_EVERY_MS = 1_000;
export const HEAD_POLL_MS = 5_000;
export const SWAP_MIN_MS = 500;
export const MAX_ADOPTS = 100;
export const POOL_STALL_MS = 5_000;
export const MAX_KINDS = 64;
export const HIGHLIGHT_RADIUS = 34;
export const HIGHLIGHT_WIDTH = 3;
export const HIGHLIGHT_COLOUR = "#ffd23f";
export const SELFTEST_TIMEOUT_MS = 10_000;

// ---- 03-floor Appendix A ----

export const LIGHTS_MAX = 14;
export const AUTO_EXPAND_MAX = 2;
export const CHANGE_NAME_CHARS = 28;
export const QUIET_NOTICE_MS = 10_000;
export const SLOW_NOTICE_MS = 30_000;
export const SENT_WAIT_MS = 5_000;
export const FRAME_LOAD_TIMEOUT_MS = 8_000;
export const FRAME_ADVANCE_DEBOUNCE_MS = 150;
export const FRAME_PROBE_RETRY_MS = 1_000;
export const FRAME_ADVANCE_TIMEOUT_MS = 1_000;
export const STALE_CARD_MS = 6_000;
export const TOAST_MS = 6_000;
export const SPEND_NEAR_SHARE = 0.8;
export const OFFLINE_AFTER_MS = 3_000;
export const STREAM_SILENCE_MS = 5_000;
export const WS_RETRY_BASE_MS = 500;
export const WS_RETRY_MAX_MS = 8_000;
export const WALL_FPS = 10;
export const REPLAY_SPEEDS: readonly number[] = [0.5, 1, 2, 4, 8];
export const REPLAY_MAX_GAP_MS = 2_000;
export const REPLAY_MAX_BYTES = 25 * 1024 * 1024;
export const REPLAY_SEEK_BUDGET_MS = 500;
export const CHAPTER_LEAD_MS = 3_000;

// ---- 05-agent Appendix A (single-constant rows) ----

export const MODEL_MAX_TOKENS = 4_096;
export const MAX_TOOL_CALLS_PER_TURN = 8;
export const MAX_NUDGES = 2;
export const TOOL_RETRIES = 2;
export const MODEL_RETRY_BACKOFF_MS = 1_000;
export const WAIT_BACKOFF_BASE_MS = 2_000;
export const WAIT_BACKOFF_MAX_MS = 30_000;
export const CONTEXT_TARGET_CHARS = 48_000;
export const CONTEXT_HARD_CHARS = 200_000;
export const CONTEXT_KEEP_TURNS = 3;
