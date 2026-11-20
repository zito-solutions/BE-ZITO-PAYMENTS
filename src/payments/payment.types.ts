export interface Project {
  id: string;
  name: string;
  api_key: string;
  callback_url: string;
  callback_secret: string;
}

export interface GatewayConfig {
  id: string;
  project_id: string;
  gateway: string;
  config: Record<string, string>;
}
