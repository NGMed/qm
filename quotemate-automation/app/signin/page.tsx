// /signin — Maintain design system. Returning-tradie login.

'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getBrowserSupabase } from '@/lib/supabase/client'
import { AuthShell, Field, INPUT, ErrorBanner, Arrow } from '../signup/page'

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const supabase = getBrowserSupabase()
      const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      })
      if (authErr) throw authErr
      if (!authData.user) throw new Error('Sign in returned no user')

      const { data: tenant } = await supabase
        .from('tenants')
        .select('id, status, business_name')
        .eq('owner_user_id', authData.user.id)
        .maybeSingle()

      if (!tenant) {
        router.push(`/onboard?owner_user_id=${authData.user.id}`)
        return
      }
      if (tenant.status === 'active') {
        router.push(`/?welcome=${encodeURIComponent(tenant.business_name)}`)
      } else {
        router.push(`/onboard?tenant=${tenant.id}`)
      }
    } catch (err: any) {
      setError(err?.message ?? 'Sign in failed')
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title={<>Welcome <span className="text-accent">back</span></>}
      subtitle="Sign in to manage your pricing, view quotes, and check on your AI receptionist."
      footer={
        <>
          New here?{' '}
          <Link href="/signup" className="text-accent hover:text-accent-press font-semibold">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@business.com.au"
            className={INPUT}
            required
            autoComplete="email"
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT}
            required
            autoComplete="current-password"
          />
        </Field>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full inline-flex items-center justify-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-4 text-sm uppercase tracking-wider transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent-soft focus:ring-offset-2 focus:ring-offset-ink-deep"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
          {!submitting && <Arrow />}
        </button>
      </form>
    </AuthShell>
  )
}
