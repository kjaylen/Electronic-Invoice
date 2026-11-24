// A small client for a Floreo store: the key in the Authorization header, JSON in and out, errors as exceptions.
// Set these in a .env file beside your Vite app (VITE_FLOREO_URL, VITE_FLOREO_STORE, VITE_FLOREO_KEY).
const FLOREO = import.meta.env.VITE_FLOREO_URL ?? 'https://YOUR-FLOREO';
const STORE = import.meta.env.VITE_FLOREO_STORE ?? 'your-store';
const KEY = import.meta.env.VITE_FLOREO_KEY ?? 'pk_test_YOUR_KEY';

export async function floreo(path, { method = 'GET', body, idempotencyKey } = {}) {
  const res = await fetch(`${FLOREO}/v1/store/${STORE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body && { 'Content-Type': 'application/json' }),
      ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
    },
    body: body && JSON.stringify(body),
  });
  const json = await res.json();
  // Every error has the same shape: { error: { code, message } }.
  if (!res.ok) throw Object.assign(new Error(json.error.message), { code: json.error.code, status: res.status });
  return json;
}
