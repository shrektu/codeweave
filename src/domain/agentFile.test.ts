import { describe, expect, it } from "vitest";

import {
  newAgentFile,
  removeAgentBlock,
  serializeAgentBlock,
  validateAgent,
} from "./agentFile";
import { parseAgentDocuments, type AgentDefinition } from "./flows";

const BLOCK_A = `---
id: alpha
role: First
provider: claude
permissionProfile: plan
---

Body alpha.

`;

const BLOCK_B = `---
id: beta
# keep me
role: Second
provider: codex
model: gpt-5
permissionProfile: ask
taskClass: light
owner: team
---

Body beta.

`;

const BLOCK_C = `---
id: gamma
role: Third
provider: gemini
permissionProfile: bypass
---

Body gamma.
`;

const THREE = `${BLOCK_A}${BLOCK_B}${BLOCK_C}`;

const ALPHA: AgentDefinition = {
  id: "alpha",
  role: "First",
  provider: "claude",
  permissionProfile: "plan",
};

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; errors: string[] },
): T {
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.value;
}

describe("agentFile: serializeAgentBlock", () => {
  it("removes absent optional keys and keeps unknown keys and comments", () => {
    const result = unwrap(
      serializeAgentBlock(
        THREE,
        "beta",
        {
          id: "beta",
          role: "Second",
          provider: "codex",
          permissionProfile: "ask",
        },
        "Body beta.",
      ),
    );

    expect(result).toBe(
      THREE.replace("model: gpt-5\n", "").replace("taskClass: light\n", ""),
    );
  });

  it("adds optional keys that were absent after the existing keys", () => {
    const result = unwrap(
      serializeAgentBlock(
        THREE,
        "alpha",
        { ...ALPHA, model: "opus", taskClass: "heavy" },
        "Body alpha.",
      ),
    );

    expect(result).toBe(
      THREE.replace(
        "permissionProfile: plan\n---\n\nBody alpha.",
        "permissionProfile: plan\nmodel: opus\ntaskClass: heavy\n---\n\nBody alpha.",
      ),
    );
  });

  it("leaves every other block byte-identical", () => {
    const result = unwrap(
      serializeAgentBlock(
        THREE,
        "beta",
        { ...ALPHA, id: "beta", role: "Changed" },
        "New body",
      ),
    );

    expect(result.startsWith(BLOCK_A)).toBe(true);
    expect(result.endsWith(BLOCK_C)).toBe(true);
  });
});

describe("agentFile: serializeAgentBlock edge cases", () => {
  it("separates a replaced body from the next block with a blank line", () => {
    const result = unwrap(
      serializeAgentBlock(THREE, "alpha", ALPHA, "\n  New body \n\n\n"),
    );

    expect(
      result.startsWith(
        "---\nid: alpha\nrole: First\nprovider: claude\npermissionProfile: plan\n---\n\nNew body\n\n---\nid: beta\n",
      ),
    ).toBe(true);
  });

  it("writes an empty body as an empty instruction block", () => {
    const result = unwrap(serializeAgentBlock(BLOCK_C, "gamma", ALPHA, ""));

    expect(unwrap(parseAgentDocuments(result))).toEqual([
      { definition: ALPHA, body: "" },
    ]);
  });

  it("inlines an alias of a managed key used by an unmanaged key", () => {
    const original = `---
id: alpha
role: &shared Does things
provider: claude
permissionProfile: plan
notes: *shared
---

Body.
`;

    const result = unwrap(
      serializeAgentBlock(
        original,
        "alpha",
        { ...ALPHA, role: "Does other things" },
        "Body.",
      ),
    );

    expect(result).toContain("notes: Does things");
    expect(result).toContain("role: &shared Does other things");
    expect(result).not.toContain("*shared");
  });
});

describe("agentFile: serializeAgentBlock errors", () => {
  it("reports an unknown agent id", () => {
    const result = serializeAgentBlock(THREE, "missing", ALPHA, "x");

    expect(result).toEqual({
      ok: false,
      errors: ['Agent "missing" not found in the file'],
    });
  });

  it("reports an id that appears twice in the file", () => {
    const result = serializeAgentBlock(
      `${BLOCK_A}${BLOCK_A}`,
      "alpha",
      ALPHA,
      "x",
    );

    expect(result).toEqual({
      ok: false,
      errors: ['Agent id "alpha" appears 2 times in the file'],
    });
  });

  it("reports a file whose front matter cannot be parsed", () => {
    const result = serializeAgentBlock("no front matter", "alpha", ALPHA, "x");

    expect(result).toEqual({
      ok: false,
      errors: ["Missing YAML frontmatter"],
    });
  });
});

