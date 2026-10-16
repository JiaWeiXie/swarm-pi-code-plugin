export const LEGACY_AZURE_PROVIDER_ID = "azure-openai-responses";
export const AZURE_PROVIDER_ID = "azure";

export function canonicalProviderId(id: string): string {
  return id === LEGACY_AZURE_PROVIDER_ID ? AZURE_PROVIDER_ID : id;
}

export function canonicalModelReference(reference: string): string {
  const prefix = `${LEGACY_AZURE_PROVIDER_ID}/`;
  return reference.startsWith(prefix)
    ? `${AZURE_PROVIDER_ID}/${reference.slice(prefix.length)}`
    : reference;
}
