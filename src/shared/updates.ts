import { z } from "zod";

import { UpdateChannel } from "../domain/types";

import { UPDATER_CONFIG_MESSAGE_TYPE } from "./constants";

export const UpdaterConfigMessageSchema = z.strictObject({
  type: z.literal(UPDATER_CONFIG_MESSAGE_TYPE),
  enabled: z.boolean(),
  channel: z.enum(UpdateChannel),
});
export type UpdaterConfigMessage = z.infer<typeof UpdaterConfigMessageSchema>;

export type UpdaterConfig = Pick<UpdaterConfigMessage, "enabled" | "channel">;
