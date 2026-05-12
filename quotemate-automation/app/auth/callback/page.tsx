// /auth/callback — handles the redirect after a user clicks the email
// verification link Supabase sends on sign up.
//
// Supabase appends the access_token + refresh_token to the URL hash;
// the browser-side client picks them up automatically because we set
// detectSessionInUrl: true in lib/supabase/client.ts. Once the session
// is live, we resume the onboarding flow with any carry-over params
// that were passed through redirectTo at signUp time.

'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { getBrowserSupabase } from '@/lib/supabase/client'

// Next.js 16 disallows prerendering pages whose default export reads
// useSearchParams() without a Suspense boundary. The callback page MUST
// run client-side (it inspects the URL fragment Supabase appended), so
// the inner component is split out and wrapped here.
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackFallback />}>
      <AuthCallbackInner />
    </Suspense>
  )
}

function CallbackFallback() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <Spinner />
        <h1 className="mt-6 font-extrabold uppercase text-2xl tracking-[-0.02em]">
          Verifying your email…
        </h1>
      </div>
    </main>
  )
}

function AuthCallbackInner() {
  const router = useRouter()
  const params = useSearchParams()
  const [status, setStatus] = useState<'verifying' | 'ok' | 'error'>('verifying')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = getBrowserSupabase()
      try {
        // 1. Wait briefly for the session-from-URL detection to settle
        //    (Supabase reads the hash on construction; this is mainly a
        //    safety check for older link formats that need explicit handling).
        await new Promise((r) => setTimeout(r, 80))

        const { data, error } = await supabase.auth.getSession()
        if (error) throw error
        if (cancelled) return

        if (!data.session) {
          // Try once more in case the hash fragment is still being parsed.
          await new Promise((r) => setTimeout(r, 250))
          const second = await supabase.auth.getSession()
          if (!second.data.session) {
            setStatus('error')
            setError('We couldn’t pick up your sign-in session. Try signing in directly.')
            return
          }
        }

        // 2. Pull the user, decide where to send them next
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          setStatus('error')
          setError('Verified but no user attached — sign in to continue.')
          return
        }

        // 3. If a tenant already exists for this user, the welcome flow is done.
        const { data: tenant } = await supabase
          .from('tenants')
          .select('id, status, business_name')
          .eq('owner_user_id', user.id)
          .maybeSingle()

        // Pull any carry-over fields the signup pre-stuffed into params
        // (business_name, first_name) — Supabase also stashes these on
        // user.user_metadata since we passed them as `options.data`.
        // SMS-initiated signups also carry an `intent` token and the
        // pre-resolved owner_mobile through this same callback.
        const meta = user.user_metadata ?? {}
        const next = new URLSearchParams({
          business_name: String(params.get('business_name') ?? meta.business_name ?? ''),
          owner_first_name: String(params.get('owner_first_name') ?? meta.first_name ?? ''),
          owner_email: user.email ?? '',
          owner_user_id: user.id,
        })
        const intent = params.get('intent') ?? meta.intent_token ?? null
        if (intent) next.set('intent', String(intent))
        const ownerMobile = params.get('owner_mobile') ?? meta.owner_mobile ?? null
        if (ownerMobile) next.set('owner_mobile', String(ownerMobile))

        setStatus('ok')

        if (tenant && tenant.status === 'active') {
          // Already onboarded — straight home.
          router.replace(`/?welcome=${encodeURIComponent(tenant.business_name)}`)
        } else if (tenant) {
          // Tenant row exists but not active — back to wizard to finish.
          router.replace(`/onboard?tenant=${tenant.id}`)
        } else {
          // Fresh user — continue the wizard from step 2.
          router.replace(`/onboard?${next.toString()}`)
        }
      } catch (e: any) {
        if (cancelled) return
        setStatus('error')
        setError(e?.message ?? 'Verification failed')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        {status === 'verifying' && (
          <>
            <Spinner />
            <h1 className="mt-6 font-extrabold uppercase text-2xl tracking-[-0.02em]">
              Verifying your email…
            </h1>
            <p className="mt-3 text-text-sec text-sm">
              One moment. We&rsquo;re finishing your sign-in and routing you to the wizard.
            </p>
          </>
        )}
        {status === 'ok' && (
          <>
            <h1 className="font-extrabold uppercase text-2xl tracking-[-0.02em]">
              <span className="text-accent">Verified.</span> Taking you to the wizard…
            </h1>
          </>
        )}
        {status === 'error' && (
          <>
            <h1 className="font-extrabold uppercase text-2xl tracking-[-0.02em]">
              <span className="text-accent">Hmm.</span> Something went sideways.
            </h1>
            {error && (
              <p className="mt-4 text-text-sec text-sm">{error}</p>
            )}
            <div className="mt-8 flex items-center justify-center gap-3">
              <Link
                href="/signin"
                className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 border border-ink-line bg-transparent hover:bg-ink-card text-text-pri font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors"
              >
                Try again
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  )
}

function Spinner() {
  return (
    <div
      className="inline-block h-8 w-8 border-2 border-ink-line border-t-accent animate-spin"
      aria-label="Loading"
      role="status"
    />
  )
}
