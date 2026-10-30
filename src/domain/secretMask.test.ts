import { describe, expect, it } from "vitest";

import { createSecretMasker, createStreamingMasker } from "./secretMask";

const KEY = "sk-test-groq-0001";
const LABEL = "Groq main";
const REDACTED = "[redacted:Groq main]";

describe("secret masker", () => {
  it("replaces_every_occurrence_with_the_label", () => {
    const masker = createSecretMasker([{ value: KEY, label: LABEL }]);

    expect(masker.mask(`a ${KEY} b ${KEY}`)).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
  });

  it("ignores_values_shorter_than_eight_characters", () => {
    const masker = createSecretMasker([
      { value: "abcdefg", label: "short" },
      { value: "abcdefgh", label: "edge" },
    ]);

    expect(masker.mask("abcdefg abcdefgh")).toBe("abcdefg [redacted:edge]");
  });

  it("masks_the_longest_value_first_when_keys_overlap", () => {
    const masker = createSecretMasker([
      { value: KEY, label: "short" },
      { value: `${KEY}-extended`, label: "long" },
    ]);

    expect(masker.mask(`x ${KEY}-extended y ${KEY}`)).toBe(
      "x [redacted:long] y [redacted:short]",
    );
  });

  it("treats_label_text_literally", () => {
    const masker = createSecretMasker([{ value: KEY, label: "a$&b$1" }]);

    expect(masker.mask(KEY)).toBe("[redacted:a$&b$1]");
  });

  it("returns_text_unchanged_without_secrets", () => {
    expect(createSecretMasker([]).mask("nothing to hide")).toBe(
      "nothing to hide",
    );
  });

  it("reports_the_longest_usable_value_length", () => {
    const masker = createSecretMasker([
      { value: KEY, label: "a" },
      { value: "tiny", label: "b" },
      { value: `${KEY}-extended`, label: "c" },
    ]);

    expect(masker.maxLength).toBe(26);
    expect(createSecretMasker([{ value: "tiny", label: "b" }]).maxLength).toBe(
      0,
    );
  });
});

describe("secret masker deep masking", () => {
  it("maskDeep_masks_strings_inside_nested_arrays_and_objects", () => {
    const masker = createSecretMasker([{ value: KEY, label: LABEL }]);
    const when = new Date(0);
    const input = {
      command: `curl ${KEY}`,
      nested: [{ token: KEY, count: 3 }, [`${KEY}!`, null, true]],
      missing: undefined,
      when,
    };

    const masked = masker.maskDeep(input);

    expect(masked).toEqual({
      command: `curl ${REDACTED}`,
      nested: [{ token: REDACTED, count: 3 }, [`${REDACTED}!`, null, true]],
      missing: undefined,
      when,
    });
    expect(masked.when).toBe(when);
    expect(input.command).toBe(`curl ${KEY}`);
  });

  it("maskDeep_returns_non_container_values_unchanged", () => {
    const masker = createSecretMasker([{ value: KEY, label: LABEL }]);

    expect(masker.maskDeep(42)).toBe(42);
    expect(masker.maskDeep(null)).toBeNull();
    expect(masker.maskDeep(KEY)).toBe(REDACTED);
  });
});

describe("streaming masker", () => {
  const masker = createSecretMasker([{ value: KEY, label: LABEL }]);
  const text = `before ${KEY} after`;
  const expected = `before ${REDACTED} after`;

  it.each(Array.from({ length: text.length - 1 }, (_, index) => index + 1))(
    "masks_a_key_split_at_position_%i",
    (position) => {
      const streaming = createStreamingMasker(() => masker);

      const emitted = [
        streaming.push("m1", text.slice(0, position)),
        streaming.push("m1", text.slice(position)),
      ];
      const tail = streaming.flush("m1");

      expect(emitted.join("")).not.toContain("sk-");
      expect(emitted.join("") + tail).toBe(expected);
    },
  );
});

describe("streaming masker streams", () => {
  const masker = createSecretMasker([{ value: KEY, label: LABEL }]);

  it("holds_back_the_trailing_characters_a_key_could_start_in", () => {
    const streaming = createStreamingMasker(() => masker);

    const emitted = streaming.push("m1", "0123456789abcdef-0123456789");

    expect(emitted).toBe("0123456789a");
    expect(streaming.flush("m1")).toBe("bcdef-0123456789");
  });

  it("emits_everything_at_once_when_there_are_no_secrets", () => {
    const streaming = createStreamingMasker(() => createSecretMasker([]));

    expect(streaming.push("m1", "plain text")).toBe("plain text");
    expect(streaming.flush("m1")).toBe("");
  });

  it("keeps_streams_with_different_keys_apart", () => {
    const streaming = createStreamingMasker(() => masker);

    streaming.push("a", `A says ${KEY.slice(0, 8)}`);
    streaming.push("b", `B says ${KEY.slice(8)}`);

    expect(streaming.flush("a")).toBe(`A says ${KEY.slice(0, 8)}`);
    expect(streaming.flush("b")).toBe(`B says ${KEY.slice(8)}`);
  });

  it("flush_forgets_the_stream", () => {
    const streaming = createStreamingMasker(() => masker);
    streaming.push("a", "short");

    expect(streaming.flush("a")).toBe("short");
    expect(streaming.flush("a")).toBe("");
  });

  it("flushAll_returns_pending_streams_in_arrival_order", () => {
    const streaming = createStreamingMasker(() => masker);
    streaming.push("second", "two");
    streaming.push("first", "one");
    streaming.push("empty", "");
    streaming.flush("second");
    streaming.push("second", "again");

    expect(streaming.flushAll()).toEqual([
      { key: "first", text: "one" },
      { key: "second", text: "again" },
    ]);
    expect(streaming.flushAll()).toEqual([]);
  });

  it("picks_up_secrets_added_between_deltas", () => {
    let secrets: { value: string; label: string }[] = [];
    const streaming = createStreamingMasker(() => createSecretMasker(secrets));

    const first = streaming.push("m1", "token is ");
    secrets = [{ value: KEY, label: LABEL }];
    const second = streaming.push("m1", `${KEY} done`);

    expect(first + second + streaming.flush("m1")).toBe(
      `token is ${REDACTED} done`,
    );
  });
});
