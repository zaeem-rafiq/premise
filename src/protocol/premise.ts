// Premise kinds, premise references and premise key formats.
// Source: 01-core 2.1 (paths), 2.2 (premise keys), 2.3 (entity kinds), 4.1 (`PremiseRef`).

/** A path of the pool repository (01-core 2.1). The maximum length is `MAX_PATH_LEN`. */
export const PATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** The hash value a premise or an operation's `base_oid` carries for a path that does not exist (4.4, W4). */
export const ABSENT = "absent";

export type PremiseKind = "entity" | "file" | "listing" | "query";

/** The statuses a premise takes while an attempt is in flight (7.4, TR1). */
export type PremiseStatus = "holds" | "pending_confirm" | "pending_repair" | "pending_triage";

/** What an attempt depends on (01-core 4.1). */
export type PremiseRef = {
  kind: PremiseKind;
  key: string;
  hash: string; // the head version when the premise was pinned, or `absent`
  seq: number; // the head seq when the premise was pinned
  read: boolean;
  edit: boolean;
  derived: boolean;
};

/** The entity kinds of 01-core 2.3 (`kind` of an outline row and of an entity read). */
export type EntityKind =
  "function" | "class" | "const" | "let" | "var" | "value" | "reexport" | "reexport-all" | "import" | "top";

// Key formats (01-core 2.2). Paths cannot contain `:`, so each key parses unambiguously.

/** `entity`: `<path>#<name>`, for example `world/energy.js#ENERGY_MAX`. */
export function entityKey(path: string, name: string): string {
  return `${path}#${name}`;
}

/** `file`: `<path>`. */
export function fileKey(path: string): string {
  return path;
}

/** `listing`: `<directory key>` — the directory's path followed by `/`; the repo root is `/`. */
export function listingKey(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`;
}

/** `query` (text search): `text:<scope>:<needle>`; `<scope>` is a directory key or a file path. */
export function textQueryKey(scope: string, needle: string): string {
  return `text:${scope}:${needle}`;
}

/** `query` (who references): `refs:<entity key>`. */
export function refsQueryKey(entity: string): string {
  return `refs:${entity}`;
}

/** `query` (outline): `outline:<path>`. */
export function outlineQueryKey(path: string): string {
  return `outline:${path}`;
}
