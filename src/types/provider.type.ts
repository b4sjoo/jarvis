export interface TYPE_PROVIDER {
  id?: string;
  name?: string;
  streaming?: boolean;
  responseContentPath?: string;
  isCustom?: boolean;
  curl: string;
}

export interface SelectedAiProviderConfig {
  provider: string;
  variables: Record<string, string>;
}
