/**
 * The languages: which one a request gets, and whether each of them answers.
 *
 * Two kinds of test here, and the second is the one that will fail one day. The
 * first is about negotiation, which is a header format with rules worth
 * pinning. The second walks every catalogue against English and calls every
 * sentence in it, because the type checker can promise that a message exists
 * and cannot promise that it says anything — an empty string, a sentence that
 * dropped the name it was given, a duration that came back without its number
 * are all things that compile.
 */
import { describe, expect, it } from "vitest";

import { readDuration } from "../src/operations.js";
import { describeDuration } from "../src/duration.js";
import { en, everyLanguage, ja, messagesFor, zh } from "../src/i18n/index.js";
import { FALLBACK_LOCALE, localeOfTag, negotiateLocale } from "../src/i18n/locales.js";
import { relativeTime } from "../src/tui/format.js";

import type { Messages } from "../src/i18n/messages.js";

describe("negotiating a language", () => {
  it("takes the highest quality this interface has", () => {
    expect(negotiateLocale("ja;q=0.5, zh;q=0.9, en;q=0.1")).toBe("zh");
    expect(negotiateLocale("fr, ja;q=0.8")).toBe("ja");
  });

  it("leaves the first of an equal pair in front, which is the browser's own order", () => {
    expect(negotiateLocale("ja, zh")).toBe("ja");
    expect(negotiateLocale("zh, ja")).toBe("zh");
    expect(negotiateLocale("ja;q=0.8, zh;q=0.8")).toBe("ja");
  });

  it("reads a region and a script as the language they are", () => {
    expect(localeOfTag("zh-Hans-CN")).toBe("zh");
    expect(localeOfTag("ZH-TW")).toBe("zh");
    expect(negotiateLocale("ja-JP")).toBe("ja");
  });

  it("drops a language the browser said it does not want", () => {
    // q=0 is not "rank this last", it is "not this one".
    expect(negotiateLocale("zh;q=0, ja;q=0.1")).toBe("ja");
    expect(negotiateLocale("zh;q=0")).toBe(FALLBACK_LOCALE);
  });

  it("falls back to English rather than refusing", () => {
    // Every one of these is a real header or a real absence of one, and none of
    // them is a reason to serve a page nobody can read.
    expect(negotiateLocale(undefined)).toBe("en");
    expect(negotiateLocale("")).toBe("en");
    expect(negotiateLocale("de, fr, it")).toBe("en");
    expect(negotiateLocale("zh;q=high")).toBe("zh");
    expect(negotiateLocale("*")).toBe("en");
  });

  it("answers with the language a locale names, and English for one it does not", () => {
    expect(messagesFor("ja")).toBe(ja);
    expect(messagesFor(undefined)).toBe(en);
  });
});

/**
 * Every leaf of a catalogue, by the path it sits at.
 *
 * A function is called rather than skipped: what is being asked is whether this
 * language has a sentence, and a function that returns "" has none.
 */
function leaves(messages: Messages): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      found.set(path, value);
      return;
    }
    if (typeof value === "function") {
      found.set(path, callWithSamples(value as (...args: never[]) => string));
      return;
    }
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      return;
    }
    for (const [key, next] of Object.entries(value)) {
      walk(next, path === "" ? key : `${path}.${key}`);
    }
  };
  walk(messages, "");
  return found;
}

/** The one sample every message here happens to take, plus the duration pair. */
function callWithSamples(message: (...args: never[]) => string): string {
  const fields = {
    code: "CODE",
    role: "member",
    lifetime: "7 days",
    kid: "0001",
    published: 2,
    username: "ada",
    label: "sign-in token",
    value: "30 days",
    project: "winterlight",
    owner: "ada",
    level: "write",
    group: "admin",
    status: 503,
    directory: "/srv/team/keys",
    minimum: "60",
    maximum: "31536000",
    detail: "refused",
    revisions: "12",
    seconds: 30,
    minutes: 5,
    hours: 2,
    days: 3,
  };
  // Two shapes reach here: everything takes one object, and `duration` takes an
  // amount and a unit. Trying both is cheaper than describing which is which.
  const asObject = (message as (fields: unknown) => string)(fields);
  if (asObject.includes("undefined") || asObject.includes("[object")) {
    return (message as (amount: number, unit: string) => string)(30, "day");
  }
  return asObject;
}

