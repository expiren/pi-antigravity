import { getActiveApiKey } from "../src/auth/accounts.ts";
import { executeAnalyzeFile } from "../src/files/analyze.ts";
import { safeError } from "../src/utils/security.ts";

// Opt-in live test: sends only the explicitly supplied file to Antigravity.
// Example: bun scripts/smoke-analyze-file.ts ./short.wav "Transcribe only the spoken words."
const [path, ...task] = process.argv.slice(2);
const instruction = task.join(" ").trim();
if (!path || !instruction) {
  console.error('Usage: bun scripts/smoke-analyze-file.ts <path> "<instruction>"');
  process.exit(1);
}
try {
  const apiKey = JSON.stringify(await getActiveApiKey());
  const result = await executeAnalyzeFile({ apiKey, cwd: process.cwd(), path, instruction });
  console.log(result.content[0].text);
  console.error(JSON.stringify(result.details, null, 2));
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
