import { GatewayConfig, Project } from '../payments/payment.types';

export interface EventRow {
  id: string;
  project_id: string;
  gateway: string;
  event_type: string;
  customer_ref: string;
  gateway_event_id: string;
  payload: unknown;
  processed_at: string;
}

export type NovoEvento = Omit<EventRow, 'id' | 'processed_at'>;

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface DeliveryRow {
  id: string;
  event_id: string;
  project_id: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export type DeliveryPatch = Partial<
  Pick<DeliveryRow, 'status' | 'attempts' | 'next_attempt_at' | 'last_status_code' | 'last_error' | 'delivered_at'>
>;

export interface FailedDeliveryInfo {
  id: string;
  event: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
}

export interface ProjectsRepo {
  findById(id: string): Promise<Project | null>;
  findByApiKey(apiKey: string): Promise<Project | null>;
  findByName(name: string): Promise<Project | null>;
  create(data: { id?: string; name: string; api_key: string; callback_url: string }): Promise<Project>;
  updateCallbackUrl(id: string, callbackUrl: string): Promise<void>;
}

export interface ConfigsRepo {
  /** Config ativa já decifrada. */
  findActive(projectId: string, gateway?: string): Promise<GatewayConfig | null>;
  deactivateAll(projectId: string, gateway: string): Promise<void>;
  /** Recebe o JSON já cifrado. */
  insertEncrypted(projectId: string, gateway: string, encryptedConfig: string): Promise<void>;
}

export interface EventsRepo {
  findByGatewayEventId(gatewayEventId: string): Promise<EventRow | null>;
  getById(id: string): Promise<EventRow | null>;
  /** Devolve null se o gateway_event_id já existir (corrida entre duas entregas do mesmo aviso). */
  insert(row: NovoEvento): Promise<EventRow | null>;
}

export interface DeliveriesRepo {
  create(eventId: string, projectId: string): Promise<DeliveryRow>;
  getById(id: string): Promise<DeliveryRow | null>;
  getByEventId(eventId: string): Promise<DeliveryRow | null>;
  update(id: string, patch: DeliveryPatch): Promise<void>;
  /**
   * Pega até `limit` entregas pending vencidas e marca cada uma (empurra next_attempt_at
   * para `lockUntil`) antes de devolver, para dois ciclos não enviarem a mesma.
   */
  claimDue(limit: number, now: Date, lockUntil: Date): Promise<DeliveryRow[]>;
  listFailed(projectId: string): Promise<FailedDeliveryInfo[]>;
  /** failed -> pending, zera as tentativas. false se não existir, for de outro projeto ou não estiver failed. */
  resetToPending(id: string, projectId: string, now: Date): Promise<boolean>;
}

export interface Repos {
  projects: ProjectsRepo;
  configs: ConfigsRepo;
  events: EventsRepo;
  deliveries: DeliveriesRepo;
}
