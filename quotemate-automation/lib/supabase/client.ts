// Browser-side Supabase client for client components.
//
// Uses the public anon key (safe to ship to the browser — Row Level
// Security policies on the database enforce who can read/write what).
// For server-side privileged operations (signing up users, writing
// across tenants), the API routes continue to use SUPABASE_SERVICE_ROLE_KEY
// directly via @supabase/supabase-js's createClient.

'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

export function getBrowserSupabase(): SupabaseClient {
  if (_client) return _client
  _client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  )
  return _client
}
