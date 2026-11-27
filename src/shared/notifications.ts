import { z } from "zod";

const NonEmptyString = z.string().min(1);

export const NotificationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionId: NonEmptyString }),
  z.strictObject({ kind: z.literal("flowRun"), runId: NonEmptyString }),
]);
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

export const DesktopNotificationSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  target: NotificationTargetSchema,
});
export type DesktopNotification = z.infer<typeof DesktopNotificationSchema>;
