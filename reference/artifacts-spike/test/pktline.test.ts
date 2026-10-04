/**
 * Unit tests for the pkt-line encoder, the receive-pack request body and the
 * two response parsers. Expected bytes come from the git protocol documents
 * (gitprotocol-common, gitprotocol-pack, gitprotocol-http), not from the code.
 */
import { describe, expect, it } from "vitest";
import { FLUSH_PKT, ZERO_OID, buildReceivePackRequest, concatBytes, parsePktLines, parseRefAdvertisement, parseReportStatus, pktLine } from "../src/rawgit";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("pkt-line", () => {
  it("encodes the examples from gitprotocol-common", () => {
    expect(text(pktLine("a\n"))).toBe("0006a\n");
    expect(text(pktLine("a"))).toBe("0005a");
    expect(text(pktLine("foobar\n"))).toBe("000bfoobar\n");
    expect(text(pktLine(""))).toBe("0004");
    expect(text(FLUSH_PKT)).toBe("0000");
  });

  it("counts bytes, not characters", () => {
    expect(text(pktLine("é"))).toBe("0006\xc3\xa9");
  });

  it("refuses a line longer than 65520 bytes", () => {
    expect(() => pktLine("x".repeat(65517))).toThrow(/too long/);
    expect(pktLine("x".repeat(65516)).byteLength).toBe(65520);
  });

  it("parses data, flush, delim and response-end packets", () => {
    const pkts = parsePktLines(bytes("0006a\n0000000bfoobar\n00010002"));
    expect(pkts.map((p) => p.kind)).toEqual(["data", "flush", "data", "delim", "response-end"]);
    expect(text((pkts[0] as { payload: Uint8Array }).payload)).toBe("a\n");
  });

  it("throws on malformed input instead of guessing", () => {
    expect(() => parsePktLines(bytes("zzzz"))).toThrow(/bad pkt-line length/);
    expect(() => parsePktLines(bytes("0010abc"))).toThrow(/truncated/);
    expect(() => parsePktLines(bytes("0003"))).toThrow(/invalid pkt-line length 3/);
  });
});

