// 测试专用注入缝（spec D2 / §4-3）：在**与产品同一接缝**（agent/pre-step）注入冻结卡文本，
// 并把会话事件落成 JSONL 作为 trial 的 tool-event 证据。零外部依赖（不 import dsh 包），
// 因为 trial profile 的 node_modules 里没有 @deepseek-ai/*，而 dsh 只对插件入口做内部解析。
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const name = 'trial-seam';
export const inject = [];

const cardFile = process.env.TRIAL_CARD_FILE;
const evidenceFile = process.env.TRIAL_EVIDENCE_FILE;

function log(entry) {
  if (!evidenceFile) return;
  try {
    appendFileSync(evidenceFile, `${JSON.stringify({ t: Date.now(), ...entry })}\n`, 'utf8');
  } catch {
    /* 证据写入失败不阻塞会话 */
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function apply(ctx) {
  if (!cardFile) throw new Error('TRIAL_CARD_FILE is required');
  const card = readFileSync(cardFile, 'utf8').trimEnd();
  log({ type: 'boot', cardFile, cardChars: card.length });

  let injected = false;

  ctx.on('session/event', (...args) => {
    try {
      const [a, b] = args;
      const pick = (v) => (v && typeof v === 'object' ? Object.keys(v).slice(0, 14) : v === undefined ? null : typeof v);
      const event = b ?? a;
      const session = a?.id && typeof a.id === 'string' ? a : event?.session;
      log({
        type: 'event',
        sessionId: session?.id,
        argCount: args.length,
        arg0Keys: pick(a),
        arg1Keys: pick(b),
        kind: event?.kind ?? event?.type,
        body: typeof event?.body === 'string' ? event.body.slice(0, 20_000) : event?.body,
        meta: event?.meta,
        sample: typeof event === 'object' && event !== null ? JSON.stringify(event).slice(0, 1200) : String(event),
      });
    } catch {
      /* ignore */
    }
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (!injected) {
        injected = true;
        const message = deepFreeze({
          role: 'user',
          id: randomUUID(),
          content: [{ type: 'text', text: card }],
          source: { kind: 'dsh-thread', form: 'instructions' },
        });
        payload.agent.inject(message);
        log({ type: 'inject', sessionId: payload?.agent?.session?.id, turn: payload?.turn, chars: card.length });
      }
    } catch (err) {
      log({ type: 'inject-error', error: String(err) });
    }
    return next();
  });
}
