import { supabase } from '../database/supabase.client';
import { decrypt } from '../crypto/config.crypto';
import { GatewayConfig, Project } from '../payments/payment.types';
import {
  ConfigsRepo,
  DeliveriesRepo,
  DeliveryRow,
  EventRow,
  EventsRepo,
  FailedDeliveryInfo,
  ProjectsRepo,
  Repos,
} from './types';

const db = () => supabase.schema('payments');

const projects: ProjectsRepo = {
  async findById(id) {
    const { data } = await db().from('projects').select('*').eq('id', id).maybeSingle();
    return (data as Project | null) ?? null;
  },
  async findByApiKey(apiKey) {
    const { data } = await db().from('projects').select('*').eq('api_key', apiKey).maybeSingle();
    return (data as Project | null) ?? null;
  },
  async findByName(name) {
    const { data } = await db().from('projects').select('*').eq('name', name).limit(1).maybeSingle();
    return (data as Project | null) ?? null;
  },
  async create(row) {
    const { data, error } = await db().from('projects').insert(row).select('*').single();
    if (error || !data) throw new Error(`Falha ao criar projeto: ${error?.message}`);
    return data as Project;
  },
  async updateCallbackUrl(id, callbackUrl) {
    const { error } = await db().from('projects').update({ callback_url: callbackUrl }).eq('id', id);
    if (error) throw new Error(`Falha ao atualizar projeto: ${error.message}`);
  },
};

const configs: ConfigsRepo = {
  async findActive(projectId, gateway) {
    let query = db().from('payment_configs').select('*').eq('project_id', projectId).eq('is_active', true);
    if (gateway) query = query.eq('gateway', gateway);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return {
      id: data.id as string,
      project_id: data.project_id as string,
      gateway: data.gateway as string,
      config: JSON.parse(decrypt(data.config as string)) as Record<string, string>,
    } satisfies GatewayConfig;
  },
  async deactivateAll(projectId, gateway) {
    const { error } = await db()
      .from('payment_configs')
      .update({ is_active: false })
      .eq('project_id', projectId)
      .eq('gateway', gateway)
      .eq('is_active', true);
    if (error) throw new Error(`Falha ao desativar configs: ${error.message}`);
  },
  async insertEncrypted(projectId, gateway, encryptedConfig) {
    const { error } = await db()
      .from('payment_configs')
      .insert({ project_id: projectId, gateway, is_active: true, config: encryptedConfig });
    if (error) throw new Error(`Falha ao gravar config: ${error.message}`);
  },
};

const events: EventsRepo = {
  async findByGatewayEventId(gatewayEventId) {
    const { data } = await db().from('payment_events').select('*').eq('gateway_event_id', gatewayEventId).maybeSingle();
    return (data as EventRow | null) ?? null;
  },
  async getById(id) {
    const { data } = await db().from('payment_events').select('*').eq('id', id).maybeSingle();
    return (data as EventRow | null) ?? null;
  },
  async insert(row) {
    const { data, error } = await db().from('payment_events').insert(row).select('*').single();
    if (error) {
      if (error.code === '23505') return null; // gateway_event_id repetido
      throw new Error(`Failed to save payment event: ${error.message}`);
    }
    return data as EventRow;
  },
};

const deliveries: DeliveriesRepo = {
  async create(eventId, projectId) {
    const { data, error } = await db()
      .from('callback_deliveries')
      .insert({ event_id: eventId, project_id: projectId })
      .select('*')
      .single();
    if (error || !data) throw new Error(`Failed to create callback delivery: ${error?.message}`);
    return data as DeliveryRow;
  },
  async getById(id) {
    const { data } = await db().from('callback_deliveries').select('*').eq('id', id).maybeSingle();
    return (data as DeliveryRow | null) ?? null;
  },
  async getByEventId(eventId) {
    const { data } = await db().from('callback_deliveries').select('*').eq('event_id', eventId).maybeSingle();
    return (data as DeliveryRow | null) ?? null;
  },
  async update(id, patch) {
    const { error } = await db().from('callback_deliveries').update(patch).eq('id', id);
    if (error) throw new Error(`Failed to update callback delivery: ${error.message}`);
  },
  async claimDue(limit, now, lockUntil) {
    const { data } = await db()
      .from('callback_deliveries')
      .select('*')
      .eq('status', 'pending')
      .lte('next_attempt_at', now.toISOString())
      .order('next_attempt_at', { ascending: true })
      .limit(limit);

    const claimed: DeliveryRow[] = [];
    for (const row of (data ?? []) as DeliveryRow[]) {
      // marca antes de enviar: só quem conseguir o UPDATE condicional leva a entrega
      const { data: updated } = await db()
        .from('callback_deliveries')
        .update({ next_attempt_at: lockUntil.toISOString() })
        .eq('id', row.id)
        .eq('status', 'pending')
        .lte('next_attempt_at', now.toISOString())
        .select('*');
      if (updated && updated.length > 0) claimed.push(updated[0] as DeliveryRow);
    }
    return claimed;
  },
  async listFailed(projectId) {
    const { data } = await db()
      .from('callback_deliveries')
      .select('id, attempts, last_status_code, last_error, created_at, payment_events(event_type)')
      .eq('project_id', projectId)
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(200);

    return ((data ?? []) as unknown as Array<{
      id: string;
      attempts: number;
      last_status_code: number | null;
      last_error: string | null;
      created_at: string;
      payment_events: { event_type: string } | { event_type: string }[] | null;
    }>).map((d): FailedDeliveryInfo => {
      const ev = Array.isArray(d.payment_events) ? d.payment_events[0] : d.payment_events;
      return {
        id: d.id,
        event: ev?.event_type ?? '',
        attempts: d.attempts,
        last_status_code: d.last_status_code,
        last_error: d.last_error,
        created_at: d.created_at,
      };
    });
  },
  async resetToPending(id, projectId, now) {
    const { data } = await db()
      .from('callback_deliveries')
      .update({ status: 'pending', attempts: 0, next_attempt_at: now.toISOString() })
      .eq('id', id)
      .eq('project_id', projectId)
      .eq('status', 'failed')
      .select('id');
    return !!data && data.length > 0;
  },
};

export const supabaseRepos: Repos = { projects, configs, events, deliveries };
