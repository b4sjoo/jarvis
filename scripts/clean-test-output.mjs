import { rm } from "node:fs/promises";

await rm(new URL("../.tmp-tests", import.meta.url), {
  force: true,
  recursive: true,
});