describe("receive-pack request body", () => {
  const pack = bytes("PACK-bytes-go-here");

  it("single command: capabilities after NUL on the first line, then flush, then the pack", () => {
    const body = buildReceivePackRequest([{ oldOid: A, newOid: B, ref: "refs/heads/main" }], ["report-status", "side-band-64k"], pack);
    const line = `${A} ${B} refs/heads/main\0 report-status side-band-64k`;
    const expected = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000PACK-bytes-go-here`;
    expect(text(body)).toBe(expected);
  });

  it("two commands: only the first carries capabilities", () => {
    const body = buildReceivePackRequest(
      [
        { oldOid: A, newOid: B, ref: "refs/heads/main" },
        { oldOid: ZERO_OID, newOid: C, ref: "refs/notes/premise" },
      ],
      ["report-status"],
      pack,
    );
    const first = `${A} ${B} refs/heads/main\0 report-status`;
    const second = `${ZERO_OID} ${C} refs/notes/premise`;
    // 40 + 1 + 40 + 1 + 18 = 100 characters, plus the 4-byte length = 0x68.
    expect(second.length + 4).toBe(0x68);
    expect(text(body)).toBe(`${(first.length + 4).toString(16).padStart(4, "0")}${first}0068${second}0000PACK-bytes-go-here`);
    const pkts = parsePktLines(body.subarray(0, body.length - pack.length));
    expect(pkts.map((p) => p.kind)).toEqual(["data", "data", "flush"]);
  });

  it("can end commands with LF, as isomorphic-git does", () => {
    const body = buildReceivePackRequest([{ oldOid: A, newOid: B, ref: "refs/heads/main" }], ["report-status"], pack, { trailingNewline: true });
    expect(text(body)).toContain("refs/heads/main\0 report-status\n0000PACK");
  });

  it("omits the pack when every command is a delete, and requires it otherwise", () => {
    const del = buildReceivePackRequest([{ oldOid: A, newOid: ZERO_OID, ref: "refs/heads/gone" }], ["report-status"]);
    expect(text(del).endsWith("0000")).toBe(true);
    expect(text(del)).not.toContain("PACK");
    expect(() => buildReceivePackRequest([{ oldOid: A, newOid: B, ref: "refs/heads/main" }], ["report-status"])).toThrow(/pack is required/);
  });

  it("rejects malformed commands", () => {
    expect(() => buildReceivePackRequest([], [], pack)).toThrow(/at least one/);
    expect(() => buildReceivePackRequest([{ oldOid: "abc", newOid: B, ref: "refs/heads/main" }], [], pack)).toThrow(/invalid oid/);
    expect(() => buildReceivePackRequest([{ oldOid: A, newOid: B, ref: "main" }], [], pack)).toThrow(/invalid ref name/);
    expect(() => buildReceivePackRequest([{ oldOid: A, newOid: B, ref: "refs/heads/a b" }], [], pack)).toThrow(/invalid ref name/);
  });
});

describe("ref advertisement parser", () => {
  it("parses a smart-HTTP receive-pack advertisement", () => {
    const body = concatBytes([
      pktLine("# service=git-receive-pack\n"),
      FLUSH_PKT,
      pktLine(`${A} refs/heads/main\0report-status delete-refs side-band-64k atomic agent=git/2.50.1\n`),
      pktLine(`${B} refs/notes/premise\n`),
      FLUSH_PKT,
    ]);
    const adv = parseRefAdvertisement(body);
    expect(adv.service).toBe("git-receive-pack");
    expect(adv.emptyRepo).toBe(false);
    expect(adv.refs).toEqual({ "refs/heads/main": A, "refs/notes/premise": B });
    expect(adv.capabilities).toEqual(["report-status", "delete-refs", "side-band-64k", "atomic", "agent=git/2.50.1"]);
  });

  it("parses an empty repository (capabilities^{} placeholder)", () => {
    const body = concatBytes([pktLine("# service=git-receive-pack\n"), FLUSH_PKT, pktLine(`${ZERO_OID} capabilities^{}\0report-status delete-refs\n`), FLUSH_PKT]);
    const adv = parseRefAdvertisement(body);
    expect(adv.emptyRepo).toBe(true);
    expect(adv.refs).toEqual({});
    expect(adv.capabilities).toEqual(["report-status", "delete-refs"]);
  });

  it("keeps .have lines and peeled tag lines out of the ref list", () => {
    // Shape from gitprotocol-pack: ".have" marks objects from alternates, "^{}" the commit an annotated tag points at.
    const body = concatBytes([
      pktLine("# service=git-receive-pack\n"),
      FLUSH_PKT,
      pktLine(`${A} refs/heads/main\0report-status delete-refs\n`),
      pktLine(`${B} .have\n`),
      pktLine(`${C} refs/tags/v1\n`),
      pktLine(`${B} refs/tags/v1^{}\n`),
      FLUSH_PKT,
    ]);
    const adv = parseRefAdvertisement(body);
    expect(adv.refs).toEqual({ "refs/heads/main": A, "refs/tags/v1": C });
    expect(adv.haves).toEqual([B]);
    expect(adv.peeled).toEqual({ "refs/tags/v1": B });
    expect(adv.capabilities).toEqual(["report-status", "delete-refs"]);
  });

  it("accepts the \"version 1\" line a server sends when asked for protocol v1", () => {
    const body = concatBytes([pktLine("# service=git-upload-pack\n"), FLUSH_PKT, pktLine("version 1\n"), pktLine(`${A} HEAD\0multi_ack side-band-64k\n`), pktLine(`${A} refs/heads/main\n`), FLUSH_PKT]);
    const adv = parseRefAdvertisement(body);
    expect(adv.refs).toEqual({ HEAD: A, "refs/heads/main": A });
    expect(adv.capabilities).toEqual(["multi_ack", "side-band-64k"]);
  });

  it("refuses a protocol v2 advertisement", () => {
    const body = concatBytes([pktLine("# service=git-upload-pack\n"), FLUSH_PKT, pktLine("version 2\n"), FLUSH_PKT]);
    expect(() => parseRefAdvertisement(body)).toThrow(/protocol v1 only/);
  });
});

describe("report-status parser", () => {
  it("parses a plain (no side-band) report", () => {
    const body = concatBytes([pktLine("unpack ok\n"), pktLine("ok refs/heads/main\n"), pktLine("ng refs/notes/premise failed to update ref\n"), FLUSH_PKT]);
    const report = parseReportStatus(body);
    expect(report.sideband).toBe(false);
    expect(report.unpackOk).toBe(true);
    expect(report.refs).toEqual([
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/notes/premise", ok: false, message: "failed to update ref" },
    ]);
  });

  it("parses a side-band-64k report with progress and error channels", () => {
    const inner = concatBytes([pktLine("unpack ok\n"), pktLine("ok refs/heads/main\n"), FLUSH_PKT]);
    const band = (n: number, payload: Uint8Array) => pktLine(concatBytes([Uint8Array.of(n), payload]));
    // The inner report is split across two band-1 packets on purpose.
    const body = concatBytes([band(2, bytes("remote: hello\n")), band(1, inner.subarray(0, 7)), band(1, inner.subarray(7)), band(3, bytes("fatal-ish message\n")), FLUSH_PKT]);
    const report = parseReportStatus(body);
    expect(report.sideband).toBe(true);
    expect(report.unpack).toBe("ok");
    expect(report.refs).toEqual([{ ref: "refs/heads/main", ok: true }]);
    expect(report.progress).toBe("remote: hello\n");
    expect(report.errors).toBe("fatal-ish message\n");
  });

  it("reports an unpack failure", () => {
    const report = parseReportStatus(concatBytes([pktLine("unpack index-pack abnormal exit\n"), pktLine("ng refs/heads/main unpacker error\n"), FLUSH_PKT]));
    expect(report.unpackOk).toBe(false);
    expect(report.unpack).toBe("index-pack abnormal exit");
    expect(report.refs).toEqual([{ ref: "refs/heads/main", ok: false, message: "unpacker error" }]);
  });

  it("returns no unpack line for an empty body", () => {
    const report = parseReportStatus(new Uint8Array());
    expect(report.unpack).toBeNull();
    expect(report.refs).toEqual([]);
  });
});
