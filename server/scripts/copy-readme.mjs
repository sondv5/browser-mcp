import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootReadme = fileURLToPath(new URL("../../README.md", import.meta.url));
const serverReadme = fileURLToPath(new URL("../README.md", import.meta.url));

copyFileSync(rootReadme, serverReadme);
