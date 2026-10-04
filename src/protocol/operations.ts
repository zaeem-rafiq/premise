// The operation union of 01-core 5.1 — every change an attempt makes, before it lands.

import type { EntityKind } from "./premise.ts";

/** One file's entry in an operation (5.1). */
export type OperationFile = {
  path: string;
  oid: string;
  base_oid: string; // `absent` when the operation creates the file
};

/** One entity's entry in an operation (5.1). `key` is the premise key `<path>#<name>`. */
export type OperationEntity = {
  key: string;
  kind: EntityKind;
  before: string | null;
  after: string | null;
};

export type Operation =
  | { kind: "create_file"; path: string; after: string; op_seq: number }
  | { kind: "delete_file"; path: string; base_oid: string; op_seq: number }
  | {
      kind: "edit_file";
      path: string;
      op_seq: number;
      base_oid: string;
      after_oid: string;
      files: OperationFile[];
      entities: OperationEntity[];
    }
  | {
      kind: "create_entities";
      path: string;
      op_seq: number;
      files: OperationFile[];
      entities: OperationEntity[];
    }
  | {
      kind: "edit_entities";
      path: string;
      op_seq: number;
      files: OperationFile[];
      entities: OperationEntity[];
    }
  | {
      kind: "delete_entities";
      path: string;
      op_seq: number;
      files: OperationFile[];
      entities: OperationEntity[];
    };

/** Operation kinds, in the order 01-core 5.1 lists them. */
export const OPERATION_KINDS = [
  "create_file",
  "delete_file",
  "edit_file",
  "create_entities",
  "edit_entities",
  "delete_entities",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