describe("agentFile: removeAgentBlock", () => {
  it("removes the first block and keeps the rest identical", () => {
    expect(unwrap(removeAgentBlock(THREE, "alpha"))).toBe(
      `${BLOCK_B}${BLOCK_C}`,
    );
  });

  it("removes a middle block and keeps the rest identical", () => {
    expect(unwrap(removeAgentBlock(THREE, "beta"))).toBe(
      `${BLOCK_A}${BLOCK_C}`,
    );
  });

  it("removes the last block and keeps the rest identical", () => {
    expect(unwrap(removeAgentBlock(THREE, "gamma"))).toBe(
      `${BLOCK_A}${BLOCK_B}`,
    );
  });

  it("returns null when the only block is removed", () => {
    expect(unwrap(removeAgentBlock(BLOCK_C, "gamma"))).toBeNull();
  });

  it("reports an unknown agent id", () => {
    expect(removeAgentBlock(THREE, "missing")).toEqual({
      ok: false,
      errors: ['Agent "missing" not found in the file'],
    });
  });
});

describe("agentFile: newAgentFile", () => {
  it("writes keys in managed order and omits absent optional keys", () => {
    expect(newAgentFile(ALPHA, "  Body.\n\n")).toBe(
      "---\nid: alpha\nrole: First\nprovider: claude\npermissionProfile: plan\n---\n\nBody.\n",
    );
  });

  it("round-trips every field through the parser", () => {
    const definition: AgentDefinition = {
      id: "tricky",
      role: "Writes: code # not a comment",
      provider: "opencode",
      model: "anthropic/claude: x",
      permissionProfile: "accept-edits",
      taskClass: "standard",
    };

    expect(
      unwrap(parseAgentDocuments(newAgentFile(definition, "Do it.\nTwice."))),
    ).toEqual([{ definition, body: "Do it.\nTwice." }]);
  });

  it("does not fold a long role onto several lines", () => {
    const role = "word ".repeat(40).trim();

    const text = newAgentFile({ ...ALPHA, role }, "Body.");

    expect(text).toContain(`role: ${role}\n`);
  });
});

describe("agentFile: validateAgent", () => {
  it.each(["a", "A1", "a-b_c", "9lives", "x".repeat(64)])(
    "accepts id %s",
    (id) => {
      expect(validateAgent({ ...ALPHA, id }, "Body", [])).toEqual([]);
    },
  );

  it.each(["", "-x", "_x", "a b", "a/b", "a.b", "..", "a\\b", "é", "a\n"])(
    "rejects id %j",
    (id) => {
      expect(validateAgent({ ...ALPHA, id }, "Body", [])).toEqual([
        "Agent id must start with a letter or digit and contain only letters, digits, _ and -",
      ]);
    },
  );

  it("rejects an id equal to another agent ignoring case", () => {
    expect(
      validateAgent({ ...ALPHA, id: "Alpha" }, "Body", ["beta", "ALPHA"]),
    ).toEqual(['Agent id "Alpha" is already used by another agent']);
  });

  it("accepts an id that only resembles another agent id", () => {
    expect(
      validateAgent({ ...ALPHA, id: "alpha2" }, "Body", ["alpha"]),
    ).toEqual([]);
  });

  it.each(["", "   ", "\t\n"])("rejects blank role %j", (role) => {
    expect(validateAgent({ ...ALPHA, role }, "Body", [])).toEqual([
      "Role must not be blank",
    ]);
  });

  it("rejects a blank model when present", () => {
    expect(validateAgent({ ...ALPHA, model: " " }, "Body", [])).toEqual([
      "Model must not be blank when set",
    ]);
  });

  it.each([
    "a\n---\nb",
    "---",
    "a\r\n---\r\nb",
    "---\r\n",
    "a\r---\rb",
    "a ---",
  ])("rejects a body with a fence line %j", (body) => {
    expect(validateAgent(ALPHA, body, [])).toEqual([
      'Instructions must not contain a line that is exactly "---"',
    ]);
  });

  it.each(["a --- b", "--- ", "----", " ---", "a\n--\nb", ""])(
    "accepts a body without a fence line %j",
    (body) => {
      expect(validateAgent(ALPHA, body, [])).toEqual([]);
    },
  );
});
