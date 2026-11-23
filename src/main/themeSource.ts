import { z } from "zod";

import { Appearance } from "../domain/types";

const AppearanceSchema = z.enum(Appearance);

export function themeSourceOf(value: unknown): Appearance | null {
  const parsed = AppearanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
