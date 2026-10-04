/**
 * In-memory filesystem for isomorphic-git.
 *
 * Based on the helper in Cloudflare's Artifacts isomorphic-git example, with
 * two changes that isomorphic-git 1.43.0 needs:
 *  - errors carry Node-style `code` values (ENOENT, EEXIST, ...). isomorphic-git
 *    branches on `err.code`; without it `exists()` rethrows.
 *  - `readlink` and `symlink` exist. isomorphic-git binds all ten fs commands
 *    up front and throws if one is missing.
 *
 * Pure module: no Cloudflare imports.
 */

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number; ino: number }
  | { kind: "file"; data: Uint8Array; mode: number; mtimeMs: number; ino: number }
  | { kind: "symlink"; target: string; mtimeMs: number; ino: number };

export interface FsError extends Error {
  code: string;
}

function fsError(code: string, syscall: string, path: string): FsError {
  const err = new Error(`${code}: ${syscall} '${path}'`) as FsError;
  err.code = code;
  return err;
}

class MemoryStats {
  readonly dev = 1;
  readonly uid = 1;
  readonly gid = 1;

  constructor(private readonly entry: Entry) {}

  get type(): "file" | "dir" | "symlink" {
    return this.entry.kind;
  }
  get size(): number {
    if (this.entry.kind === "file") return this.entry.data.byteLength;
    if (this.entry.kind === "symlink") return this.entry.target.length;
    return 0;
  }
  get ino(): number {
    return this.entry.ino;
  }
  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }
  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }
  get mode(): number {
    if (this.entry.kind === "file") return this.entry.mode;
    if (this.entry.kind === "symlink") return 0o120000;
    return 0o040000;
  }
  isFile(): boolean {
    return this.entry.kind === "file";
  }
  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }
  isSymbolicLink(): boolean {
    return this.entry.kind === "symlink";
  }
}

type ReadOptions = string | { encoding?: string } | undefined;
type WriteOptions = string | { encoding?: string; mode?: number } | undefined;

export class MemoryFS {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly entries = new Map<string, Entry>();
  private nextIno = 1;

  /** isomorphic-git uses `fs.promises` when the property is enumerable. */
  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    rm: this.rm.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  constructor() {
    this.entries.set("/", { kind: "dir", children: new Set(), mtimeMs: Date.now(), ino: this.nextIno++ });
  }

