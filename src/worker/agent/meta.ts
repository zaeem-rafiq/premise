import type { Sql } from "../../protocol/ports.ts";
import { metaGet, metaSet as storeMetaSet } from "../../core/agent/store.ts";

/** Compare inside the caller's transaction; a rollback leaves no cached value to invalidate. */
export function metaSet(sql: Sql, key: string, value: string | number): void {
  const stored = String(value);
  if (metaGet(sql, key) !== stored) storeMetaSet(sql, key, stored);
}
