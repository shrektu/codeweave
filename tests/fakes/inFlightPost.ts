import { request } from "node:http";

export interface InFlightOutcome {
  readonly status: number;
  readonly continued: boolean;
}

export interface ExpectingPost {
  readonly url: string;
  readonly body: string;
  readonly token?: string;
  readonly path?: string;
  readonly host?: string;
  readonly onContinue?: () => void;
}

export function postExpectingContinue(
  options: ExpectingPost,
): Promise<InFlightOutcome> {
  const target = new URL(options.url);
  let continued = false;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Content-Length": String(Buffer.byteLength(options.body)),
    Expect: "100-continue",
  };
  if (options.token !== undefined) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.host !== undefined) {
    headers.Host = options.host;
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: options.path ?? target.pathname,
        method: "POST",
        headers,
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, continued });
      },
    );
    req.on("error", reject);
    req.on("continue", () => {
      continued = true;
      options.onContinue?.();
      req.end(options.body);
    });
    req.flushHeaders();
  });
}

export function postRevokedInFlight(
  url: string,
  token: string,
  body: string,
  revoke: () => void,
): Promise<InFlightOutcome> {
  return postExpectingContinue({ url, body, token, onContinue: revoke });
}
