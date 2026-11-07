import { db } from "../db";
import { hashToken } from "../crypto";
import { finishAlert, type AlertEvent, type AlertStore } from "../alert-window";
export async function publishMonitoringAlert(
  client: AlertStore,
  rule: {
    id: string;
    name: string;
    metric: string;
    operator: string;
    threshold: number;
    webhookUrl: string | null;
    updatedAt?: Date;
  },
  event: AlertEvent,
  value: number | null,
  context: string,
) {
  const action = event.action;
  value = event.value;
  context = event.context || context;
  const message = {
    title: action === "recover" ? `${rule.name} 已恢复` : rule.name,
    body:
      action === "recover"
        ? `指标已恢复到规则阈值范围。${context}`
        : `${rule.metric} = ${value}，阈值 ${rule.operator} ${rule.threshold}。${context}`,
    level: action === "recover" ? "success" : "error",
  };
  let notification;
  try {
    notification = await db().$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { updatedAt: Date; enabled: boolean }[]
      >`SELECT "updatedAt",enabled FROM "AlertRule" WHERE id=${rule.id} FOR UPDATE`;
      if (!rows.length) throw new Error("告警规则已删除");
      if (
        !rows[0].enabled ||
        (rule.updatedAt &&
          rows[0].updatedAt.getTime() !== rule.updatedAt.getTime())
      )
        return null;
      return tx.notification.upsert({
        where: { id: event.id },
        create: { id: event.id, alertRuleId: rule.id, ...message },
        update: {},
      });
    });
  } catch (error) {
    await finishAlert(client, event, false);
    throw error;
  }
  if (!notification) {
    await finishAlert(client, event);
    return;
  }

  if (rule.webhookUrl) {
    try {
      const response = await fetch(rule.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...message, id: notification.id }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("webhook status");
      await response.body?.cancel();
    } catch {
      await db().auditEvent.create({
        data: {
          action: "alerts.webhook.failed",
          resourceType: "AlertRule",
          resourceId: rule.id,
          detail: {
            notificationId: notification.id,
            destinationHash: hashToken(rule.webhookUrl),
          },
        },
      });
    }
  }
  await finishAlert(client, event);
}