  /** Total bytes held in file contents. Used to report memory growth. */
  totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.kind === "file") total += entry.data.byteLength;
    }
    return total;
  }

  fileCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.kind === "file") count++;
    return count;
  }

  private normalize(input: string): string {
    const segments: string[] = [];
    for (const part of String(input).split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}`;
  }

  private parentOf(normalized: string): string {
    const index = normalized.lastIndexOf("/");
    return index <= 0 ? "/" : normalized.slice(0, index);
  }

  private baseOf(normalized: string): string {
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  }

  private requireParentDir(target: string, syscall: string): Extract<Entry, { kind: "dir" }> {
    const parent = this.entries.get(this.parentOf(target));
    if (!parent) throw fsError("ENOENT", syscall, target);
    if (parent.kind !== "dir") throw fsError("ENOTDIR", syscall, target);
    return parent;
  }

  async mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void> {
    const target = this.normalize(path);
    const recursive = typeof options === "object" && options !== null && options.recursive === true;
    const existing = this.entries.get(target);
    if (existing) {
      if (recursive && existing.kind === "dir") return;
      throw fsError("EEXIST", "mkdir", path);
    }
    const parentPath = this.parentOf(target);
    if (!this.entries.has(parentPath)) {
      if (!recursive) throw fsError("ENOENT", "mkdir", path);
      await this.mkdir(parentPath, { recursive: true });
    }
    const parent = this.requireParentDir(target, "mkdir");
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now(), ino: this.nextIno++ });
    parent.children.add(this.baseOf(target));
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: WriteOptions): Promise<void> {
    const target = this.normalize(path);
    const parent = this.requireParentDir(target, "open");
    const existing = this.entries.get(target);
    if (existing && existing.kind === "dir") throw fsError("EISDIR", "open", path);
    // Copy the bytes so later mutation of the caller's buffer cannot change the file.
    const bytes =
      typeof data === "string"
        ? this.encoder.encode(data)
        : data instanceof Uint8Array
          ? new Uint8Array(data)
          : new Uint8Array(data.slice(0));
    const requestedMode = typeof options === "object" && options !== null ? options.mode : undefined;
    const executable = requestedMode !== undefined ? (requestedMode & 0o111) !== 0 : existing?.kind === "file" && (existing.mode & 0o111) !== 0;
    this.entries.set(target, {
      kind: "file",
      data: bytes,
      mode: executable ? 0o100755 : 0o100644,
      mtimeMs: Date.now(),
      ino: existing?.ino ?? this.nextIno++,
    });
    parent.children.add(this.baseOf(target));
  }

  async readFile(path: string, options?: ReadOptions): Promise<Uint8Array | string> {
    const target = this.normalize(path);
    let entry = this.entries.get(target);
    if (entry?.kind === "symlink") entry = this.entries.get(this.normalize(entry.target));
    if (!entry) throw fsError("ENOENT", "open", path);
    if (entry.kind !== "file") throw fsError("EISDIR", "read", path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw fsError("ENOENT", "scandir", path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", "scandir", path);
    return [...entry.children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.entries.get(target);
    if (!entry) throw fsError("ENOENT", "unlink", path);
    if (entry.kind === "dir") throw fsError("EISDIR", "unlink", path);
    this.entries.delete(target);
    this.requireParentDir(target, "unlink").children.delete(this.baseOf(target));
  }

  // One declared parameter on purpose: isomorphic-git treats an rmdir with two
  // or more parameters as a recursive remove.
  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.entries.get(target);
    if (!entry) throw fsError("ENOENT", "rmdir", path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", "rmdir", path);
    if (entry.children.size > 0) throw fsError("ENOTEMPTY", "rmdir", path);
    if (target === "/") throw fsError("EBUSY", "rmdir", path);
    this.entries.delete(target);
    this.requireParentDir(target, "rmdir").children.delete(this.baseOf(target));
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const target = this.normalize(path);
    const entry = this.entries.get(target);
    if (!entry) {
      if (options?.force) return;
      throw fsError("ENOENT", "rm", path);
    }
    if (entry.kind !== "dir") {
      await this.unlink(target);
      return;
    }
    if (!options?.recursive) throw fsError("EISDIR", "rm", path);
    for (const child of [...entry.children]) {
      await this.rm(`${target === "/" ? "" : target}/${child}`, { recursive: true, force: true });
    }
    if (target !== "/") await this.rmdir(target);
  }

  async stat(path: string): Promise<MemoryStats> {
    const target = this.normalize(path);
    let entry = this.entries.get(target);
    if (entry?.kind === "symlink") entry = this.entries.get(this.normalize(entry.target));
    if (!entry) throw fsError("ENOENT", "stat", path);
    return new MemoryStats(entry);
  }

  async lstat(path: string): Promise<MemoryStats> {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw fsError("ENOENT", "lstat", path);
    return new MemoryStats(entry);
  }

  async readlink(path: string): Promise<string> {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw fsError("ENOENT", "readlink", path);
    if (entry.kind !== "symlink") throw fsError("EINVAL", "readlink", path);
    return entry.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const linkPath = this.normalize(path);
    const parent = this.requireParentDir(linkPath, "symlink");
    if (this.entries.has(linkPath)) throw fsError("EEXIST", "symlink", path);
    this.entries.set(linkPath, { kind: "symlink", target, mtimeMs: Date.now(), ino: this.nextIno++ });
    parent.children.add(this.baseOf(linkPath));
  }
}
