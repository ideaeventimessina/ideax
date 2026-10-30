// Webhook: quando un lavoro finisce, ideax chiama l'indirizzo indicato dal sistema che l'ha chiesto.
// Il corpo è firmato con HMAC-SHA256 (intestazione X-Ideax-Signature) usando il segreto dei webhook.
import crypto from 'node:crypto';
import { webhookSecret } from './apikeys.js';

const DELAYS = [0, 2000, 10000, 30000];

export function sign(body, secret = webhookSecret()) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export async function deliver(url, event, payload, record = {}) {
  const body = JSON.stringify({ event, created: Math.floor(Date.now() / 1000), data: payload });
  const id = crypto.randomUUID();
  Object.assign(record, { url, status: 'pending', attempts: 0 });
  for (const delay of DELAYS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    record.attempts++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ideax-webhook',
          'X-Ideax-Event': event,
          'X-Ideax-Delivery': id,
          'X-Ideax-Signature': sign(body),
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      record.lastStatus = res.status;
      if (res.ok) {
        record.status = 'delivered';
        return record;
      }
    } catch (err) {
      record.lastError = err.cause?.code || err.message;
    }
  }
  record.status = 'failed';
  return record;
}
