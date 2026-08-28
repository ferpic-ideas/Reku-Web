import webpush from "web-push";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const writeToEnv = process.argv.includes("--write-env");
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const currentEnv = writeToEnv
  ? await readFile(envPath, "utf8").catch(() => "")
  : "";
const alreadyConfigured = [
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_VAPID_SUBJECT",
].every((name) => new RegExp(`^${name}=\\S+$`, "m").test(currentEnv));

if (writeToEnv && alreadyConfigured && !process.argv.includes("--force")) {
  process.stdout.write("Web Push VAPID keys are already configured; no changes made.\n");
  process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
const values = {
  WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
  WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
  WEB_PUSH_VAPID_SUBJECT: "mailto:hola@reku.io",
};

if (writeToEnv) {
  const temporaryPath = `${envPath}.web-push-tmp`;
  let contents = currentEnv;
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, "m");
    contents = pattern.test(contents)
      ? contents.replace(pattern, line)
      : `${contents.trimEnd()}\n${line}\n`;
  }
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, envPath);
  await chmod(envPath, 0o600);
  process.stdout.write("Web Push VAPID keys configured in the local .env.\n");
  process.exit(0);
}

process.stdout.write(
  [
    `WEB_PUSH_VAPID_PUBLIC_KEY=${values.WEB_PUSH_VAPID_PUBLIC_KEY}`,
    `WEB_PUSH_VAPID_PRIVATE_KEY=${values.WEB_PUSH_VAPID_PRIVATE_KEY}`,
    `WEB_PUSH_VAPID_SUBJECT=${values.WEB_PUSH_VAPID_SUBJECT}`,
    "",
  ].join("\n"),
);
