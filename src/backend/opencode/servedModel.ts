const PROVIDER_SEPARATOR = "/";

export function servedModelName(
  providerId: string | undefined,
  modelId: string,
): string {
  if (providerId === undefined || providerId === "") {
    return modelId;
  }
  const prefix = `${providerId}${PROVIDER_SEPARATOR}`;
  return modelId.startsWith(prefix) ? modelId : `${prefix}${modelId}`;
}
