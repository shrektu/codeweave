import { runHook } from "./hookRun";

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text;
}

await runHook({
  readInput: readStdin,
  env: process.env,
  write: (line) => {
    process.stdout.write(line);
  },
});
