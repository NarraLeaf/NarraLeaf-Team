/**
 * The console's QR codes. Each pinned matrix below was decoded back to its text by a real
 * reader (CoreImage) when it was pinned, so a change to the encoder that alters a module shows here.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodeQr, qrPath } from "../web/src/qr.js";

const URI =
  "otpauth://totp/NarraLeaf%20Team%3Aada?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=NarraLeaf%20Team&algorithm=SHA1&digits=6&period=30";

function fingerprint(modules: readonly (readonly boolean[])[]): string {
  return createHash("sha256")
    .update(modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")).join("\n"))
    .digest("hex");
}

describe("QR codes", () => {
  it("draws the same modules a reader decoded", () => {
    const link = encodeQr(URI);
    expect([link.version, link.mask]).toEqual([8, 4]);
    expect(fingerprint(link.modules)).toBe("6ba1adc50a96445a26e3a7e6320e2be157b1f1f017504957c422886db72d941a");
    const hello = encodeQr("Hello, world!");
    expect([hello.version, hello.mask]).toEqual([1, 2]);
    expect(fingerprint(hello.modules)).toBe("60e12c4292e429687bcfde01ea5bbfeb22f28963c13cac92d48e3cbfe60cb21a");
  });

  it("picks the smallest version that holds the text, and refuses what none holds", () => {
    expect(encodeQr("a".repeat(14)).version).toBe(1);
    expect(encodeQr("a".repeat(15)).version).toBe(2);
    expect(encodeQr("a".repeat(2331)).version).toBe(40);
    expect(() => encodeQr("a".repeat(2332))).toThrow(RangeError);
  });

  it("puts the three finder patterns in their corners", () => {
    const { modules, size } = encodeQr(URI);
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      expect(modules[y + 3]!.slice(x, x + 7)).toEqual([true, false, true, true, true, false, true]);
      expect(modules[y]!.slice(x, x + 7).every(Boolean)).toBe(true);
    }
    expect(qrPath(encodeQr("A"))).toMatch(/^M4 4h1v1h-1z/);
  });
});
