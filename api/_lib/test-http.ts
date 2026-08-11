import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Handlers in api/ are plain `(req, res) => {}` Vercel Node functions, so
 * integration tests call them directly with these minimal mocks instead
 * of spinning up `vercel dev`.
 */
export function mockReq(opts: {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}): VercelRequest {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    query: opts.query ?? {},
    headers: opts.headers ?? {},
    cookies: opts.cookies ?? {},
  } as unknown as VercelRequest;
}

export interface MockResult {
  status: number;
  body: unknown;
  headers: Record<string, string | string[]>;
}

export function mockRes(): { res: VercelResponse; result: () => MockResult } {
  let statusCode = 200;
  let jsonBody: unknown;
  const headers: Record<string, string | string[]> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      headers[name] = value;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as VercelResponse;
  return { res, result: () => ({ status: statusCode, body: jsonBody, headers }) };
}
