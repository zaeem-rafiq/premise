// The pure git encoding of 01-core.md 3.5 and 9.5: object construction, notes, the pack and the
// pkt-line protocol of a push. Everything here is synchronous and takes and returns bytes and
// plain data; no file system, network, clock or randomness (04-build-plan.md 1.3).

export { parseRefAdvertisement, type RefAdvertisement } from "./advertisement.ts";
export { landingCommit, notesCommit, type LandingCommitInput, type NotesCommitInput } from "./commit.ts";
export { canonicalJson, noteBytes, shrinkNote, type NoteTruncated, type ShrinkResult } from "./note.ts";
export { notesTree, type NoteMapping } from "./notes-tree.ts";
export {
  isOid,
  makeBlob,
  makeCommit,
  makeObject,
  makeTree,
  ZERO_OID,
  type CommitInput,
  type GitObject,
  type GitObjectType,
  type Ident,
  type TreeEntry,
  type TreeMode,
} from "./objects.ts";
export { buildPack } from "./pack.ts";
export { FLUSH_PKT, isFlushPkt, parsePktLines, pktLine, type PktLine } from "./pkt-line.ts";
export {
  buildReceivePackRequest,
  parseReceivePackReport,
  RECEIVE_PACK_CAPABILITIES,
  type ReceivePackReport,
  type RefCommand,
  type RefResult,
} from "./receive-pack.ts";
export { makeTreeFromFiles, type FileMapValue, type FileMode, type FileSpec } from "./tree-files.ts";
