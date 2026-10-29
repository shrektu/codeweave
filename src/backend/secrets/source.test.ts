import { expect, it } from "vitest";

import { createFakeVault } from "../../../tests/fakes/fakeVault";
import { createSecretMasker } from "../../domain/secretMask";
import type { Account } from "../../domain/types";

import { createKeyStore } from "./keyStore";
import { createSecretSource } from "./source";

import { makeTempDir } from "../../../tests/fakes/processHelpers";
import { join } from "node:path";

const KEY = "sk-test-groq-0001";
const OTHER_KEY = "sk-test-groq-0002";
const ACCOUNT: Account = {
  id: "acc-1",
  provider: "opencode",
  label: "Groq main",
  configDir: "/tmp/acc-1",
  order: 0,
  api: {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    baseUrl: null,
    rotation: true,
  },
};

it("retired_key_keeps_the_label_of_a_removed_account", async () => {
  const path = join(await makeTempDir(), "api-keys.json");
  const keyStore = createKeyStore({ path, vault: createFakeVault() });
  const source = createSecretSource(keyStore);
  await keyStore.set(ACCOUNT.id, KEY);
  source([ACCOUNT]);
  await keyStore.set(ACCOUNT.id, OTHER_KEY);
  await keyStore.remove(ACCOUNT.id);

  const masker = createSecretMasker(source([]));

  expect(masker.mask(`old ${KEY} newer ${OTHER_KEY}`)).toBe(
    "old [redacted:Groq main] newer [redacted:Groq main]",
  );
});
