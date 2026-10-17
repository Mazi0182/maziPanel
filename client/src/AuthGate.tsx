import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Lock, User, KeyRound, AlertCircle, RefreshCw, Loader2, CheckCircle2 } from 'lucide-react';
import { getStoredToken, clearStoredToken, apiLogout, refreshSession, UserSession } from './auth/authSession';


interface AuthGateProps {
  children: React.ReactNode;
}

export interface AuthContextType {
  user: UserSession | null;
  checkAuth: () => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = React.createContext<AuthContextType>({
  user: null,
  checkAuth: async () => {},
  logout: async () => {},
});

export const useAuth = () => React.useContext(AuthContext);

type AuthStatus = 'loading' | 'setup' | 'login' | 'authenticated' | 'network_error';

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserSession | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [rateLimitCountdown, setRateLimitCountdown] = useState<number | null>(null);

  const checkAuth = useCallback(async () => {
    setError(null);
    setRetryCountdown(null);

    try {
      // 1. Check server setup status
      const statusRes = await fetch('/api/auth/status', { credentials: 'same-origin' });
      if (!statusRes.ok) {
        throw new Error(`Sunucu durum kontrolü başarısız (HTTP ${statusRes.status})`);
      }
      const statusData = await statusRes.json();

      if (!statusData.initialized) {
        setAuthStatus('setup');
        return;
      }

      // 2. Panel is initialized. Verify active HttpOnly cookie session via /api/auth/me
      clearStoredToken();
      const meRes = await fetch('/api/auth/me', {
        credentials: 'same-origin'
      });

      if (meRes.ok) {
        const meData = await meRes.json();
        setUser(meData.user);
        setAuthStatus('authenticated');
        setSessionExpiredNotice(false);
      } else {
        setAuthStatus('login');
      }
    } catch (err: any) {
      console.warn('[AuthGate] Bağlantı veya yetkilendirme hatası:', err.message);
      setAuthStatus('network_error');
      setRetryCountdown(5);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Handle countdown for rate limit lockout on failed attempts
  useEffect(() => {
    if (rateLimitCountdown === null) return;
    if (rateLimitCountdown <= 0) {
      setRateLimitCountdown(null);
      return;
    }
    const timer = setTimeout(() => {
      setRateLimitCountdown((prev) => (prev !== null && prev > 1 ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [rateLimitCountdown]);

  // Handle countdown for automatic retry on network error
  useEffect(() => {
    if (authStatus !== 'network_error' || retryCountdown === null) return;
    if (retryCountdown <= 0) {
      checkAuth();
      return;
    }
    const timer = setTimeout(() => {
      setRetryCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [authStatus, retryCountdown, checkAuth]);

  // Listen to global 401 unauthorized and logout events
  useEffect(() => {
    const handleUnauthorized = () => {
      clearStoredToken();
      window.history.replaceState({ tab: 'servers' }, '', '/servers');
      setUser(null);
      setPassword('');
      setError(null);
      setSessionExpiredNotice(true);
      setAuthStatus('login');
    };

    const handleLogout = () => {
      clearStoredToken();
      window.history.replaceState({ tab: 'servers' }, '', '/servers');
      setUser(null);
      setPassword('');
      setError(null);
      setAuthStatus('login');
      setSessionExpiredNotice(false);
    };

    window.addEventListener('mazipanel:unauthorized', handleUnauthorized);
    window.addEventListener('mazipanel:logout', handleLogout);

    return () => {
      window.removeEventListener('mazipanel:unauthorized', handleUnauthorized);
      window.removeEventListener('mazipanel:logout', handleLogout);
    };
  }, []);

  // Handle visibility change: silent session validation and renewal when returning to tab
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && authStatus === 'authenticated') {
        const refreshedUser = await refreshSession();
        if (refreshedUser) {
          setUser(refreshedUser);
        } else {
          // If refresh failed with 401 or network, verify session status
          checkAuth();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [authStatus, checkAuth]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rateLimitCountdown !== null && rateLimitCountdown > 0) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: username.trim(),
          password
        })
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        const retryAfter = Number(data.retryAfter) || 30;
        setRateLimitCountdown(retryAfter);
        setError(data.error || `Çok fazla başarısız deneme yapıldı. Lütfen ${retryAfter} saniye sonra tekrar deneyin.`);
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || 'Giriş başarısız. Lütfen bilgilerinizi kontrol edin.');
      }

      clearStoredToken();
      window.history.replaceState({ tab: 'servers' }, '', '/servers');
      window.dispatchEvent(new CustomEvent('mazipanel:login'));

      setUser(data.user);
      setPassword('');
      setSessionExpiredNotice(false);
      setRateLimitCountdown(null);
      setAuthStatus('authenticated');
    } catch (err: any) {
      setError(err.message || 'Kimlik doğrulama hatası.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rateLimitCountdown !== null && rateLimitCountdown > 0) return;

    setError(null);

    if (password.length < 6) {
      setError('Şifre en az 6 karakter olmalıdır.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Şifreler birbiriyle eşleşmiyor.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: username.trim(),
          password
        })
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        const retryAfter = Number(data.retryAfter) || 30;
        setRateLimitCountdown(retryAfter);
        setError(data.error || `Çok fazla başarısız deneme yapıldı. Lütfen ${retryAfter} saniye sonra tekrar deneyin.`);
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || 'Kurulum başarısız oldu.');
      }

      clearStoredToken();
      window.history.replaceState({ tab: 'servers' }, '', '/servers');
      window.dispatchEvent(new CustomEvent('mazipanel:login'));

      setUser(data.user);
      setPassword('');
      setConfirmPassword('');
      setRateLimitCountdown(null);
      setAuthStatus('authenticated');
    } catch (err: any) {
      setError(err.message || 'Kurulum hatası.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isSetup = authStatus === 'setup';

  if (authStatus === 'authenticated') {
    return (
      <AuthContext.Provider value={{ user, checkAuth, logout: apiLogout }}>
        {children}
      </AuthContext.Provider>
    );
  }

  return (
    <AuthContext.Provider value={{ user, checkAuth, logout: apiLogout }}>
      <AnimatePresence initial={false}>
        {authStatus === 'loading' ? (
          <motion.div
            key="auth-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="min-h-screen bg-[#0a0b0e] flex items-center justify-center p-4"
          >
            <div className="glass-panel rounded-2xl p-8 max-w-sm w-full text-center flex flex-col items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white">
                <Loader2 className="w-6 h-6 animate-spin text-silver-300" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white tracking-wide">maziPanel</h2>
                <p className="text-xs text-silver-400 mt-1">Oturum güvenliği doğrulanıyor...</p>
              </div>
            </div>
          </motion.div>
        ) : authStatus === 'network_error' ? (
          <motion.div
            key="auth-network-error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="min-h-screen bg-[#0a0b0e] flex items-center justify-center p-4"
          >
            <div className="glass-panel rounded-2xl p-8 max-w-md w-full text-center flex flex-col items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Sunucu Bağlantısı Koptu</h2>
                <p className="text-xs text-silver-400 mt-1">
                  maziPanel arka plan servisiyle iletişim kurulamıyor.
                </p>
              </div>
              {retryCountdown !== null && (
                <p className="text-xs text-silver-500">
                  {retryCountdown} saniye içinde otomatik yeniden denenecek...
                </p>
              )}
              <button
                type="button"
                onClick={checkAuth}
                className="w-full mt-2 py-2 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold flex items-center justify-center gap-2 border border-white/10 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Yeniden Dene
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="auth-form-screen"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="min-h-screen bg-[#0a0b0e] flex items-center justify-center p-4"
          >
            <div className="glass-panel rounded-2xl p-8 max-w-md w-full flex flex-col gap-6 relative overflow-hidden">
              {/* Background ambient lighting */}
              <div className="absolute -top-16 -right-16 w-32 h-32 bg-white/5 rounded-full blur-3xl pointer-events-none" />
              <div className="absolute -bottom-16 -left-16 w-32 h-32 bg-white/5 rounded-full blur-3xl pointer-events-none" />

              {/* Header */}
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white">
                  <Shield className="w-5 h-5 text-silver-300" />
                </div>
                <div>
                  <h1 className="text-lg font-semibold text-white tracking-wide">
                    mazi<span className="text-silver-400">Panel</span>
                  </h1>
                  <p className="text-xs text-silver-400">
                    {isSetup ? 'İlk Yönetici Kurulumu' : 'Yönetici Girişi'}
                  </p>
                </div>
              </div>

              {/* Session Expired Notice */}
              {sessionExpiredNotice && (
                <div className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-start gap-2.5 text-xs text-yellow-300">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Oturum Süresi Doldu</p>
                    <p className="text-yellow-300/80">Oturumunuzun süresi doldu, lütfen tekrar giriş yapın.</p>
                  </div>
                </div>
              )}


              {/* Error message */}
              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2.5 text-xs text-red-300">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p>{error}</p>
                </div>
              )}

              {/* Form */}
              <form onSubmit={isSetup ? handleSetup : handleLogin} className="flex flex-col gap-4">
                <div>
                  <label className="block text-xs font-semibold text-silver-400 mb-1.5 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" />
                    Kullanıcı Adı
                  </label>
                  <input
                    type="text"
                    required
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={isSubmitting}
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs text-white placeholder-silver-600"
                    placeholder="örn. masteradmin"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-silver-400 mb-1.5 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    Şifre
                  </label>
                  <input
                    type="password"
                    required
                    autoComplete={isSetup ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSubmitting}
                    className="glass-input w-full rounded-xl px-3.5 py-2 text-xs text-white placeholder-silver-600"
                    placeholder={isSetup ? 'En az 6 karakter' : 'Şifrenizi girin'}
                  />
                </div>

                {isSetup && (
                  <div>
                    <label className="block text-xs font-semibold text-silver-400 mb-1.5 flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5" />
                      Şifre Tekrar
                    </label>
                    <input
                      type="password"
                      required
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={isSubmitting}
                      className="glass-input w-full rounded-xl px-3.5 py-2 text-xs text-white placeholder-silver-600"
                      placeholder="Şifrenizi tekrar girin"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting || rateLimitCountdown !== null}
                  className="w-full mt-2 py-2.5 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold flex items-center justify-center gap-2 border border-white/15 transition-all shadow-lg shadow-black/40 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {isSetup ? 'Hesap Oluşturuluyor...' : 'Giriş Yapılıyor...'}
                    </>
                  ) : rateLimitCountdown !== null ? (
                    <>
                      <Lock className="w-4 h-4 text-silver-400" />
                      Lütfen Bekleyin ({rateLimitCountdown} sn)
                    </>
                  ) : isSetup ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Kurulumu Tamamla
                    </>
                  ) : (
                    <>
                      <Lock className="w-4 h-4" />
                      Panele Giriş Yap
                    </>
                  )}
                </button>
              </form>
            </div>
          </motion.div>

        )}
      </AnimatePresence>
    </AuthContext.Provider>
  );
};
