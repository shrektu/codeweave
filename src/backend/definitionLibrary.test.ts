import { join } from "node:path";

import { expect, it } from "vitest";

import { makeTempDir } from "../../tests/fakes/processHelpers";

import { createDefinitionRoots } from "./definitionLibrary";
import { createJsonStore } from "./storage";

it("roots_default_the_library_to_the_data_folder", async () => {
  const userData = await makeTempDir();
  const roots = createDefinitionRoots({
    store: createJsonStore(userData),
    userData,
  });

  expect(await roots("/work/project")).toEqual({
    project: "/work/project",
    library: join(userData, "library"),
  });
});

it("roots_use_the_configured_library_folder", async () => {
  const userData = await makeTempDir();
  const library = await makeTempDir();
  const store = createJsonStore(userData);
  await store.writeSettings({
    ...(await store.readSettings()),
    definitionLibrary: library,
  });
  const roots = createDefinitionRoots({ store, userData });

  expect(await roots("/work/project")).toEqual({
    project: "/work/project",
    library,
  });
});

it("roots_follow_a_library_change_without_restart", async () => {
  const userData = await makeTempDir();
  const first = await makeTempDir();
  const second = await makeTempDir();
  const store = createJsonStore(userData);
  const roots = createDefinitionRoots({ store, userData });
  await store.writeSettings({
    ...(await store.readSettings()),
    definitionLibrary: first,
  });
  const before = await roots("/work");
  await store.writeSettings({
    ...(await store.readSettings()),
    definitionLibrary: second,
  });
  const after = await roots("/work");

  expect([before.library, after.library]).toEqual([first, second]);
});

it("roots_without_cwd_return_null_project", async () => {
  const userData = await makeTempDir();
  const roots = createDefinitionRoots({
    store: createJsonStore(userData),
    userData,
  });

  expect(await roots()).toEqual({
    project: null,
    library: join(userData, "library"),
  });
});
