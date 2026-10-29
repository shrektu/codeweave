import { REDACTED } from "./constants";

export type Redactor = (text: string) => string;

export function createRedactor(secrets: readonly string[]): Redactor {
  const known = secrets.filter((secret) => secret !== "");
  return (text) =>
    known.reduce((result, secret) => result.replaceAll(secret, REDACTED), text);
}
