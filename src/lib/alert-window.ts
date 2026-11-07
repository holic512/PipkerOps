import { randomUUID } from "node:crypto";
export type AlertStore = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};
export type AlertEvent = {
  action: "fire" | "recover";
  id: string;
  token: string;
  key: string;
  value: number;
  context: string;
};
// A single rule key keeps updates, de-duplication, and the notification claim atomic.
// Pending events survive a failed database write; stable IDs make its retry idempotent.
const windowScript = `
local raw=redis.call('GET',KEYS[1]); local s=raw and cjson.decode(raw) or {}
local generation=ARGV[1]; local now=tonumber(ARGV[2]); local token=ARGV[6]
if not raw then s={generation=generation,sequence=0};if redis.call('GET',KEYS[3]) then s.fired=true end;redis.call('DEL',KEYS[2],KEYS[3]) end
if s.generation and generation<s.generation then return '' end
if s.generation~=generation then s={generation=generation,sequence=0} end
local function save() redis.call('SET',KEYS[1],cjson.encode(s)) end
if s.pending then
  if s.claimUntil and s.claimUntil>now then return '' end
  s.token=token; s.claimUntil=now+15000; save(); return cjson.encode({action=s.pending,id=s.event,token=token,key=KEYS[1],value=s.value,context=s.context})
end
if s.at and tonumber(ARGV[7])<s.at then return '' end
s.at=tonumber(ARGV[7])
if ARGV[3]=='unknown' then s.since=nil; save(); return '' end
if ARGV[3]=='normal' then
  s.since=nil
  if not s.fired then save(); return '' end
  s.fired=nil; s.pending='recover'
else
  if not s.since then s.since=now end
  if now-s.since<tonumber(ARGV[4])*1000 or s.fired then save(); return '' end
  s.fired=true; s.pending='fire'
end
s.sequence=(s.sequence or 0)+1; s.event=ARGV[5]..':'..generation..':'..s.sequence
s.value=tonumber(ARGV[8]);s.context=ARGV[9];s.token=token; s.claimUntil=now+15000; save()
return cjson.encode({action=s.pending,id=s.event,token=token,key=KEYS[1],value=s.value,context=s.context})
`;
export async function advanceAlert(
  store: AlertStore,
  rule: {
    id: string;
    operator: string;
    threshold: number;
    durationSeconds: number;
    updatedAt?: Date;
  },
  value: number | null,
  now = Date.now(),
  observedAt = now,
  context = "",
): Promise<AlertEvent | null> {
  const state =
    value === null || !Number.isFinite(value)
      ? "unknown"
      : (
            rule.operator === "lt"
              ? value < rule.threshold
              : value > rule.threshold
          )
        ? "breached"
        : "normal";
  const result = await store.eval(windowScript, {
    keys: [
      `pko:alert:${rule.id}:window`,
      `pko:alert:${rule.id}:since`,
      `pko:alert:${rule.id}:fired`,
    ],
    arguments: [
      rule.updatedAt?.toISOString() ?? "legacy",
      String(now),
      state,
      String(rule.durationSeconds),
      rule.id,
      randomUUID(),
      String(observedAt),
      String(value),
      context,
    ],
  });
  return result ? (JSON.parse(String(result)) as AlertEvent) : null;
}
export async function finishAlert(
  store: AlertStore,
  event: AlertEvent,
  success = true,
) {
  return store.eval(
    `local raw=redis.call('GET',KEYS[1]);if not raw then return 0 end;local s=cjson.decode(raw);if s.event~=ARGV[1] or s.token~=ARGV[2] then return 0 end;if ARGV[3]=='1' then s.pending=nil;s.event=nil end;s.token=nil;s.claimUntil=nil;redis.call('SET',KEYS[1],cjson.encode(s));return 1`,
    {
      keys: [event.key],
      arguments: [event.id, event.token, success ? "1" : "0"],
    },
  );
}
export async function clearAlertWindow(store: AlertStore, id: string) {
  // Retire the deleted rule briefly so an in-flight old evaluator cannot
  // recreate a permanent incident after its database row has been removed.
  await store.eval(
    "redis.call('SET',KEYS[1],'{\"generation\":\"~deleted\"}','EX',172800);return redis.call('DEL',KEYS[2],KEYS[3])",
    {
      keys: [
        `pko:alert:${id}:window`,
        `pko:alert:${id}:since`,
        `pko:alert:${id}:fired`,
      ],
      arguments: [],
    },
  );
}
