/**
 * GIA Desktop Service Manager Bridge (Tauri IPC)
 * Provides frontend control and health monitoring over local Python AI and Node.js services.
 */
import { invoke } from '@tauri-apps/api/core';

export interface ServiceStatus {
  name: string;
  status: 'running' | 'stopped' | 'failed' | 'starting';
  port: number;
  pid: number | null;
  is_attached: boolean;
  error?: string;
}

/**
 * Checks if the application is running inside the Tauri native desktop shell.
 */
export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Fetches status of all managed local background services.
 */
export async function getServiceStatuses(): Promise<ServiceStatus[]> {
  if (!isTauriEnvironment()) {
    return [
      { name: 'python_ai_service', status: 'running', port: 8001, pid: null, is_attached: true },
      { name: 'backend_service', status: 'running', port: 5001, pid: null, is_attached: true },
    ];
  }
  try {
    return await invoke<ServiceStatus[]>('get_service_statuses');
  } catch (err: any) {
    console.warn('Failed to query service statuses via Tauri:', err);
    return [];
  }
}

/**
 * Spawns or attaches to required local background services.
 */
export async function startLocalServices(): Promise<ServiceStatus[]> {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke<ServiceStatus[]>('start_local_services');
  } catch (err: any) {
    console.error('Failed to start local services via Tauri:', err);
    throw err;
  }
}

/**
 * Requests clean termination of spawned child processes.
 */
export async function stopLocalServices(): Promise<void> {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('stop_local_services');
  } catch (err: any) {
    console.error('Failed to stop local services via Tauri:', err);
  }
}

/**
 * Restarts a specific service (e.g. 'python_ai_service' or 'backend_service').
 */
export async function restartService(serviceName: string): Promise<ServiceStatus | null> {
  if (!isTauriEnvironment()) return null;
  try {
    return await invoke<ServiceStatus>('restart_service', { serviceName });
  } catch (err: any) {
    console.error(`Failed to restart service ${serviceName}:`, err);
    throw err;
  }
}

