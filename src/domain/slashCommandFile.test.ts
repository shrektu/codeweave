import { describe, expect, it } from "vitest";

import { parseSlashCommandFile } from "./slashCommandFile";

describe("slash command files: parsing", () => {
  it("frontmatter_is_optional_and_description_defaults_to_empty", () => {
    expect(parseSlashCommandFile("Review $ARGUMENTS")).toEqual({
      ok: true,
      value: {
        name: null,
        description: "",
        body: "Review $ARGUMENTS",
      },
    });
  });

  it("parses the name, description and trimmed body", () => {
    const markdown = `---
name: review
description: Review the diff
---

Review $ARGUMENTS
`;

    expect(parseSlashCommandFile(markdown)).toEqual({
      ok: true,
      value: {
        name: "review",
        description: "Review the diff",
        body: "Review $ARGUMENTS",
      },
    });
  });

  it("unknown_frontmatter_keys_are_ignored", () => {
    const markdown = `---
description: Review
allowed-tools: Read
---

Body
`;

    expect(parseSlashCommandFile(markdown)).toEqual({
      ok: true,
      value: { name: null, description: "Review", body: "Body" },
    });
  });

  it("invalid_yaml_frontmatter_is_an_error", () => {
    const result = parseSlashCommandFile("---\nname: [broken\n---\n\nBody");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/^Invalid YAML frontmatter: /);
    }
  });

  it("empty_body_is_an_error", () => {
    expect(
      parseSlashCommandFile("---\ndescription: Empty\n---\n   \n"),
    ).toEqual({ ok: false, errors: ["Command body is empty"] });
  });
});
