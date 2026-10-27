import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./env.js";

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) {
    return supabaseClient;
  }

  if (config.supabase.url && config.supabase.anonKey) {
    supabaseClient = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    return supabaseClient;
  }

  return null;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(config.supabase.url && config.supabase.anonKey);
}
