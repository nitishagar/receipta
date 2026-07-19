/**
 * Non-streaming 2xx response whose body carries a TOP-LEVEL `error` object — the gateway
 * soft-fail shape (G4.1). Today `outcomeFromStatus(200) === "success"`, so this records
 * `outcome: "success"`; Phase 4 must flip it to `"error"`.
 */
export const openai2xxBodyError = {
  name: 'openai-2xx-body-error',
  streaming: false,
  body: {
    error: { message: 'upstream model unavailable', type: 'gateway_error', code: 'model_down' },
  },
  headers: { 'content-type': 'application/json', 'x-request-id': 'req-2xx-err-005' },
  expect: {
    request_id: 'req-2xx-err-005',
    outcome: 'error' as const,
  },
} as const;
