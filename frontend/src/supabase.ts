import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  '';

export const isRecoveryUrl = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const hash = window.location.hash || '';
    const search = window.location.search || '';
    const href = window.location.href || '';

    if (
      hash.includes('type=recovery') ||
      search.includes('type=recovery') ||
      href.includes('type=recovery')
    ) {
      return true;
    }

    const cleanHash = hash.replace(/^#/, '');
    if (cleanHash) {
      const hashParams = new URLSearchParams(cleanHash);
      if (hashParams.get('type') === 'recovery') return true;
    }

    if (search) {
      const searchParams = new URLSearchParams(search);
      if (searchParams.get('type') === 'recovery') return true;
    }
  } catch (_) {}
  return false;
};

// Global in-memory recovery tracker
let isRecoveryActiveFlag = false;

if (typeof window !== 'undefined') {
  if (isRecoveryUrl()) {
    isRecoveryActiveFlag = true;
    try {
      sessionStorage.setItem('flowpilot_recovery_flow', 'true');
    } catch (_) {}
  } else {
    try {
      if (sessionStorage.getItem('flowpilot_recovery_flow') === 'true') {
        isRecoveryActiveFlag = true;
      }
    } catch (_) {}
  }
}

export const isPasswordRecoveryActive = (): boolean => {
  if (isRecoveryActiveFlag) return true;
  if (isRecoveryUrl()) {
    isRecoveryActiveFlag = true;
    return true;
  }
  if (typeof window !== 'undefined') {
    try {
      if (sessionStorage.getItem('flowpilot_recovery_flow') === 'true') {
        isRecoveryActiveFlag = true;
        return true;
      }
    } catch (_) {}
  }
  return false;
};

export const markRecoveryActive = (): void => {
  isRecoveryActiveFlag = true;
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.setItem('flowpilot_recovery_flow', 'true');
    } catch (_) {}
  }
};

export const clearRecoveryState = (): void => {
  isRecoveryActiveFlag = false;
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem('flowpilot_recovery_flow');
    } catch (_) {}
  }
};

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey
);

// Register early auth listener immediately upon client creation so early PASSWORD_RECOVERY events are never missed
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    markRecoveryActive();
  } else if (event === 'SIGNED_OUT') {
    clearRecoveryState();
  }
});