describe("every language answers", () => {
  const english = leaves(en);

  it("found the messages at all", () => {
    // Without this, a walk that stopped finding anything would turn every
    // comparison below into a loop over nothing, and the suite would go green
    // on a catalogue nobody checked.
    expect(english.size).toBeGreaterThan(120);
  });

  for (const language of everyLanguage()) {
    describe(language.name, () => {
      const theirs = leaves(language);

      it("says something wherever English says something", () => {
        for (const path of english.keys()) {
          expect(theirs.has(path), `${language.locale} is missing ${path}`).toBe(true);
          expect(theirs.get(path)?.trim(), `${language.locale} says nothing at ${path}`)
            .not.toBe("");
        }
      });

      it("has nothing English does not", () => {
        // A path only one catalogue has is a message that was renamed in one
        // place, which the type checker catches at the interface but not inside
        // the two records that are keyed by what the server sends.
        for (const path of theirs.keys()) {
          expect(english.has(path), `${language.locale} has a stray ${path}`).toBe(true);
        }
      });

      it("keeps the names it is handed", () => {
        // The failure this catches is a translated sentence that reads well and
        // dropped the username out of the middle of it.
        expect(language.action.userDisabled({ username: "ada" })).toContain("ada");
        // A key id is data, and stays as the database has it in every language.
        expect(language.action.keyRotated({ kid: "abc123", published: 2 })).toContain("abc123");
        expect(language.error.unknownUser({ username: "ada" })).toContain("ada");
      });
    });
  }
});

describe("durations, written and read back", () => {
  it("writes one in the language it is being read in", () => {
    expect(describeDuration(30 * 24 * 60 * 60)).toBe("30 days");
    expect(describeDuration(30 * 24 * 60 * 60, zh)).toBe("30 天");
    expect(describeDuration(30 * 24 * 60 * 60, ja)).toBe("30日");
    expect(describeDuration(60 * 60, en)).toBe("1 hour");
    expect(describeDuration(15 * 60, ja)).toBe("15分");
  });

  it("takes back exactly what it wrote, in every language", () => {
    // The whole point of the editor opening on the words a person is reading.
    for (const language of everyLanguage()) {
      for (const seconds of [15 * 60, 60 * 60, 7 * 24 * 60 * 60, 30 * 24 * 60 * 60]) {
        expect(
          readDuration(describeDuration(seconds, language), language),
          `${language.locale} could not read back ${describeDuration(seconds, language)}`,
        ).toBe(seconds);
      }
    }
  });

  it("takes the command line's spelling and English whatever the language", () => {
    // Somebody who knows `7d` should not have to discover a second spelling,
    // and somebody reading the Chinese page may still have been told "30 days".
    expect(readDuration("7d", zh)).toBe(7 * 24 * 60 * 60);
    expect(readDuration("30 days", ja)).toBe(30 * 24 * 60 * 60);
    expect(readDuration("90", zh)).toBe(90);
  });

  it("says what is wrong in the language it was asked in", () => {
    const refused = readDuration("いつか", ja);
    expect(typeof refused).toBe("string");
    expect(refused).toBe(ja.error.notADuration({ value: "いつか" }));
    expect(readDuration("0 天", zh)).toBe(zh.error.durationTooSmall);
  });
});

describe("relative times", () => {
  const now = 1_700_000_000_000;

  it("counts in the words of the language it is drawn in", () => {
    expect(relativeTime(now - 5_000, now)).toBe("5s ago");
    expect(relativeTime(now - 5_000, now, zh)).toBe("5 秒前");
    expect(relativeTime(now - 2 * 60 * 60 * 1000, now, ja)).toBe("2時間前");
    expect(relativeTime(now - 3 * 24 * 60 * 60 * 1000, now, zh)).toBe("3 天前");
    expect(relativeTime(now, now, ja)).toBe("たった今");
  });

  it("says unknown in that language too, rather than leaving a gap", () => {
    expect(relativeTime(undefined, now, zh)).toBe("未知");
    expect(relativeTime(undefined, now, ja)).toBe("不明");
    expect(relativeTime(undefined, now)).toBe("unknown");
  });
});
